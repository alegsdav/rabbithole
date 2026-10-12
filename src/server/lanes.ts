import "server-only";
import { and, asc, desc, eq, inArray, isNull, ne, sql } from "drizzle-orm";

import { LANE_COLORS, PAGE_SIZE, STALE_AFTER_MS, type LaneSummary, type VideoCard } from "@/shared/types";
import type { Ctx } from "./context";
import type { Db } from "./db/client";
import { channelLanes, feedItems, lanes, searchCache, signals, users } from "./db/schema";
import { classifyChannels, proposeLanes, writeLaneQueries, LlmUnavailableError } from "./llm";
import { QuotaError, UNIT_COST, canSpend, unitsForPurpose } from "./quota";
import { isShort, rankLanes, type Candidate, type ChannelAffinity, type RankContext, type VideoSignals } from "./ranker";

/** Most channels whose uploads one refresh reads (1 unit each). */
const MAX_CHANNELS_PER_REFRESH = 40;
const UPLOADS_PER_CHANNEL = 8;
/** search.list runs per lane per refresh at most; results are reused for 24 hours. */
const MAX_SEARCHES_PER_REFRESH = 2;
const LANE_SEARCH_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_ITEMS_PER_LANE = 150;

export type Settings = { hideShorts: boolean };

export function getSettings(db: Db, userId: string): Settings {
  const row = db.select({ settings: users.settings }).from(users).where(eq(users.id, userId)).get();
  try {
    const parsed = JSON.parse(row?.settings ?? "{}") as Partial<Settings>;
    return { hideShorts: parsed.hideShorts ?? true };
  } catch {
    return { hideShorts: true };
  }
}

export function setSettings(db: Db, userId: string, next: Settings): void {
  db.update(users).set({ settings: JSON.stringify(next) }).where(eq(users.id, userId)).run();
}

function toCard(row: typeof feedItems.$inferSelect): VideoCard {
  return {
    videoId: row.videoId,
    title: row.title,
    channelId: row.channelId,
    channelTitle: row.channelTitle,
    thumbUrl: row.thumbUrl,
    publishedAt: row.publishedAt,
    durationSec: row.durationSec,
    viewCount: row.viewCount,
    isLive: row.isLive,
  };
}

// ---------------------------------------------------------------- reading (always from cache)

export function laneItems(db: Db, userId: string, laneId: string, offset = 0, limit = PAGE_SIZE, hideShorts = true): { items: VideoCard[]; hasMore: boolean } {
  const rows = db
    .select()
    .from(feedItems)
    .where(
      and(
        eq(feedItems.userId, userId),
        eq(feedItems.laneId, laneId),
        hideShorts ? sql`(${feedItems.durationSec} is null or ${feedItems.durationSec} >= 60 or ${feedItems.isLive} = 1)` : undefined,
      ),
    )
    .orderBy(desc(feedItems.score))
    .limit(limit + 1)
    .offset(offset)
    .all();
  return { items: rows.slice(0, limit).map(toCard), hasMore: rows.length > limit };
}

export function listLanes(db: Db, userId: string, now = Date.now()): LaneSummary[] {
  const { hideShorts } = getSettings(db, userId);
  const rows = db.select().from(lanes).where(eq(lanes.userId, userId)).orderBy(asc(lanes.sortOrder), asc(lanes.createdAt)).all();
  const counts = new Map(
    db
      .select({ laneId: channelLanes.laneId, n: sql<number>`count(*)` })
      .from(channelLanes)
      .where(eq(channelLanes.userId, userId))
      .groupBy(channelLanes.laneId)
      .all()
      .map((r) => [r.laneId, Number(r.n)]),
  );
  return rows.map((lane) => {
    const page = laneItems(db, userId, lane.id, 0, PAGE_SIZE, hideShorts);
    return {
      id: lane.id,
      name: lane.name,
      color: lane.color,
      description: lane.description,
      lastRefreshedAt: lane.lastRefreshedAt,
      lastError: lane.lastError,
      isStale: !lane.lastRefreshedAt || now - lane.lastRefreshedAt > STALE_AFTER_MS,
      channelCount: counts.get(lane.id) ?? 0,
      ...page,
    };
  });
}

export function laneBriefs(db: Db, userId: string) {
  return db
    .select({ id: lanes.id, name: lanes.name, description: lanes.description, color: lanes.color })
    .from(lanes)
    .where(eq(lanes.userId, userId))
    .orderBy(asc(lanes.sortOrder))
    .all();
}

// ---------------------------------------------------------------- lane CRUD

export function nextColor(db: Db, userId: string): string {
  const used = new Set(laneBriefs(db, userId).map((l) => l.color));
  return LANE_COLORS.find((c) => !used.has(c)) ?? LANE_COLORS[used.size % LANE_COLORS.length];
}

export function createLane(
  db: Db,
  userId: string,
  input: { name: string; description?: string; color?: string; createdBy?: "user" | "router" | "setup" },
): string {
  const id = crypto.randomUUID();
  const max = db
    .select({ m: sql<number>`coalesce(max(${lanes.sortOrder}), -1)` })
    .from(lanes)
    .where(eq(lanes.userId, userId))
    .get();
  db.insert(lanes)
    .values({
      id,
      userId,
      name: input.name.trim().slice(0, 40),
      description: (input.description ?? "").trim().slice(0, 300),
      color: input.color ?? nextColor(db, userId),
      sortOrder: Number(max?.m ?? -1) + 1,
      createdBy: input.createdBy ?? "user",
    })
    .run();
  return id;
}

export function ownsLane(db: Db, userId: string, laneId: string): boolean {
  return !!db.select({ id: lanes.id }).from(lanes).where(and(eq(lanes.id, laneId), eq(lanes.userId, userId))).get();
}

export function updateLane(db: Db, userId: string, laneId: string, patch: { name?: string; color?: string; description?: string }): void {
  db.update(lanes)
    .set({
      ...(patch.name !== undefined ? { name: patch.name.trim().slice(0, 40) } : {}),
      ...(patch.color !== undefined ? { color: patch.color } : {}),
      ...(patch.description !== undefined ? { description: patch.description.trim().slice(0, 300) } : {}),
    })
    .where(and(eq(lanes.id, laneId), eq(lanes.userId, userId)))
    .run();
}

export function deleteLane(db: Db, userId: string, laneId: string): void {
  // feed_items cascade; channels become unassigned (set null).
  db.delete(lanes).where(and(eq(lanes.id, laneId), eq(lanes.userId, userId))).run();
}

export function reorderLanes(db: Db, userId: string, orderedIds: string[]): void {
  db.transaction((tx) => {
    orderedIds.forEach((id, i) => {
      tx.update(lanes).set({ sortOrder: i }).where(and(eq(lanes.id, id), eq(lanes.userId, userId))).run();
    });
  });
}

// ---------------------------------------------------------------- channels

export function listChannels(db: Db, userId: string) {
  return db
    .select({
      channelId: channelLanes.channelId,
      title: channelLanes.title,
      description: channelLanes.description,
      thumbUrl: channelLanes.thumbUrl,
      laneId: channelLanes.laneId,
      source: channelLanes.source,
    })
    .from(channelLanes)
    .where(eq(channelLanes.userId, userId))
    .orderBy(asc(channelLanes.title))
    .all();
}

/** A user's correction of the classifier; it sticks across re-syncs. */
export function assignChannel(db: Db, userId: string, channelId: string, laneId: string | null): void {
  db.update(channelLanes)
    .set({ laneId, source: "user", updatedAt: Date.now() })
    .where(and(eq(channelLanes.userId, userId), eq(channelLanes.channelId, channelId)))
    .run();
  // Their cached videos move with the channel on the next refresh; drop them from the old lane now.
  db.delete(feedItems)
    .where(and(eq(feedItems.userId, userId), eq(feedItems.channelId, channelId), laneId ? ne(feedItems.laneId, laneId) : undefined))
    .run();
}

/** Pulls the subscription list and uploads playlists; keeps existing lane assignments. */
export async function syncSubscriptions(c: Ctx, userId: string): Promise<{ total: number; added: number; removed: number }> {
  const yt = c.youtube(userId, "sync:subscriptions", true);
  const subs = await yt.subscriptions();
  const existing = new Map(listChannels(c.db, userId).map((ch) => [ch.channelId, ch]));
  const current = new Set(subs.map((s) => s.channelId));

  const missingUploads = subs.filter((s) => !existing.has(s.channelId)).map((s) => s.channelId);
  const uploads = new Map((await yt.channels(missingUploads)).map((ch) => [ch.channelId, ch.uploadsPlaylistId]));

  let added = 0;
  c.db.transaction((tx) => {
    for (const s of subs) {
      if (existing.has(s.channelId)) {
        tx.update(channelLanes)
          .set({ title: s.title, description: s.description, thumbUrl: s.thumbUrl })
          .where(and(eq(channelLanes.userId, userId), eq(channelLanes.channelId, s.channelId)))
          .run();
      } else {
        added++;
        tx.insert(channelLanes)
          .values({
            userId,
            channelId: s.channelId,
            title: s.title,
            description: s.description,
            thumbUrl: s.thumbUrl,
            uploadsPlaylistId: uploads.get(s.channelId) ?? null,
            laneId: null,
          })
          .run();
      }
    }
  });
  const gone = [...existing.keys()].filter((id) => !current.has(id));
  if (gone.length) c.db.delete(channelLanes).where(and(eq(channelLanes.userId, userId), inArray(channelLanes.channelId, gone))).run();
  c.db.update(users).set({ subscriptionsSyncedAt: c.now() }).where(eq(users.id, userId)).run();
  return { total: subs.length, added, removed: gone.length };
}

/** First run and re-sync: proposes lanes when there are none, then files unassigned channels. */
export async function setupLanes(c: Ctx, userId: string) {
  const sync = await syncSubscriptions(c, userId);
  const channels = listChannels(c.db, userId);
  let createdLanes: string[] = [];
  if (laneBriefs(c.db, userId).length === 0 && channels.length > 0) {
    const proposed = await proposeLanes(c.llm.client, c.llm.model, channels);
    createdLanes = proposed.map((p) => createLane(c.db, userId, { name: p.name, description: p.description, createdBy: "setup" }));
  }
  const unassigned = channels.filter((ch) => ch.laneId === null && ch.source === "llm");
  const briefs = laneBriefs(c.db, userId);
  let assigned = 0;
  if (unassigned.length && briefs.length) {
    const result = await classifyChannels(c.llm.client, c.llm.model, briefs, unassigned);
    c.db.transaction((tx) => {
      for (const [channelId, laneId] of result) {
        if (laneId) assigned++;
        tx.update(channelLanes)
          .set({ laneId, source: "llm", updatedAt: Date.now() })
          .where(and(eq(channelLanes.userId, userId), eq(channelLanes.channelId, channelId), eq(channelLanes.source, "llm")))
          .run();
      }
    });
  }
  return { sync, createdLanes: createdLanes.length, classified: unassigned.length, assigned };
}

// ---------------------------------------------------------------- ranking inputs

export function rankContext(db: Db, userId: string, now: number): RankContext {
  const byChannel = db
    .select({
      channelId: signals.channelId,
      clicks: sql<number>`sum(case when ${signals.kind} = 'click' then 1 else 0 end)`,
      watchSec: sql<number>`sum(case when ${signals.kind} = 'watch' then ${signals.value} else 0 end)`,
      likes: sql<number>`sum(case when ${signals.kind} = 'like' then 1 else 0 end)`,
    })
    .from(signals)
    .where(and(eq(signals.userId, userId), sql`${signals.createdAt} > ${now - 60 * 86_400_000}`))
    .groupBy(signals.channelId)
    .all();
  const byVideo = db
    .select({
      videoId: signals.videoId,
      clicks: sql<number>`sum(case when ${signals.kind} = 'click' then 1 else 0 end)`,
      watchSec: sql<number>`sum(case when ${signals.kind} = 'watch' then ${signals.value} else 0 end)`,
      likes: sql<number>`sum(case when ${signals.kind} = 'like' then 1 else 0 end)`,
    })
    .from(signals)
    .where(eq(signals.userId, userId))
    .groupBy(signals.videoId)
    .all();
  const toNum = (r: { clicks: number; watchSec: number; likes: number }) => ({ clicks: Number(r.clicks), watchSec: Number(r.watchSec), likes: Number(r.likes) });
  return {
    now,
    channelAffinity: new Map<string, ChannelAffinity>(byChannel.filter((r) => r.channelId).map((r) => [r.channelId!, toNum(r)])),
    videoSignals: new Map<string, VideoSignals>(byVideo.map((r) => [r.videoId, toNum(r)])),
  };
}

// ---------------------------------------------------------------- refresh

export type RefreshResult = { laneId: string; items: number; units: number; usedCache: boolean; error?: string };

/**
 * Rebuilds one lane from the Data API: recent uploads of its channels
 * (playlistItems, 1 unit each), up to two cached-for-24h searches (100 units
 * each), then videos.list for details (1 unit per 50). On any failure the
 * lane keeps its last cached feed and records the error.
 */
export async function refreshLane(c: Ctx, userId: string, laneId: string, opts: { interactive?: boolean } = {}): Promise<RefreshResult> {
  const lane = c.db.select().from(lanes).where(and(eq(lanes.id, laneId), eq(lanes.userId, userId))).get();
  if (!lane) throw new Error("Lane not found");
  const purpose = `refresh:${laneId}:${crypto.randomUUID()}`;
  const yt = c.youtube(userId, purpose, opts.interactive ?? false);
  const now = c.now();
  const ctxRank = rankContext(c.db, userId, now);

  try {
    // 1. Subscriptions in this lane, the ones the user engages with most first.
    const channels = c.db
      .select({ channelId: channelLanes.channelId, uploads: channelLanes.uploadsPlaylistId })
      .from(channelLanes)
      .where(and(eq(channelLanes.userId, userId), eq(channelLanes.laneId, laneId)))
      .all()
      .filter((ch) => ch.uploads)
      .sort((a, b) => affinityOf(ctxRank, b.channelId) - affinityOf(ctxRank, a.channelId))
      .slice(0, MAX_CHANNELS_PER_REFRESH);

    // Fall back to the cache rather than replace a full feed with a partial one when quota is low.
    const minimum = channels.length * UNIT_COST["playlistItems.list"] + 2 * UNIT_COST["videos.list"];
    if (!canSpend(c.db, c.limits, minimum, opts.interactive)) throw new QuotaError(minimum, 0);

    const sourceOf = new Map<string, "subscription" | "search">();
    const cutoff = now - 90 * 86_400_000;
    for (const ch of channels) {
      const entries = await yt.recentUploads(ch.uploads!, UPLOADS_PER_CHANNEL);
      for (const e of entries) if (e.publishedAt >= cutoff) sourceOf.set(e.videoId, "subscription");
    }

    // 2. LLM-written searches, reused for 24 hours so a lane costs at most ~200 units a day in searches.
    let queries = JSON.parse(lane.searchQueries) as string[];
    if (queries.length === 0) {
      try {
        const titles = laneItems(c.db, userId, laneId, 0, 15, false).items.map((i) => i.title);
        queries = await writeLaneQueries(c.llm.client, c.llm.model, lane, titles);
        c.db.update(lanes).set({ searchQueries: JSON.stringify(queries) }).where(eq(lanes.id, laneId)).run();
      } catch (err) {
        if (!(err instanceof LlmUnavailableError)) throw err;
      }
    }
    for (const q of queries.slice(0, MAX_SEARCHES_PER_REFRESH)) {
      const { value: ids } = await cachedJson<string[]>(c, userId, `lane:${laneId}:${q.toLowerCase()}`, LANE_SEARCH_TTL_MS, async () => {
        if (!canSpend(c.db, c.limits, UNIT_COST["search.list"] + 5, opts.interactive)) return null;
        return yt.searchIds(q, { maxResults: 20, publishedAfter: new Date(now - 30 * 86_400_000) });
      });
      for (const id of ids ?? []) if (!sourceOf.has(id)) sourceOf.set(id, "search");
    }

    // A video already filed in another lane stays there: each video lives in one lane.
    const elsewhere = new Set(
      c.db
        .select({ videoId: feedItems.videoId })
        .from(feedItems)
        .where(and(eq(feedItems.userId, userId), ne(feedItems.laneId, laneId)))
        .all()
        .map((r) => r.videoId),
    );
    const ids = [...sourceOf.keys()].filter((id) => !elsewhere.has(id));

    // 3. Details for every candidate.
    const cards = ids.length ? await yt.videos(ids) : [];
    const candidates: Candidate[] = cards.map((card) => ({ ...card, laneId, source: sourceOf.get(card.videoId) ?? "search" }));
    const ranked = (rankLanes(candidates, ctxRank).get(laneId) ?? []).slice(0, MAX_ITEMS_PER_LANE);

    if (sourceOf.size === 0) {
      // Nothing came back at all (no uploads, searches skipped): keep whatever was cached.
      c.db.update(lanes).set({ lastRefreshedAt: now, lastError: null }).where(eq(lanes.id, laneId)).run();
      return { laneId, items: 0, units: unitsForPurpose(c.db, purpose), usedCache: true };
    }

    c.db.transaction((tx) => {
      tx.delete(feedItems).where(and(eq(feedItems.userId, userId), eq(feedItems.laneId, laneId))).run();
      for (const item of ranked) {
        tx.insert(feedItems)
          .values({
            userId,
            videoId: item.videoId,
            laneId,
            title: item.title,
            channelId: item.channelId,
            channelTitle: item.channelTitle,
            thumbUrl: item.thumbUrl,
            publishedAt: item.publishedAt,
            durationSec: item.durationSec,
            viewCount: item.viewCount,
            isLive: item.isLive,
            source: item.source,
            score: item.score,
            fetchedAt: now,
          })
          .onConflictDoNothing()
          .run();
      }
      tx.update(lanes).set({ lastRefreshedAt: now, lastError: null }).where(eq(lanes.id, laneId)).run();
    });
    return { laneId, items: ranked.length, units: unitsForPurpose(c.db, purpose), usedCache: false };
  } catch (err) {
    const message =
      err instanceof QuotaError ? "Daily YouTube quota is nearly used up; showing the cached feed." : err instanceof Error ? err.message : "Refresh failed";
    c.db.update(lanes).set({ lastError: message }).where(eq(lanes.id, laneId)).run();
    return { laneId, items: 0, units: unitsForPurpose(c.db, purpose), usedCache: true, error: message };
  }
}

function affinityOf(ctx: RankContext, channelId: string): number {
  const a = ctx.channelAffinity.get(channelId);
  return a ? a.clicks + a.watchSec / 120 + a.likes * 3 : 0;
}

/** Refreshes stale lanes one after another (never in parallel), stopping when quota runs low. */
export async function refreshStaleLanes(c: Ctx, userId: string): Promise<RefreshResult[]> {
  const now = c.now();
  const stale = c.db
    .select({ id: lanes.id, last: lanes.lastRefreshedAt })
    .from(lanes)
    .where(and(eq(lanes.userId, userId)))
    .orderBy(asc(lanes.sortOrder))
    .all()
    .filter((l) => !l.last || now - l.last > STALE_AFTER_MS);
  const results: RefreshResult[] = [];
  for (const lane of stale) {
    if (!canSpend(c.db, c.limits, 20)) break;
    results.push(await refreshLane(c, userId, lane.id));
  }
  return results;
}

// ---------------------------------------------------------------- search

/** A per-user JSON cache row; a stale row is still returned when the fetch is skipped (returns null). */
async function cachedJson<T>(c: Ctx, userId: string, key: string, ttlMs: number, fetchValue: () => Promise<T | null>): Promise<{ value: T | null; hit: boolean }> {
  const row = c.db.select().from(searchCache).where(and(eq(searchCache.userId, userId), eq(searchCache.queryKey, key))).get();
  if (row && c.now() - row.fetchedAt < ttlMs) return { value: JSON.parse(row.results) as T, hit: true };
  const value = await fetchValue();
  if (value === null) return { value: row ? (JSON.parse(row.results) as T) : null, hit: !!row };
  const results = JSON.stringify(value);
  c.db.insert(searchCache)
    .values({ userId, queryKey: key, results, fetchedAt: c.now() })
    .onConflictDoUpdate({ target: [searchCache.userId, searchCache.queryKey], set: { results, fetchedAt: c.now() } })
    .run();
  return { value, hit: false };
}

/** search.list inside a lane, cached 24h; the query also becomes one of the lane's own searches. */
export async function searchInLane(c: Ctx, userId: string, laneId: string, query: string): Promise<{ items: VideoCard[]; cached: boolean }> {
  const key = `q:${query.trim().toLowerCase().replace(/\s+/g, " ")}`;
  const yt = c.youtube(userId, `search:${laneId}`, true);
  const { value, hit } = await cachedJson<VideoCard[]>(c, userId, key, LANE_SEARCH_TTL_MS, async () => {
    const ids = await yt.searchIds(query, { maxResults: 25 });
    return ids.length ? yt.videos(ids) : [];
  });
  const { hideShorts } = getSettings(c.db, userId);
  const items = (value ?? []).filter((v) => !(hideShorts && isShort(v)));

  // Searching in a lane teaches it: keep the query among the lane's searches (newest first, max 4).
  const lane = c.db.select({ q: lanes.searchQueries }).from(lanes).where(eq(lanes.id, laneId)).get();
  if (lane) {
    const trimmed = query.trim();
    const qs = [trimmed, ...(JSON.parse(lane.q) as string[]).filter((q) => q.toLowerCase() !== trimmed.toLowerCase())].slice(0, 4);
    c.db.update(lanes).set({ searchQueries: JSON.stringify(qs) }).where(eq(lanes.id, laneId)).run();
  }

  // A brand-new lane has nothing cached yet: seed its feed with these results.
  if (laneItems(c.db, userId, laneId, 0, 1, false).items.length === 0 && items.length) {
    const ranked = rankLanes(
      items.map((v) => ({ ...v, laneId, source: "search" as const })),
      rankContext(c.db, userId, c.now()),
    ).get(laneId) ?? [];
    c.db.transaction((tx) => {
      for (const item of ranked) {
        tx.insert(feedItems)
          .values({ ...item, userId, fetchedAt: c.now() })
          .onConflictDoNothing()
          .run();
      }
      tx.update(lanes).set({ lastRefreshedAt: c.now(), lastError: null }).where(eq(lanes.id, laneId)).run();
    });
  }
  return { items, cached: hit };
}

// ---------------------------------------------------------------- signals

export function recordSignal(db: Db, userId: string, input: { videoId: string; laneId?: string | null; kind: "click" | "watch" | "like"; value?: number; channelId?: string | null }): void {
  const item = db
    .select({ channelId: feedItems.channelId, laneId: feedItems.laneId })
    .from(feedItems)
    .where(and(eq(feedItems.userId, userId), eq(feedItems.videoId, input.videoId)))
    .get();
  db.insert(signals)
    .values({
      userId,
      videoId: input.videoId,
      channelId: item?.channelId ?? input.channelId ?? null,
      laneId: item?.laneId ?? input.laneId ?? null,
      kind: input.kind,
      value: input.kind === "watch" ? Math.max(0, Math.min(input.value ?? 0, 6 * 3600)) : 1,
    })
    .run();
}

export function unassignedChannelCount(db: Db, userId: string): number {
  const row = db
    .select({ n: sql<number>`count(*)` })
    .from(channelLanes)
    .where(and(eq(channelLanes.userId, userId), isNull(channelLanes.laneId)))
    .get();
  return Number(row?.n ?? 0);
}
