import "server-only";
import { eq } from "drizzle-orm";
import { z } from "zod";

import { decrypt, encrypt } from "./crypto";
import type { Db } from "./db/client";
import { users } from "./db/schema";

export const YOUTUBE_SCOPE = "https://www.googleapis.com/auth/youtube.readonly";

export class AuthExpiredError extends Error {
  constructor() {
    super("Google access has expired or was revoked. Sign in again.");
    this.name = "AuthExpiredError";
  }
}

export type TokenConfig = { encKey: string; clientId: string; clientSecret: string; fetch?: typeof fetch };

/** Stores the tokens from a fresh Google sign-in, sealed; returns the user id. */
export function upsertUserFromSignIn(
  db: Db,
  cfg: Pick<TokenConfig, "encKey">,
  input: {
    sub: string;
    email?: string | null;
    name?: string | null;
    image?: string | null;
    accessToken?: string;
    refreshToken?: string;
    expiresAt?: number; // seconds since epoch, as Google returns it
    scope?: string;
  },
): string {
  const existing = db.select({ id: users.id }).from(users).where(eq(users.googleSub, input.sub)).get();
  const sealed = {
    email: input.email ?? null,
    name: input.name ?? null,
    image: input.image ?? null,
    scope: input.scope ?? null,
    ...(input.accessToken ? { accessTokenEnc: encrypt(input.accessToken, cfg.encKey) } : {}),
    // Google sends a refresh token only on consent; keep the old one otherwise.
    ...(input.refreshToken ? { refreshTokenEnc: encrypt(input.refreshToken, cfg.encKey) } : {}),
    ...(input.expiresAt ? { tokenExpiresAt: input.expiresAt * 1000 } : {}),
  };
  if (existing) {
    db.update(users).set(sealed).where(eq(users.id, existing.id)).run();
    return existing.id;
  }
  const id = crypto.randomUUID();
  db.insert(users).values({ id, googleSub: input.sub, ...sealed }).run();
  return id;
}

const refreshResponse = z.object({ access_token: z.string(), expires_in: z.number(), scope: z.string().optional() });

/** A valid access token for the user, refreshing it with the stored refresh token when needed. */
export async function getAccessToken(db: Db, cfg: TokenConfig, userId: string, force = false): Promise<string> {
  const user = db.select().from(users).where(eq(users.id, userId)).get();
  if (!user) throw new AuthExpiredError();
  const fresh = user.accessTokenEnc && user.tokenExpiresAt && user.tokenExpiresAt - Date.now() > 60_000;
  if (fresh && !force) return decrypt(user.accessTokenEnc!, cfg.encKey);
  if (!user.refreshTokenEnc) throw new AuthExpiredError();

  const res = await (cfg.fetch ?? fetch)("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: decrypt(user.refreshTokenEnc, cfg.encKey),
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
    }),
  });
  if (!res.ok) throw new AuthExpiredError();
  const body = refreshResponse.parse(await res.json());
  db.update(users)
    .set({ accessTokenEnc: encrypt(body.access_token, cfg.encKey), tokenExpiresAt: Date.now() + body.expires_in * 1000 })
    .where(eq(users.id, userId))
    .run();
  return body.access_token;
}

/** Revokes Google access and deletes the user and everything stored for them. */
export async function disconnectUser(db: Db, cfg: TokenConfig, userId: string): Promise<{ revoked: boolean }> {
  const user = db.select().from(users).where(eq(users.id, userId)).get();
  let revoked = false;
  const sealed = user?.refreshTokenEnc ?? user?.accessTokenEnc;
  if (sealed) {
    try {
      const res = await (cfg.fetch ?? fetch)("https://oauth2.googleapis.com/revoke", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token: decrypt(sealed, cfg.encKey) }),
      });
      revoked = res.ok;
    } catch {
      revoked = false;
    }
  }
  // Cascades to lanes, channel_lanes, feed_items, signals, corrections and the search cache.
  db.delete(users).where(eq(users.id, userId)).run();
  return { revoked };
}
