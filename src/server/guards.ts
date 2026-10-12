import "server-only";

/** Header every mutating request from the app sends; a cross-site form or image can't set it. */
export const CSRF_HEADER = "x-rabbithole";

// ---------------------------------------------------------------- rate limiting

type Bucket = { tokens: number; updated: number };
const buckets = new Map<string, Bucket>();

/** Token bucket per key: `perMinute` sustained, bursts up to `burst`. */
export function rateLimit(key: string, perMinute: number, burst = perMinute, now = Date.now()): boolean {
  const b = buckets.get(key) ?? { tokens: burst, updated: now };
  b.tokens = Math.min(burst, b.tokens + ((now - b.updated) / 60_000) * perMinute);
  b.updated = now;
  if (b.tokens < 1) {
    buckets.set(key, b);
    return false;
  }
  b.tokens -= 1;
  buckets.set(key, b);
  if (buckets.size > 10_000) buckets.clear();
  return true;
}

// ---------------------------------------------------------------- CSRF

/** Same-origin check on Origin (or Referer) plus the custom header. */
export function checkCsrf(req: Request): boolean {
  if (req.method === "GET" || req.method === "HEAD") return true;
  if (req.headers.get(CSRF_HEADER) !== "1") return false;
  const origin = req.headers.get("origin") ?? (req.headers.get("referer") ? new URL(req.headers.get("referer")!).origin : null);
  if (!origin) return false;
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}
