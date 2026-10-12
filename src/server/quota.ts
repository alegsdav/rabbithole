import "server-only";
import { and, eq, sql } from "drizzle-orm";

import type { Db } from "./db/client";
import { quotaLog } from "./db/schema";

/** YouTube Data API v3 cost per call, in quota units. */
export const UNIT_COST = {
  "subscriptions.list": 1,
  "channels.list": 1,
  "playlistItems.list": 1,
  "videos.list": 1,
  "search.list": 100,
} as const;

export type YtMethod = keyof typeof UNIT_COST;

export class QuotaError extends Error {
  constructor(
    readonly needed: number,
    readonly remaining: number,
  ) {
    super(`YouTube quota too low: need ${needed} units, ${remaining} left today`);
    this.name = "QuotaError";
  }
}

export type QuotaLimits = { daily: number; reserve: number };

/** The quota day as YouTube counts it: the calendar date in Pacific time. */
export function quotaDay(at: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(at);
}

export function usedToday(db: Db, at: Date = new Date()): number {
  const row = db
    .select({ total: sql<number>`coalesce(sum(${quotaLog.units}), 0)` })
    .from(quotaLog)
    .where(eq(quotaLog.day, quotaDay(at)))
    .get();
  return Number(row?.total ?? 0);
}

/**
 * Reserves units before a call is made, atomically with the check, so two
 * concurrent refreshes can never push the day past the limit. Background work
 * (`interactive: false`) may not dip into the reserve kept for searches.
 */
export function reserveUnits(
  db: Db,
  limits: QuotaLimits,
  call: { method: YtMethod; userId?: string; purpose?: string; interactive?: boolean; calls?: number },
  at: Date = new Date(),
): void {
  const units = UNIT_COST[call.method] * (call.calls ?? 1);
  const ceiling = call.interactive ? limits.daily : limits.daily - limits.reserve;
  db.transaction((tx) => {
    const used = usedToday(tx as unknown as Db, at);
    if (used + units > ceiling) throw new QuotaError(units, Math.max(0, ceiling - used));
    tx.insert(quotaLog)
      .values({ day: quotaDay(at), userId: call.userId ?? null, method: call.method, units, purpose: call.purpose ?? "" })
      .run();
  });
}

/** Whether `units` more could be spent now without touching the reserve. */
export function canSpend(db: Db, limits: QuotaLimits, units: number, interactive = false): boolean {
  const ceiling = interactive ? limits.daily : limits.daily - limits.reserve;
  return usedToday(db) + units <= ceiling;
}

export function quotaSummary(db: Db, limits: QuotaLimits) {
  const used = usedToday(db);
  const byMethod = db
    .select({ method: quotaLog.method, units: sql<number>`sum(${quotaLog.units})`, calls: sql<number>`count(*)` })
    .from(quotaLog)
    .where(eq(quotaLog.day, quotaDay()))
    .groupBy(quotaLog.method)
    .all();
  return { day: quotaDay(), used, daily: limits.daily, reserve: limits.reserve, remaining: Math.max(0, limits.daily - used), byMethod };
}

/** Units one purpose (e.g. a lane refresh) cost today, for measurement. */
export function unitsForPurpose(db: Db, purpose: string): number {
  const row = db
    .select({ total: sql<number>`coalesce(sum(${quotaLog.units}), 0)` })
    .from(quotaLog)
    .where(and(eq(quotaLog.day, quotaDay()), eq(quotaLog.purpose, purpose)))
    .get();
  return Number(row?.total ?? 0);
}
