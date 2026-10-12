import "server-only";
import { and, desc, eq } from "drizzle-orm";

import type { RouteDecision } from "@/shared/types";
import type { Ctx } from "./context";
import { routingCorrections } from "./db/schema";
import { laneBriefs, nextColor } from "./lanes";
import { LlmUnavailableError, routeQuery, type RouterOutput } from "./llm";

export const AUTO_ROUTE_THRESHOLD = 0.7;

/**
 * Turns the model's answer into what the UI shows: a confident lane, a short
 * list to pick from, or a new-lane proposal that waits for confirmation.
 */
export function decide(out: RouterOutput, laneIds: string[], color: string, threshold = AUTO_ROUTE_THRESHOLD): RouteDecision {
  const known = new Set(laneIds);
  const alternates = [...new Set(out.alternates.filter((id) => known.has(id) && id !== out.laneId))].slice(0, 2);

  if (out.action === "assign" && out.laneId && known.has(out.laneId)) {
    const autoRouted = out.confidence >= threshold;
    return { kind: "assign", laneId: out.laneId, confidence: out.confidence, alternates, autoRouted };
  }
  if (out.action === "create" && out.newLane?.name.trim()) {
    return {
      kind: "create",
      newLane: { name: out.newLane.name.trim().slice(0, 40), description: out.newLane.description.trim().slice(0, 300), color },
      confidence: out.confidence,
      alternates,
    };
  }
  return { kind: "ask", reason: "The router could not pick a lane.", alternates };
}

const memo = new Map<string, { at: number; decision: RouteDecision }>();
const MEMO_MS = 10 * 60 * 1000;

export async function routeSearch(c: Ctx, userId: string, query: string): Promise<RouteDecision> {
  const lanes = laneBriefs(c.db, userId);
  if (lanes.length === 0) {
    return { kind: "ask", reason: "Create a lane first.", alternates: [] };
  }
  const corrections = c.db
    .select({ query: routingCorrections.query, laneId: routingCorrections.laneId })
    .from(routingCorrections)
    .where(eq(routingCorrections.userId, userId))
    .orderBy(desc(routingCorrections.createdAt))
    .limit(20)
    .all();

  const key = JSON.stringify([userId, query.trim().toLowerCase(), lanes.map((l) => `${l.id}:${l.name}:${l.description}`), corrections.length]);
  const hit = memo.get(key);
  if (hit && c.now() - hit.at < MEMO_MS) return hit.decision;

  try {
    const out = await routeQuery(c.llm.client, c.llm.model, {
      query,
      lanes: lanes.map(({ id, name, description }) => ({ id, name, description })),
      corrections,
    });
    const decision = decide(out, lanes.map((l) => l.id), nextColor(c.db, userId));
    memo.set(key, { at: c.now(), decision });
    return decision;
  } catch (err) {
    if (err instanceof LlmUnavailableError) {
      return { kind: "ask", reason: "Routing is unavailable right now; pick a lane.", alternates: [] };
    }
    throw err;
  }
}

/** The user moved a search to another lane: remember it as an example for the router. */
export function recordCorrection(c: Ctx, userId: string, query: string, laneId: string): void {
  const q = query.trim().slice(0, 200);
  c.db.delete(routingCorrections).where(and(eq(routingCorrections.userId, userId), eq(routingCorrections.query, q))).run();
  c.db.insert(routingCorrections).values({ userId, query: q, laneId }).run();
}
