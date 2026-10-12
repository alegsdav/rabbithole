import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";

/**
 * Every call to Claude in the app. Each sends only what its task needs:
 * routing sends the query plus lane ids, names and descriptions; channel
 * classification sends channel titles and descriptions. Never tokens,
 * cookies, history or account details.
 */

export class LlmUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LlmUnavailableError";
  }
}

export type LlmConfig = { apiKey?: string; model: string };

/** The minimal surface used here, so tests can pass a fake. */
export type LlmClient = Pick<Anthropic["beta"]["messages"], "parse">;

export function makeClient(config: LlmConfig): LlmClient {
  // With no key in the server env the SDK still resolves ANTHROPIC_AUTH_TOKEN or a CLI profile.
  return new Anthropic(config.apiKey ? { apiKey: config.apiKey } : {}).beta.messages;
}

async function structured<T extends z.ZodType>(
  client: LlmClient,
  model: string,
  schema: T,
  system: string,
  user: string,
  maxTokens = 2048,
): Promise<z.infer<T>> {
  let response;
  try {
    response = await client.parse({
      model,
      max_tokens: maxTokens,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: "low", format: betaZodOutputFormat(schema) },
      system,
      messages: [{ role: "user", content: user }],
    });
  } catch (err) {
    if (err instanceof Anthropic.APIError) throw new LlmUnavailableError(`Claude API error ${err.status ?? ""}: ${err.message}`);
    throw new LlmUnavailableError(err instanceof Error ? err.message : String(err));
  }
  if (response.stop_reason === "refusal") throw new LlmUnavailableError("Claude declined this request");
  const checked = schema.safeParse(response.parsed_output);
  if (!checked.success) throw new LlmUnavailableError("Claude returned output that failed validation");
  return checked.data;
}

// ---------------------------------------------------------------- routing

export const routerOutput = z.object({
  action: z.enum(["assign", "create"]),
  laneId: z.string().nullable(),
  newLane: z.object({ name: z.string(), description: z.string() }).nullable(),
  confidence: z.number(),
  alternates: z.array(z.string()),
});
export type RouterOutput = z.infer<typeof routerOutput>;

export type LaneBrief = { id: string; name: string; description: string };
export type Correction = { query: string; laneId: string };

const ROUTER_SYSTEM = `You file YouTube searches into the user's interest lanes. Each lane is a separate feed, so a search filed into a lane teaches that lane.

Return one decision:
- "assign": the query belongs to an existing lane. Set laneId to that lane's id, newLane to null.
- "create": no existing lane is a reasonable fit. Set laneId to null and propose newLane with a short name (1-3 words, Title Case) and a one-sentence description of the interest.

Prefer existing lanes: a lane covers its whole topic area, including adjacent sub-topics, so only propose a new lane when the query is clearly outside every lane. confidence is your probability (0 to 1) that the decision is the one the user wants. alternates lists up to two other plausible lane ids, best first, never the chosen one. Use only lane ids that appear in the list. Past corrections from this user show where they want similar queries filed; follow them.`;

export async function routeQuery(
  client: LlmClient,
  model: string,
  input: { query: string; lanes: LaneBrief[]; corrections: Correction[] },
): Promise<RouterOutput> {
  const lanes = input.lanes.map((l) => ({ id: l.id, name: l.name, description: l.description }));
  const corrections = input.corrections.slice(0, 20).map((c) => ({ query: c.query, laneId: c.laneId }));
  const user = JSON.stringify({ lanes, pastCorrections: corrections, query: input.query });
  const out = await structured(client, model, routerOutput, ROUTER_SYSTEM, user, 1024);
  return { ...out, confidence: Math.min(1, Math.max(0, out.confidence)) };
}

// ---------------------------------------------------------------- setup and classification

export type ChannelBrief = { channelId: string; title: string; description: string };

const proposeOutput = z.object({
  lanes: z.array(z.object({ name: z.string(), description: z.string() })),
});

export async function proposeLanes(client: LlmClient, model: string, channels: ChannelBrief[]): Promise<{ name: string; description: string }[]> {
  const brief = channels.map((c) => `${c.title}: ${c.description.replace(/\s+/g, " ").slice(0, 120)}`).join("\n");
  const system = `You group a person's YouTube subscriptions into interest lanes for a home screen that shows each interest separately. Propose 4 to 10 lanes that together cover most channels. Each lane: a short name (1-3 words, Title Case) and a one-sentence description of the interest it covers. Make lanes distinct; merge small niches into a broader lane rather than creating one-channel lanes.`;
  const out = await structured(client, model, proposeOutput, system, `Subscriptions (title: description):\n${brief}`, 2048);
  return out.lanes.slice(0, 10);
}

const classifyOutput = z.object({
  assignments: z.array(z.object({ channelId: z.string(), laneId: z.string().nullable() })),
});

/** Assigns channels to lanes in batches; channels it cannot place stay unassigned (null). */
export async function classifyChannels(
  client: LlmClient,
  model: string,
  lanes: LaneBrief[],
  channels: ChannelBrief[],
  batchSize = 60,
): Promise<Map<string, string | null>> {
  const system = `You assign YouTube channels to the user's interest lanes, judging each channel from its title and description. Give every channel exactly one entry. Use laneId null only when the channel fits no lane at all. Use only lane ids from the list.`;
  const laneIds = new Set(lanes.map((l) => l.id));
  const result = new Map<string, string | null>();
  for (let i = 0; i < channels.length; i += batchSize) {
    const batch = channels.slice(i, i + batchSize);
    const user = JSON.stringify({
      lanes: lanes.map((l) => ({ id: l.id, name: l.name, description: l.description })),
      channels: batch.map((c) => ({ channelId: c.channelId, title: c.title, description: c.description.replace(/\s+/g, " ").slice(0, 200) })),
    });
    const out = await structured(client, model, classifyOutput, system, user, 4096);
    for (const a of out.assignments) {
      if (batch.some((c) => c.channelId === a.channelId)) result.set(a.channelId, a.laneId && laneIds.has(a.laneId) ? a.laneId : null);
    }
  }
  return result;
}

const queriesOutput = z.object({ queries: z.array(z.string()) });

/** A few YouTube search queries that find fresh videos for a lane beyond its subscriptions. */
export async function writeLaneQueries(client: LlmClient, model: string, lane: LaneBrief, sampleTitles: string[], count = 2): Promise<string[]> {
  const system = `You write YouTube search queries that surface good recent videos for one interest. Write ${count} distinct, specific queries (2-6 words each) a person deep into this interest would search. No quotes or operators.`;
  const user = JSON.stringify({ lane: { name: lane.name, description: lane.description }, recentVideoTitles: sampleTitles.slice(0, 15) });
  const out = await structured(client, model, queriesOutput, system, user, 512);
  return out.queries.map((q) => q.trim()).filter(Boolean).slice(0, count);
}
