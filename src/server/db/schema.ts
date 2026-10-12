import { sql } from "drizzle-orm";
import { index, integer, primaryKey, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

const now = sql`(unixepoch() * 1000)`;

export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  googleSub: text("google_sub").notNull().unique(),
  email: text("email"),
  name: text("name"),
  image: text("image"),
  /** AES-GCM sealed; never leaves the server. */
  accessTokenEnc: text("access_token_enc"),
  refreshTokenEnc: text("refresh_token_enc"),
  tokenExpiresAt: integer("token_expires_at"),
  scope: text("scope"),
  /** JSON: { hideShorts: boolean } */
  settings: text("settings").notNull().default('{"hideShorts":true}'),
  subscriptionsSyncedAt: integer("subscriptions_synced_at"),
  createdAt: integer("created_at").notNull().default(now),
});

export const lanes = sqliteTable(
  "lanes",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    color: text("color").notNull(),
    description: text("description").notNull().default(""),
    sortOrder: integer("sort_order").notNull(),
    /** JSON string[]: LLM-written search.list queries for this lane. */
    searchQueries: text("search_queries").notNull().default("[]"),
    lastRefreshedAt: integer("last_refreshed_at"),
    lastError: text("last_error"),
    createdBy: text("created_by", { enum: ["user", "router", "setup"] }).notNull().default("user"),
    createdAt: integer("created_at").notNull().default(now),
  },
  (t) => [index("lanes_user_idx").on(t.userId, t.sortOrder)],
);

/** Subscribed channels and which lane each belongs to (null = unassigned). */
export const channelLanes = sqliteTable(
  "channel_lanes",
  {
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    channelId: text("channel_id").notNull(),
    laneId: text("lane_id").references(() => lanes.id, { onDelete: "set null" }),
    title: text("title").notNull(),
    description: text("description").notNull().default(""),
    thumbUrl: text("thumb_url"),
    uploadsPlaylistId: text("uploads_playlist_id"),
    /** How the assignment was made: the LLM, or the user correcting it. */
    source: text("source", { enum: ["llm", "user"] }).notNull().default("llm"),
    updatedAt: integer("updated_at").notNull().default(now),
  },
  (t) => [primaryKey({ columns: [t.userId, t.channelId] }), index("channel_lanes_lane_idx").on(t.laneId)],
);

/** The cached feed: each video lives in exactly one lane per user. */
export const feedItems = sqliteTable(
  "feed_items",
  {
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    videoId: text("video_id").notNull(),
    laneId: text("lane_id").notNull().references(() => lanes.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    channelId: text("channel_id").notNull(),
    channelTitle: text("channel_title").notNull(),
    thumbUrl: text("thumb_url").notNull(),
    publishedAt: integer("published_at").notNull(),
    durationSec: integer("duration_sec"),
    viewCount: integer("view_count"),
    isLive: integer("is_live", { mode: "boolean" }).notNull().default(false),
    source: text("source", { enum: ["subscription", "search"] }).notNull(),
    score: real("score").notNull().default(0),
    fetchedAt: integer("fetched_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.videoId] }), index("feed_items_lane_idx").on(t.laneId, t.score)],
);

export const signals = sqliteTable(
  "signals",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    videoId: text("video_id").notNull(),
    channelId: text("channel_id"),
    laneId: text("lane_id"),
    kind: text("kind", { enum: ["click", "watch", "like"] }).notNull(),
    /** Seconds for watch; 1 for click and like. */
    value: real("value").notNull().default(1),
    createdAt: integer("created_at").notNull().default(now),
  },
  (t) => [index("signals_user_channel_idx").on(t.userId, t.channelId), index("signals_user_video_idx").on(t.userId, t.videoId)],
);

export const routingCorrections = sqliteTable("routing_corrections", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  query: text("query").notNull(),
  laneId: text("lane_id").notNull().references(() => lanes.id, { onDelete: "cascade" }),
  createdAt: integer("created_at").notNull().default(now),
});

/** Every YouTube Data API call, in units, keyed by the quota day (Pacific time). */
export const quotaLog = sqliteTable(
  "quota_log",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    day: text("day").notNull(),
    userId: text("user_id"),
    method: text("method").notNull(),
    units: integer("units").notNull(),
    purpose: text("purpose").notNull().default(""),
    createdAt: integer("created_at").notNull().default(now),
  },
  (t) => [index("quota_log_day_idx").on(t.day)],
);

/** search.list results, cached 24h per user + normalized query. */
export const searchCache = sqliteTable(
  "search_cache",
  {
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    queryKey: text("query_key").notNull(),
    /** JSON VideoCard[] */
    results: text("results").notNull(),
    fetchedAt: integer("fetched_at").notNull(),
  },
  (t) => [uniqueIndex("search_cache_key").on(t.userId, t.queryKey)],
);
