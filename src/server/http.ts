import "server-only";
import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";

import { auth } from "@/auth";
import { db } from "./db/client";
import { users } from "./db/schema";
import { isAuthConfigured } from "./env";
import { LlmUnavailableError } from "./llm";
import { QuotaError } from "./quota";
import { AuthExpiredError } from "./tokens";
import { YouTubeError } from "./youtube";

export { CSRF_HEADER, checkCsrf, rateLimit } from "./guards";
import { checkCsrf, rateLimit } from "./guards";

// ---------------------------------------------------------------- route wrapper

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

type Handler<B, P> = (args: { userId: string; body: B; params: P; req: Request }) => Promise<unknown>;

/**
 * Every API route goes through here: configured check, session, CSRF,
 * rate limit, zod validation of the body and params, and error mapping.
 */
export function route<B = undefined, P = Record<string, never>>(
  opts: { body?: z.ZodType<B>; params?: z.ZodType<P>; perMinute?: number; name: string },
  handler: Handler<B, P>,
) {
  return async (req: Request, context: { params: Promise<unknown> }) => {
    try {
      if (!isAuthConfigured()) throw new HttpError(503, "The server is not configured yet. See README setup.");
      if (!checkCsrf(req)) throw new HttpError(403, "Cross-site request refused");
      const session = await auth();
      const userId = session?.user?.id;
      if (!userId || !db().select({ id: users.id }).from(users).where(eq(users.id, userId)).get()) {
        throw new HttpError(401, "Sign in first");
      }
      if (!rateLimit(`${userId}:${opts.name}`, opts.perMinute ?? 60, Math.max(5, Math.ceil((opts.perMinute ?? 60) / 2)))) {
        throw new HttpError(429, "Too many requests; slow down");
      }
      const params = opts.params ? opts.params.parse(await context.params) : ({} as P);
      let body = undefined as B;
      if (opts.body) {
        const raw = req.method === "GET" ? Object.fromEntries(new URL(req.url).searchParams) : await req.json().catch(() => null);
        body = opts.body.parse(raw);
      }
      const result = await handler({ userId, body, params, req });
      return NextResponse.json(result ?? { ok: true }, { headers: { "Cache-Control": "no-store" } });
    } catch (err) {
      return errorResponse(err);
    }
  };
}

export function errorResponse(err: unknown) {
  const json = (status: number, error: string, extra: Record<string, unknown> = {}) =>
    NextResponse.json({ error, ...extra }, { status, headers: { "Cache-Control": "no-store" } });
  if (err instanceof HttpError) return json(err.status, err.message);
  if (err instanceof z.ZodError) return json(400, "Invalid request", { issues: err.issues.map((i) => i.message).slice(0, 5) });
  if (err instanceof QuotaError) return json(429, "Daily YouTube quota is nearly used up; try again after midnight Pacific.", { code: "quota" });
  if (err instanceof AuthExpiredError) return json(401, err.message, { code: "reauth" });
  if (err instanceof LlmUnavailableError) return json(503, "Routing is unavailable; pick a lane.", { code: "llm" });
  if (err instanceof YouTubeError) return json(502, `YouTube: ${err.message}`, { code: err.reason });
  console.error(err);
  return json(500, "Something went wrong");
}
