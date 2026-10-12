import "server-only";
import { z } from "zod";

import type { VideoCard } from "@/shared/types";
import type { Db } from "./db/client";
import { QuotaError, reserveUnits, type QuotaLimits, type YtMethod } from "./quota";

const API = "https://www.googleapis.com/youtube/v3";

export class YouTubeError extends Error {
  constructor(
    readonly status: number,
    readonly reason: string,
    message: string,
  ) {
    super(message);
    this.name = "YouTubeError";
  }
}

export type Subscription = { channelId: string; title: string; description: string; thumbUrl: string | null };
export type ChannelInfo = { channelId: string; uploadsPlaylistId: string | null };
export type PlaylistEntry = { videoId: string; publishedAt: number };

type Thumbs = Record<string, { url: string } | undefined> | undefined;

function bestThumb(t: Thumbs): string | null {
  return t?.medium?.url ?? t?.high?.url ?? t?.default?.url ?? null;
}

/** ISO 8601 duration (PT1H2M3S, P1DT2H) to seconds; null for unknown/live (P0D). */
export function parseIsoDuration(iso: string | undefined): number | null {
  if (!iso) return null;
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(iso);
  if (!m) return null;
  const [, d, h, min, s] = m;
  const total = Number(d ?? 0) * 86400 + Number(h ?? 0) * 3600 + Number(min ?? 0) * 60 + Math.round(Number(s ?? 0));
  return total > 0 ? total : null;
}

const pageInfo = z.object({ nextPageToken: z.string().optional() });

const subscriptionsResponse = pageInfo.extend({
  items: z
    .array(
      z.object({
        snippet: z.object({
          title: z.string(),
          description: z.string().default(""),
          resourceId: z.object({ channelId: z.string() }),
          thumbnails: z.any().optional(),
        }),
      }),
    )
    .default([]),
});

const channelsResponse = z.object({
  items: z
    .array(
      z.object({
        id: z.string(),
        contentDetails: z.object({ relatedPlaylists: z.object({ uploads: z.string().optional() }) }).optional(),
      }),
    )
    .default([]),
});

const playlistItemsResponse = pageInfo.extend({
  items: z
    .array(
      z.object({
        contentDetails: z.object({ videoId: z.string(), videoPublishedAt: z.string().optional() }),
        snippet: z.object({ publishedAt: z.string().optional() }).optional(),
      }),
    )
    .default([]),
});

const videosResponse = z.object({
  items: z
    .array(
      z.object({
        id: z.string(),
        snippet: z.object({
          title: z.string(),
          channelId: z.string(),
          channelTitle: z.string(),
          publishedAt: z.string(),
          thumbnails: z.any().optional(),
          liveBroadcastContent: z.string().optional(),
        }),
        contentDetails: z.object({ duration: z.string().optional() }).optional(),
        statistics: z.object({ viewCount: z.string().optional() }).optional(),
        status: z.object({ embeddable: z.boolean().optional(), privacyStatus: z.string().optional() }).optional(),
      }),
    )
    .default([]),
});

const searchResponse = z.object({
  items: z.array(z.object({ id: z.object({ videoId: z.string().optional() }) })).default([]),
});

export type YouTubeDeps = {
  db: Db;
  limits: QuotaLimits;
  userId: string;
  /** Returns a valid access token; `force` refreshes even if not expired. */
  getAccessToken: (force?: boolean) => Promise<string>;
  fetch?: typeof fetch;
  /** Tag written to the quota log, e.g. "refresh:<laneId>". */
  purpose?: string;
  /** Interactive calls may use the reserve kept for searches. */
  interactive?: boolean;
};

/** A YouTube Data API v3 client that books every call against the daily quota first. */
export class YouTube {
  constructor(private readonly deps: YouTubeDeps) {}

  withPurpose(purpose: string, interactive = this.deps.interactive): YouTube {
    return new YouTube({ ...this.deps, purpose, interactive });
  }

  private async call<T>(method: YtMethod, path: string, params: Record<string, string>, parse: z.ZodType<T>): Promise<T> {
    // Token first: a call that can't be authorized never reaches Google and costs nothing.
    let token = await this.deps.getAccessToken();
    reserveUnits(this.deps.db, this.deps.limits, {
      method,
      userId: this.deps.userId,
      purpose: this.deps.purpose,
      interactive: this.deps.interactive,
    });
    const url = `${API}/${path}?${new URLSearchParams(params)}`;
    const doFetch = this.deps.fetch ?? fetch;
    let res = await doFetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } });
    if (res.status === 401) {
      token = await this.deps.getAccessToken(true);
      res = await doFetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } });
    }
    const body: unknown = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = (body as { error?: { message?: string; errors?: { reason?: string }[] } }).error;
      const reason = err?.errors?.[0]?.reason ?? "unknown";
      if (reason === "quotaExceeded" || reason === "dailyLimitExceeded") throw new QuotaError(0, 0);
      throw new YouTubeError(res.status, reason, err?.message ?? `YouTube ${method} failed (${res.status})`);
    }
    return parse.parse(body);
  }

  /** All of the user's subscriptions: 1 unit per 50. */
  async subscriptions(maxPages = 20): Promise<Subscription[]> {
    const out: Subscription[] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < maxPages; page++) {
      const res = await this.call(
        "subscriptions.list",
        "subscriptions",
        { part: "snippet", mine: "true", maxResults: "50", order: "alphabetical", ...(pageToken ? { pageToken } : {}) },
        subscriptionsResponse,
      );
      for (const item of res.items) {
        out.push({
          channelId: item.snippet.resourceId.channelId,
          title: item.snippet.title,
          description: item.snippet.description.slice(0, 500),
          thumbUrl: bestThumb(item.snippet.thumbnails),
        });
      }
      pageToken = res.nextPageToken;
      if (!pageToken) break;
    }
    return out;
  }

  /** Uploads playlist per channel: 1 unit per 50 channels. */
  async channels(ids: string[]): Promise<ChannelInfo[]> {
    const out: ChannelInfo[] = [];
    for (let i = 0; i < ids.length; i += 50) {
      const batch = ids.slice(i, i + 50);
      const res = await this.call("channels.list", "channels", { part: "contentDetails", id: batch.join(","), maxResults: "50" }, channelsResponse);
      for (const item of res.items) {
        out.push({ channelId: item.id, uploadsPlaylistId: item.contentDetails?.relatedPlaylists.uploads ?? null });
      }
    }
    return out;
  }

  /** Recent uploads of one channel: 1 unit. */
  async recentUploads(uploadsPlaylistId: string, maxResults = 10): Promise<PlaylistEntry[]> {
    const res = await this.call(
      "playlistItems.list",
      "playlistItems",
      { part: "contentDetails", playlistId: uploadsPlaylistId, maxResults: String(Math.min(50, maxResults)) },
      playlistItemsResponse,
    );
    return res.items.map((item) => ({
      videoId: item.contentDetails.videoId,
      publishedAt: Date.parse(item.contentDetails.videoPublishedAt ?? item.snippet?.publishedAt ?? "") || 0,
    }));
  }

  /** Full cards for up to N videos: 1 unit per 50. Private, deleted and non-embeddable-unknown videos drop out. */
  async videos(ids: string[]): Promise<VideoCard[]> {
    const unique = [...new Set(ids)];
    const out: VideoCard[] = [];
    for (let i = 0; i < unique.length; i += 50) {
      const batch = unique.slice(i, i + 50);
      const res = await this.call(
        "videos.list",
        "videos",
        { part: "snippet,contentDetails,statistics,status", id: batch.join(","), maxResults: "50" },
        videosResponse,
      );
      for (const v of res.items) {
        if (v.status?.privacyStatus && v.status.privacyStatus !== "public" && v.status.privacyStatus !== "unlisted") continue;
        const thumb = bestThumb(v.snippet.thumbnails);
        if (!thumb) continue;
        out.push({
          videoId: v.id,
          title: v.snippet.title,
          channelId: v.snippet.channelId,
          channelTitle: v.snippet.channelTitle,
          thumbUrl: thumb,
          publishedAt: Date.parse(v.snippet.publishedAt) || 0,
          durationSec: parseIsoDuration(v.contentDetails?.duration),
          viewCount: v.statistics?.viewCount ? Number(v.statistics.viewCount) : null,
          isLive: v.snippet.liveBroadcastContent === "live",
        });
      }
    }
    return out;
  }

  /** search.list for video ids: 100 units. */
  async searchIds(q: string, opts: { maxResults?: number; publishedAfter?: Date } = {}): Promise<string[]> {
    const res = await this.call(
      "search.list",
      "search",
      {
        part: "id",
        type: "video",
        q,
        maxResults: String(opts.maxResults ?? 25),
        safeSearch: "moderate",
        ...(opts.publishedAfter ? { publishedAfter: opts.publishedAfter.toISOString() } : {}),
      },
      searchResponse,
    );
    return res.items.map((i) => i.id.videoId).filter((id): id is string => !!id);
  }
}
