import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";

import { decrypt, encrypt } from "@/server/crypto";
import { feedItems, lanes as lanesTable, quotaLog, signals, users } from "@/server/db/schema";
import { checkCsrf, rateLimit } from "@/server/guards";
import { createLane, deleteLane, laneItems, listLanes, recordSignal, refreshLane, searchInLane, setupLanes } from "@/server/lanes";
import { routeQuery } from "@/server/llm";
import { QuotaError, quotaDay, reserveUnits, usedToday } from "@/server/quota";
import { isShort, rankLanes, scoreVideo, type Candidate, type RankContext } from "@/server/ranker";
import { decide, routeSearch } from "@/server/router";
import { AuthExpiredError, disconnectUser, getAccessToken, upsertUserFromSignIn } from "@/server/tokens";
import { YouTube, parseIsoDuration } from "@/server/youtube";
import { buildCsp } from "@/proxy";
import { addChannel, addUser, fakeYouTubeFetch, scriptedLlm, testCtx, testDb } from "./helpers";

const KEY = Buffer.alloc(32, 7).toString("base64");
const DAY = 86_400_000;

describe("quota", () => {
  it("uses the Pacific calendar day", () => {
    expect(quotaDay(new Date("2026-10-12T06:30:00Z"))).toBe("2026-10-11");
    expect(quotaDay(new Date("2026-10-12T08:30:00Z"))).toBe("2026-10-12");
  });

  it("never books past the daily limit, and keeps the reserve for interactive calls", () => {
    const db = testDb();
    const limits = { daily: 300, reserve: 100 };
    reserveUnits(db, limits, { method: "search.list" });
    reserveUnits(db, limits, { method: "videos.list", calls: 100 });
    expect(usedToday(db)).toBe(200);
    expect(() => reserveUnits(db, limits, { method: "videos.list" })).toThrow(QuotaError);
    reserveUnits(db, limits, { method: "search.list", interactive: true });
    expect(usedToday(db)).toBe(300);
    expect(() => reserveUnits(db, limits, { method: "videos.list", interactive: true })).toThrow(QuotaError);
    expect(usedToday(db)).toBe(300);
  });
});

describe("youtube client", () => {
  it("books no quota for a call that can't be authorized", async () => {
    const db = testDb();
    const yt = new YouTube({
      db,
      limits: { daily: 10_000, reserve: 0 },
      userId: "u",
      getAccessToken: async () => {
        throw new AuthExpiredError();
      },
      fetch: fakeYouTubeFetch({ uploads: {} }).fetch,
    });
    await expect(yt.searchIds("anything")).rejects.toBeInstanceOf(AuthExpiredError);
    expect(usedToday(db)).toBe(0);
  });

  it("parses ISO durations", () => {
    expect(parseIsoDuration("PT1H2M3S")).toBe(3723);
    expect(parseIsoDuration("PT45S")).toBe(45);
    expect(parseIsoDuration("P1DT1S")).toBe(86401);
    expect(parseIsoDuration("P0D")).toBeNull();
  });
});

describe("lane refresh", () => {
  function world(now: number) {
    const uploads: Record<string, { id: string; channelId: string; publishedAt: number; durationSec?: number }[]> = {};
    for (let c = 0; c < 5; c++) {
      const channelId = `UC${String(c).repeat(22)}`;
      uploads[channelId] = Array.from({ length: 8 }, (_, i) => ({
        id: `v${c}${i}`.padEnd(11, "x"),
        channelId,
        publishedAt: now - i * DAY,
        durationSec: i === 0 ? 30 : 900,
      }));
    }
    return { uploads, search: { "espresso tamping": ["s1xxxxxxxxx", "s2xxxxxxxxx", "v00xxxxxxxx"], "latte art": ["s3xxxxxxxxx"] } };
  }

  it("measures units per refresh: uploads + cached searches + one videos.list", async () => {
    const now = Date.parse("2026-10-12T18:00:00Z");
    const db = testDb();
    const userId = addUser(db);
    const fake = fakeYouTubeFetch(world(now));
    const c = testCtx(db, { fetch: fake.fetch, now: () => now });
    const laneId = createLane(db, userId, { name: "Espresso" });
    db.update(lanesTable).set({ searchQueries: JSON.stringify(["espresso tamping", "latte art"]) }).where(eq(lanesTable.id, laneId)).run();
    for (const ch of Object.keys(world(now).uploads)) addChannel(db, userId, ch, laneId);

    const first = await refreshLane(c, userId, laneId);
    // 5 channels x playlistItems (1) + 2 x search.list (100) + 1 x videos.list (1)
    expect(first.units).toBe(5 + 200 + 1);
    expect(first.items).toBe(43);

    const second = await refreshLane(c, userId, laneId);
    // Searches are reused for 24 hours: only uploads and details are fetched again.
    expect(second.units).toBe(5 + 1);

    const page = laneItems(db, userId, laneId);
    expect(page.items.length).toBe(38); // 43 minus 5 shorts (< 60s) hidden
    expect(page.items.every((v) => !isShort(v))).toBe(true);
  });

  it("keeps the cached feed and records the error when quota runs out", async () => {
    const now = Date.now();
    const db = testDb();
    const userId = addUser(db);
    const fake = fakeYouTubeFetch(world(now));
    const laneId = createLane(db, userId, { name: "Espresso" });
    for (const ch of Object.keys(world(now).uploads)) addChannel(db, userId, ch, laneId);
    await refreshLane(testCtx(db, { fetch: fake.fetch }), userId, laneId);
    const before = laneItems(db, userId, laneId).items.length;

    const starved = testCtx(db, { fetch: fake.fetch, daily: usedToday(db) + 2, reserve: 0 });
    const result = await refreshLane(starved, userId, laneId);
    expect(result.usedCache).toBe(true);
    expect(laneItems(db, userId, laneId).items.length).toBe(before);
    expect(listLanes(db, userId)[0]!.lastError).toMatch(/quota/i);
  });

  it("puts each video in exactly one lane", async () => {
    const now = Date.now();
    const db = testDb();
    const userId = addUser(db);
    const w = world(now);
    const fake = fakeYouTubeFetch(w);
    const c = testCtx(db, { fetch: fake.fetch });
    const a = createLane(db, userId, { name: "A" });
    const b = createLane(db, userId, { name: "B" });
    addChannel(db, userId, Object.keys(w.uploads)[0]!, a);
    db.update(lanesTable).set({ searchQueries: JSON.stringify(["espresso tamping"]) }).where(eq(lanesTable.id, b)).run();
    await refreshLane(c, userId, a);
    await refreshLane(c, userId, b);
    const rows = db.select().from(feedItems).where(eq(feedItems.userId, userId)).all();
    expect(new Set(rows.map((r) => r.videoId)).size).toBe(rows.length);
    expect(rows.find((r) => r.videoId === "v00xxxxxxxx")?.laneId).toBe(a);
  });
});

describe("ranker", () => {
  const base = { title: "t", channelTitle: "c", thumbUrl: "x", durationSec: 600, viewCount: 10, isLive: false } as const;
  const ctxOf = (over: Partial<RankContext> = {}): RankContext => ({ now: 10 * DAY, channelAffinity: new Map(), videoSignals: new Map(), ...over });

  it("prefers recent videos and channels the user engages with", () => {
    const fresh: Candidate = { ...base, videoId: "a", channelId: "c1", publishedAt: 10 * DAY, laneId: "l", source: "subscription" };
    const old: Candidate = { ...fresh, videoId: "b", publishedAt: 0 };
    expect(scoreVideo(fresh, ctxOf())).toBeGreaterThan(scoreVideo(old, ctxOf()));
    const liked = ctxOf({ channelAffinity: new Map([["c2", { clicks: 5, watchSec: 3000, likes: 2 }]]) });
    const other: Candidate = { ...fresh, videoId: "c", channelId: "c2" };
    expect(scoreVideo(other, liked)).toBeGreaterThan(scoreVideo(fresh, liked));
  });

  it("sinks videos already watched through", () => {
    const v: Candidate = { ...base, videoId: "a", channelId: "c1", publishedAt: 10 * DAY, laneId: "l", source: "subscription" };
    const watched = ctxOf({ videoSignals: new Map([["a", { clicks: 1, watchSec: 500, likes: 0 }]]) });
    expect(scoreVideo(v, watched)).toBeLessThan(scoreVideo(v, ctxOf()) - 0.5);
  });

  it("spreads out one channel's run of videos", () => {
    const many: Candidate[] = Array.from({ length: 5 }, (_, i) => ({ ...base, videoId: `a${i}`, channelId: "c1", publishedAt: 10 * DAY - i * 1000, laneId: "l", source: "subscription" }));
    const one: Candidate = { ...base, videoId: "b", channelId: "c2", publishedAt: 9 * DAY, laneId: "l", source: "subscription" };
    const order = rankLanes([...many, one], ctxOf()).get("l")!.map((v) => v.videoId);
    expect(order.indexOf("b")).toBeLessThan(4);
  });
});

describe("router", () => {
  const lanes = ["l1", "l2", "l3"];

  it("routes confidently at 0.7 and above", () => {
    const d = decide({ action: "assign", laneId: "l1", newLane: null, confidence: 0.82, alternates: ["l2", "zz", "l1"] }, lanes, "#000");
    expect(d).toEqual({ kind: "assign", laneId: "l1", confidence: 0.82, alternates: ["l2"], autoRouted: true });
  });

  it("asks below 0.7, offering the top two lanes", () => {
    const d = decide({ action: "assign", laneId: "l2", newLane: null, confidence: 0.55, alternates: ["l3", "l1"] }, lanes, "#000");
    expect(d.kind === "assign" && !d.autoRouted && d.alternates).toEqual(["l3", "l1"]);
  });

  it("proposes a new lane but never invents lane ids", () => {
    expect(decide({ action: "create", laneId: null, newLane: { name: " Woodworking ", description: "Hand tools" }, confidence: 0.9, alternates: [] }, lanes, "#111")).toMatchObject({
      kind: "create",
      newLane: { name: "Woodworking", color: "#111" },
    });
    expect(decide({ action: "assign", laneId: "nope", newLane: null, confidence: 0.99, alternates: [] }, lanes, "#000").kind).toBe("ask");
  });

  it("sends only the query, lane ids, names and descriptions, and asks the user if the LLM fails", async () => {
    const db = testDb();
    const userId = addUser(db);
    const laneId = createLane(db, userId, { name: "Espresso", description: "Home espresso" });
    const llm = scriptedLlm({ action: "assign", laneId, newLane: null, confidence: 0.9, alternates: [] });
    const c = testCtx(db, { fetch: fakeYouTubeFetch({ uploads: {} }).fetch, llm });
    const d = await routeSearch(c, userId, "dialing in a new grinder");
    expect(d).toMatchObject({ kind: "assign", laneId, autoRouted: true });
    const sent = JSON.parse(llm.requests[0]!.user);
    expect(Object.keys(sent).sort()).toEqual(["lanes", "pastCorrections", "query"]);
    expect(Object.keys(sent.lanes[0]).sort()).toEqual(["description", "id", "name"]);

    const failing = testCtx(db, { fetch: fakeYouTubeFetch({ uploads: {} }).fetch });
    expect((await routeSearch(failing, userId, "something else")).kind).toBe("ask");
  });

  it("clamps confidence", async () => {
    const out = await routeQuery(scriptedLlm({ action: "assign", laneId: "l1", newLane: null, confidence: 7, alternates: [] }), {
      query: "q",
      lanes: [],
      corrections: [],
    });
    expect(out.confidence).toBe(1);
  });
});

describe("setup", () => {
  it("proposes lanes from subscriptions and files every channel", async () => {
    const db = testDb();
    const userId = addUser(db);
    const subs = [
      { channelId: "UC" + "a".repeat(22), title: "James Hoffmann" },
      { channelId: "UC" + "b".repeat(22), title: "ByteByteGo" },
    ];
    const fake = fakeYouTubeFetch({ uploads: {}, subscriptions: subs });
    // The classifier answers with ids it can only know from the request, so script it lazily.
    const requests: { user: string }[] = [];
    const llm = {
      generateJson: async ({ user }: { user: string }) => {
        requests.push({ user });
        if (requests.length === 1) return { lanes: [{ name: "Coffee", description: "Espresso" }, { name: "Software", description: "Architecture" }] };
        const body = JSON.parse(user) as { lanes: { id: string; name: string }[] };
        const id = (name: string) => body.lanes.find((l) => l.name === name)!.id;
        return { assignments: [{ channelId: subs[0]!.channelId, laneId: id("Coffee") }, { channelId: subs[1]!.channelId, laneId: id("Software") }] };
      },
    };
    const report = await setupLanes(testCtx(db, { fetch: fake.fetch, llm }), userId);
    expect(report).toMatchObject({ createdLanes: 2, classified: 2, assigned: 2 });
    expect(listLanes(db, userId).map((l) => [l.name, l.channelCount])).toEqual([
      ["Coffee", 1],
      ["Software", 1],
    ]);
    // Classification sees channel titles/descriptions only.
    expect(requests[1]!.user).not.toMatch(/token|email/i);
  });
});

describe("search", () => {
  it("caches results for 24 hours and seeds an empty lane", async () => {
    let now = Date.now();
    const db = testDb();
    const userId = addUser(db);
    const fake = fakeYouTubeFetch({ uploads: {}, search: { woodworking: ["w1xxxxxxxxx", "w2xxxxxxxxx"] } });
    const c = testCtx(db, { fetch: fake.fetch, now: () => now });
    const laneId = createLane(db, userId, { name: "Woodworking", createdBy: "router" });
    const first = await searchInLane(c, userId, laneId, "woodworking");
    expect(first).toMatchObject({ cached: false });
    expect(first.items).toHaveLength(2);
    expect(laneItems(db, userId, laneId).items).toHaveLength(2);
    now += 23 * 3600_000;
    expect((await searchInLane(c, userId, laneId, "  Woodworking ")).cached).toBe(true);
    expect(fake.calls.filter((m) => m === "search")).toHaveLength(1);
    now += 2 * 3600_000;
    expect((await searchInLane(c, userId, laneId, "woodworking")).cached).toBe(false);
  });
});

describe("tokens and privacy", () => {
  it("seals tokens at rest", () => {
    expect(decrypt(encrypt("secret", KEY), KEY)).toBe("secret");
    const db = testDb();
    const id = upsertUserFromSignIn(db, { encKey: KEY }, { sub: "g1", accessToken: "ya29.access", refreshToken: "1//refresh", expiresAt: 2_000_000_000 });
    const row = db.select().from(users).where(eq(users.id, id)).get()!;
    expect(JSON.stringify(row)).not.toMatch(/ya29\.access|1\/\/refresh/);
    // A later sign-in without a refresh token keeps the old one.
    upsertUserFromSignIn(db, { encKey: KEY }, { sub: "g1", accessToken: "ya29.new" });
    expect(decrypt(db.select().from(users).where(eq(users.id, id)).get()!.refreshTokenEnc!, KEY)).toBe("1//refresh");
  });

  it("refreshes an expired access token", async () => {
    const db = testDb();
    const id = upsertUserFromSignIn(db, { encKey: KEY }, { sub: "g1", accessToken: "old", refreshToken: "r", expiresAt: 1 });
    const f = vi.fn(async () => new Response(JSON.stringify({ access_token: "new", expires_in: 3600 }), { status: 200 }));
    expect(await getAccessToken(db, { encKey: KEY, clientId: "id", clientSecret: "s", fetch: f as unknown as typeof fetch }, id)).toBe("new");
    expect(await getAccessToken(db, { encKey: KEY, clientId: "id", clientSecret: "s", fetch: f as unknown as typeof fetch }, id)).toBe("new");
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("disconnect revokes the grant and deletes everything stored", async () => {
    const db = testDb();
    const id = upsertUserFromSignIn(db, { encKey: KEY }, { sub: "g1", accessToken: "a", refreshToken: "r", expiresAt: 2_000_000_000 });
    const laneId = createLane(db, id, { name: "X" });
    addChannel(db, id, "UC" + "z".repeat(22), laneId);
    recordSignal(db, id, { videoId: "abcdefghijk", kind: "click" });
    reserveUnits(db, { daily: 100, reserve: 0 }, { method: "videos.list", userId: id });
    const f = vi.fn(async () => new Response("", { status: 200 }));
    expect(await disconnectUser(db, { encKey: KEY, clientId: "id", clientSecret: "s", fetch: f as unknown as typeof fetch }, id)).toEqual({ revoked: true });
    expect(String((f.mock.calls[0] as unknown[])[0])).toBe("https://oauth2.googleapis.com/revoke");
    expect(db.select().from(users).all()).toHaveLength(0);
    expect(db.select().from(lanesTable).all()).toHaveLength(0);
    expect(db.select().from(signals).all()).toHaveLength(0);
    // The quota ledger is project-wide and has no personal data beyond the id; keep it so limits hold.
    expect(db.select().from(quotaLog).all()).toHaveLength(1);
  });

  it("deleting a lane removes its cached feed", async () => {
    const db = testDb();
    const userId = addUser(db);
    const laneId = createLane(db, userId, { name: "X" });
    db.insert(feedItems)
      .values({ userId, laneId, videoId: "abcdefghijk", title: "t", channelId: "c", channelTitle: "c", thumbUrl: "u", publishedAt: 1, source: "search", fetchedAt: 1 })
      .run();
    deleteLane(db, userId, laneId);
    expect(db.select().from(feedItems).all()).toHaveLength(0);
  });
});

describe("http guards", () => {
  const req = (headers: Record<string, string>) => new Request("http://localhost:3000/api/lanes", { method: "POST", headers });

  it("requires the app header and a same-origin Origin", () => {
    expect(checkCsrf(req({ host: "localhost:3000", origin: "http://localhost:3000", "x-rabbithole": "1" }))).toBe(true);
    expect(checkCsrf(req({ host: "localhost:3000", origin: "http://localhost:3000" }))).toBe(false);
    expect(checkCsrf(req({ host: "localhost:3000", origin: "https://evil.example", "x-rabbithole": "1" }))).toBe(false);
    expect(checkCsrf(req({ host: "localhost:3000", "x-rabbithole": "1" }))).toBe(false);
  });

  it("rate limits per key", () => {
    const t = 1_000_000;
    const results = Array.from({ length: 7 }, () => rateLimit("k", 60, 5, t));
    expect(results.filter(Boolean)).toHaveLength(5);
    expect(rateLimit("k", 60, 5, t + 2_000)).toBe(true);
  });

  it("CSP allows only YouTube image and player hosts", () => {
    const csp = buildCsp("abc", false);
    expect(csp).toContain("img-src 'self' data: https://i.ytimg.com https://*.ytimg.com https://yt3.ggpht.com;");
    expect(csp).toContain("frame-src https://www.youtube.com https://www.youtube-nocookie.com;");
    expect(csp).toContain("script-src 'self' 'nonce-abc' 'strict-dynamic'");
    expect(csp).not.toContain("unsafe-eval");
  });
});
