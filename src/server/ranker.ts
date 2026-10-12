import type { VideoCard } from "@/shared/types";

export type Candidate = VideoCard & { laneId: string; source: "subscription" | "search" };

export type ChannelAffinity = { clicks: number; watchSec: number; likes: number };
export type VideoSignals = { clicks: number; watchSec: number; likes: number };

export type RankContext = {
  now: number;
  channelAffinity: Map<string, ChannelAffinity>;
  videoSignals: Map<string, VideoSignals>;
};

const DAY = 86_400_000;

/** Higher is better. Every term is bounded so no single signal can take over a lane. */
export function scoreVideo(v: Candidate, ctx: RankContext): number {
  const ageDays = Math.max(0, (ctx.now - v.publishedAt) / DAY);
  const recency = Math.exp(-ageDays / 7); // ~5 day half-life

  const aff = ctx.channelAffinity.get(v.channelId);
  const affinityRaw = aff ? aff.clicks + aff.watchSec / 120 + aff.likes * 3 : 0;
  const affinity = Math.min(1, Math.log1p(affinityRaw) / Math.log1p(30));

  const source = v.source === "subscription" ? 0.3 : 0;
  const popularity = v.source === "search" && v.viewCount ? Math.min(0.2, Math.log10(v.viewCount + 1) / 35) : 0;

  // Already seen: a watched-through video sinks; a clicked one dips a little.
  const seen = ctx.videoSignals.get(v.videoId);
  let seenPenalty = 0;
  if (seen) {
    const watchedShare = v.durationSec ? seen.watchSec / v.durationSec : seen.watchSec > 300 ? 1 : 0;
    seenPenalty = watchedShare >= 0.6 ? 0.9 : seen.clicks > 0 ? 0.2 : 0;
  }
  const live = v.isLive ? 0.15 : 0;

  return recency + 0.6 * affinity + source + popularity + live - seenPenalty;
}

/**
 * Scores candidates, gives each video to exactly one lane (its best-scoring
 * one), then orders each lane, spreading out runs of the same channel.
 */
export function rankLanes(candidates: Candidate[], ctx: RankContext): Map<string, (Candidate & { score: number })[]> {
  const best = new Map<string, Candidate & { score: number }>();
  for (const c of candidates) {
    const score = scoreVideo(c, ctx);
    const prev = best.get(c.videoId);
    if (!prev || score > prev.score || (score === prev.score && c.source === "subscription")) {
      best.set(c.videoId, { ...c, score });
    }
  }

  const byLane = new Map<string, (Candidate & { score: number })[]>();
  for (const item of best.values()) {
    const list = byLane.get(item.laneId) ?? [];
    list.push(item);
    byLane.set(item.laneId, list);
  }

  for (const [laneId, list] of byLane) {
    list.sort((a, b) => b.score - a.score);
    const seenPerChannel = new Map<string, number>();
    const diversified = list.map((item) => {
      const n = seenPerChannel.get(item.channelId) ?? 0;
      seenPerChannel.set(item.channelId, n + 1);
      return { ...item, score: item.score - 0.12 * n };
    });
    diversified.sort((a, b) => b.score - a.score);
    byLane.set(laneId, diversified);
  }
  return byLane;
}

export function isShort(v: Pick<VideoCard, "durationSec" | "isLive">): boolean {
  return !v.isLive && v.durationSec !== null && v.durationSec < 60;
}
