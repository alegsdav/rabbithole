import "server-only";

import { db as appDb, type Db } from "./db/client";
import { env } from "./env";
import { makeClient, type LlmClient } from "./llm";
import type { QuotaLimits } from "./quota";
import { getAccessToken } from "./tokens";
import { YouTube } from "./youtube";

/** What the services need, injectable so tests can swap the network out. */
export type Ctx = {
  db: Db;
  limits: QuotaLimits;
  llm: { client: LlmClient };
  youtube: (userId: string, purpose: string, interactive?: boolean) => YouTube;
  now: () => number;
};

let cached: Ctx | null = null;

export function ctx(): Ctx {
  if (cached) return cached;
  const e = env();
  const database = appDb();
  const tokenCfg = { encKey: e.TOKEN_ENC_KEY, clientId: e.AUTH_GOOGLE_ID, clientSecret: e.AUTH_GOOGLE_SECRET };
  const limits = { daily: e.YT_DAILY_QUOTA, reserve: e.YT_QUOTA_RESERVE };
  cached = {
    db: database,
    limits,
    llm: { client: makeClient({ apiKey: e.GEMINI_API_KEY, model: e.GEMINI_MODEL }) },
    youtube: (userId, purpose, interactive = false) =>
      new YouTube({
        db: database,
        limits,
        userId,
        purpose,
        interactive,
        getAccessToken: (force) => getAccessToken(database, tokenCfg, userId, force),
      }),
    now: () => Date.now(),
  };
  return cached;
}
