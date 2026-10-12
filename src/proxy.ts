import { NextResponse, type NextRequest } from "next/server";

/**
 * A strict, per-request Content Security Policy. Images may come only from
 * YouTube's image hosts and frames only from the YouTube player; scripts need
 * this request's nonce (the IFrame API script is loaded by the app's own,
 * nonce-trusted code, which 'strict-dynamic' allows).
 */
export function buildCsp(nonce: string, isDev: boolean, isHttps = !isDev): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic' https://www.youtube.com${isDev ? " 'unsafe-eval'" : ""}`,
    // Dev tooling injects unnonced <style> tags, and a nonce would disable 'unsafe-inline'.
    isDev ? "style-src 'self' 'unsafe-inline'" : `style-src 'self' 'nonce-${nonce}'`,
    "style-src-attr 'unsafe-inline'",
    "img-src 'self' data: https://i.ytimg.com https://*.ytimg.com https://yt3.ggpht.com",
    "frame-src https://www.youtube.com https://www.youtube-nocookie.com",
    "connect-src 'self'",
    "font-src 'self'",
    "media-src 'none'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self' https://accounts.google.com",
    "frame-ancestors 'none'",
    // Only over HTTPS: on plain-http localhost some browsers (Safari) would upgrade same-origin requests too.
    ...(isHttps ? ["upgrade-insecure-requests"] : []),
  ].join("; ");
}

export function proxy(request: NextRequest) {
  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  const isHttps = request.nextUrl.protocol === "https:" || request.headers.get("x-forwarded-proto") === "https";
  const csp = buildCsp(nonce, process.env.NODE_ENV === "development", isHttps);

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", csp);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("Content-Security-Policy", csp);
  return response;
}

export const config = {
  matcher: [
    {
      source: "/((?!api|_next/static|_next/image|favicon.ico).*)",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
  ],
};
