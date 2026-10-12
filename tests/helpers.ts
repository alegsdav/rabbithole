import { openDb, type Db } from "@/server/db/client";
import { channelLanes, users } from "@/server/db/schema";
import type { Ctx } from "@/server/context";
import type { LlmClient } from "@/server/llm";
import { YouTube } from "@/server/youtube";

export function testDb(): Db {
  return openDb(":memory:");
}

export function addUser(db: Db, id = "u1"): string {
  db.insert(users).values({ id, googleSub: `sub-${id}` }).run();
  return id;
}

export function addChannel(db: Db, userId: string, channelId: string, laneId: string | null, title = channelId) {
  db.insert(channelLanes).values({ userId, channelId, laneId, title, uploadsPlaylistId: `UU${channelId.slice(2)}` }).run();
}

type FakeVideo = { id: string; channelId: string; durationSec?: number; publishedAt?: number; title?: string };

/**
 * A fake youtube.googleapis.com: answers each Data API method from an in-memory
 * world and counts calls, so tests measure quota exactly as the real client books it.
 */
export function fakeYouTubeFetch(world: { uploads: Record<string, FakeVideo[]>; search?: Record<string, string[]>; subscriptions?: { channelId: string; title: string }[] }) {
  const calls: string[] = [];
  const all = new Map<string, FakeVideo>();
  for (const vids of Object.values(world.uploads)) for (const v of vids) all.set(v.id, v);
  const iso = (sec: number) => `PT${Math.floor(sec / 60)}M${sec % 60}S`;

  const impl = async (input: string | URL | Request): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = url.pathname.split("/").pop()!;
    calls.push(method);
    const p = url.searchParams;
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    switch (method) {
      case "subscriptions":
        return json({
          items: (world.subscriptions ?? []).map((s) => ({ snippet: { title: s.title, description: "", resourceId: { channelId: s.channelId }, thumbnails: {} } })),
        });
      case "channels":
        return json({ items: p.get("id")!.split(",").map((id) => ({ id, contentDetails: { relatedPlaylists: { uploads: `UU${id.slice(2)}` } } })) });
      case "playlistItems": {
        const channelId = `UC${p.get("playlistId")!.slice(2)}`;
        const vids = (world.uploads[channelId] ?? []).slice(0, Number(p.get("maxResults")));
        return json({ items: vids.map((v) => ({ contentDetails: { videoId: v.id, videoPublishedAt: new Date(v.publishedAt ?? Date.now()).toISOString() } })) });
      }
      case "search": {
        const ids = world.search?.[p.get("q")!] ?? [];
        return json({ items: ids.map((videoId) => ({ id: { videoId } })) });
      }
      case "videos":
        return json({
          items: p
            .get("id")!
            .split(",")
            .map((id) => all.get(id) ?? { id, channelId: "UCsearchsearchsearchsearch", durationSec: 600 })
            .map((v) => ({
              id: v.id,
              snippet: {
                title: v.title ?? `Video ${v.id}`,
                channelId: v.channelId,
                channelTitle: v.channelId,
                publishedAt: new Date(v.publishedAt ?? Date.now()).toISOString(),
                thumbnails: { medium: { url: `https://i.ytimg.com/vi/${v.id}/mqdefault.jpg` } },
                liveBroadcastContent: "none",
              },
              contentDetails: { duration: iso(v.durationSec ?? 600) },
              statistics: { viewCount: "1000" },
              status: { privacyStatus: "public" },
            })),
        });
      default:
        return new Response("{}", { status: 404 });
    }
  };
  return { fetch: impl as unknown as typeof fetch, calls };
}

export function testCtx(db: Db, opts: { fetch: typeof fetch; llm?: LlmClient; now?: () => number; daily?: number; reserve?: number }): Ctx {
  const limits = { daily: opts.daily ?? 10_000, reserve: opts.reserve ?? 1_500 };
  return {
    db,
    limits,
    llm: { client: opts.llm ?? unavailableLlm(), model: "claude-opus-5-5" },
    youtube: (userId, purpose, interactive = false) =>
      new YouTube({ db, limits, userId, purpose, interactive, fetch: opts.fetch, getAccessToken: async () => "test-token" }),
    now: opts.now ?? (() => Date.now()),
  };
}

/** An LLM client whose `parse` answers with the given objects, in order. */
export function scriptedLlm(...outputs: unknown[]): LlmClient & { requests: unknown[] } {
  const requests: unknown[] = [];
  return {
    requests,
    parse: (async (params: unknown) => {
      requests.push(params);
      const parsed_output = outputs.shift();
      return { stop_reason: "end_turn", parsed_output, content: [] };
    }) as unknown as LlmClient["parse"],
  };
}

export function unavailableLlm(): LlmClient {
  return {
    parse: (async () => {
      throw new Error("no llm in tests");
    }) as unknown as LlmClient["parse"],
  };
}
