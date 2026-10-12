/** Types shared by the server and the browser. Plain data only: no secrets. */

export type VideoCard = {
  videoId: string;
  title: string;
  channelId: string;
  channelTitle: string;
  thumbUrl: string;
  /** ms since epoch */
  publishedAt: number;
  durationSec: number | null;
  viewCount: number | null;
  isLive: boolean;
};

export type LaneSummary = {
  id: string;
  name: string;
  color: string;
  description: string;
  lastRefreshedAt: number | null;
  lastError: string | null;
  isStale: boolean;
  channelCount: number;
  items: VideoCard[];
  hasMore: boolean;
};

export type RouteDecision =
  | { kind: "assign"; laneId: string; confidence: number; alternates: string[]; autoRouted: boolean }
  | { kind: "create"; newLane: { name: string; description: string; color: string }; confidence: number; alternates: string[] }
  | { kind: "ask"; reason: string; alternates: string[] };

export type QuotaSummary = { day: string; used: number; daily: number; reserve: number; remaining: number };

/** Lane accent palette: distinct hues readable on light and dark backgrounds. */
export const LANE_COLORS = [
  "#e5484d",
  "#f76b15",
  "#ffc53d",
  "#46a758",
  "#12a594",
  "#0090ff",
  "#3e63dd",
  "#8e4ec6",
  "#d6409f",
  "#978365",
] as const;

export const MAX_LANES_SOFT = 12;
export const STALE_AFTER_MS = 30 * 60 * 1000;
export const PAGE_SIZE = 40;
