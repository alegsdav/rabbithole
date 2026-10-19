import "server-only";
import { ApiError, GoogleGenAI } from "@google/genai";
import { z } from "zod";

/**
 * Every LLM call in the app. Each sends only what its task needs:
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

/** rpm: requests per minute to stay under (GEMINI_RPM); unset means no client-side limit. */
export type LlmConfig = { apiKey?: string; model?: string; rpm?: number };

/**
 * The one operation the app needs: JSON that matches a schema. Tests pass a fake.
 * maxWaitMs caps how long a call may queue for a rate-limit slot before giving up.
 */
export type LlmClient = {
  generateJson: (args: { system: string; user: string; schema: unknown; maxTokens: number; maxWaitMs?: number }) => Promise<unknown>;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Sliding one-minute window: waits for a free slot, or throws if that would take longer than maxWaitMs. */
export function rateLimiter(rpm: number | undefined, now: () => number = Date.now, wait: (ms: number) => Promise<unknown> = sleep) {
  const sent: number[] = [];
  return async function acquire(maxWaitMs = Infinity): Promise<void> {
    if (!rpm) return;
    for (;;) {
      const t = now();
      while (sent.length && t - sent[0]! >= 60_000) sent.shift();
      if (sent.length < rpm) {
        sent.push(t);
        return;
      }
      const delay = sent[0]! + 60_000 - t;
      if (delay > maxWaitMs) throw new LlmUnavailableError(`Gemini rate limit (${rpm}/min) reached; try again in ${Math.ceil(delay / 1000)}s`);
      await wait(delay);
    }
  };
}

/** Gemini, with the model chosen by GEMINI_MODEL (never hard-coded). */
export function makeClient(config: LlmConfig): LlmClient {
  const acquire = rateLimiter(config.rpm);
  return {
    async generateJson({ system, user, schema, maxTokens, maxWaitMs }) {
      if (!config.apiKey) throw new LlmUnavailableError("GEMINI_API_KEY is not set");
      if (!config.model) throw new LlmUnavailableError("GEMINI_MODEL is not set");
      await acquire(maxWaitMs);
      // Bounded retries on 500/503 (Gemini under load). Not 429: a quick retry can't clear a
      // per-minute window and spends another request against it.
      const ai = new GoogleGenAI({
        apiKey: config.apiKey,
        httpOptions: { timeout: 20_000, retryOptions: { attempts: 3, initialDelay: 1, maxDelay: 4, httpStatusCodes: [500, 503] } },
      });
      try {
        const res = await ai.models.generateContent({
          model: config.model,
          contents: user,
          config: { systemInstruction: system, responseMimeType: "application/json", responseJsonSchema: schema, maxOutputTokens: maxTokens },
        });
        const text = res.text;
        if (!text) throw new LlmUnavailableError("Gemini returned no output");
        return JSON.parse(text);
      } catch (err) {
        if (err instanceof ApiError) throw new LlmUnavailableError(describeApiError(err));
        throw err;
      }
    },
  };
}

/** One readable line instead of the raw JSON error body. */
function describeApiError(err: ApiError): string {
  if (err.status === 429) return "Gemini rate limit or quota exceeded (429); set GEMINI_RPM to stay under it";
  if (err.status === 503) return "Gemini is overloaded (503); try again shortly";
  if (err.status === 504) return "Gemini timed out (504)";
  return `Gemini error ${err.status}`;
}

async function structured<T extends z.ZodType>(
  client: LlmClient,
  schema: T,
  system: string,
  user: string,
  maxTokens = 2048,
  maxWaitMs?: number,
): Promise<z.infer<T>> {
  let raw: unknown;
  try {
    raw = await client.generateJson({ system, user, schema: z.toJSONSchema(schema), maxTokens, maxWaitMs });
  } catch (err) {
    if (err instanceof LlmUnavailableError) throw err;
    throw new LlmUnavailableError(err instanceof Error ? err.message : String(err));
  }
  const checked = schema.safeParse(raw);
  if (!checked.success) throw new LlmUnavailableError("The model returned output that failed validation");
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

/** maxWaitMs: a search falls back to the lane picker rather than queue long for a rate-limit slot. */
export async function routeQuery(
  client: LlmClient,
  input: { query: string; lanes: LaneBrief[]; corrections: Correction[] },
  maxWaitMs = 3_000,
): Promise<RouterOutput> {
  const lanes = input.lanes.map((l) => ({ id: l.id, name: l.name, description: l.description }));
  const corrections = input.corrections.slice(0, 20).map((c) => ({ query: c.query, laneId: c.laneId }));
  const user = JSON.stringify({ lanes, pastCorrections: corrections, query: input.query });
  const out = await structured(client, routerOutput, ROUTER_SYSTEM, user, 1024, maxWaitMs);
  return { ...out, confidence: Math.min(1, Math.max(0, out.confidence)) };
}

// ---------------------------------------------------------------- setup and classification

export type ChannelBrief = { channelId: string; title: string; description: string };

const proposeOutput = z.object({
  lanes: z.array(z.object({ name: z.string(), description: z.string() })),
});

export async function proposeLanes(client: LlmClient, channels: ChannelBrief[]): Promise<{ name: string; description: string }[]> {
  const brief = channels.map((c) => `${c.title}: ${c.description.replace(/\s+/g, " ").slice(0, 120)}`).join("\n");
  const system = `You group a person's YouTube subscriptions into interest lanes for a home screen that shows each interest separately. Propose 4 to 10 lanes that together cover most channels. Each lane: a short name (1-3 words, Title Case) and a one-sentence description of the interest it covers. Make lanes distinct; merge small niches into a broader lane rather than creating one-channel lanes.`;
  const out = await structured(client, proposeOutput, system, `Subscriptions (title: description):\n${brief}`, 2048);
  return out.lanes.slice(0, 10);
}

const classifyOutput = z.object({
  assignments: z.array(z.object({ channelId: z.string(), laneId: z.string().nullable() })),
});

/** Assigns channels to lanes in batches; channels it cannot place stay unassigned (null). */
export async function classifyChannels(
  client: LlmClient,
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
    const out = await structured(client, classifyOutput, system, user, 4096);
    for (const a of out.assignments) {
      if (batch.some((c) => c.channelId === a.channelId)) result.set(a.channelId, a.laneId && laneIds.has(a.laneId) ? a.laneId : null);
    }
  }
  return result;
}

const queriesOutput = z.object({ queries: z.array(z.string()) });

/** A few YouTube search queries that find fresh videos for a lane beyond its subscriptions. */
export async function writeLaneQueries(client: LlmClient, lane: LaneBrief, sampleTitles: string[], count = 2): Promise<string[]> {
  const system = `You write YouTube search queries that surface good recent videos for one interest. Write ${count} distinct, specific queries (2-6 words each) a person deep into this interest would search. No quotes or operators.`;
  const user = JSON.stringify({ lane: { name: lane.name, description: lane.description }, recentVideoTitles: sampleTitles.slice(0, 15) });
  const out = await structured(client, queriesOutput, system, user, 512);
  return out.queries.map((q) => q.trim()).filter(Boolean).slice(0, count);
}
