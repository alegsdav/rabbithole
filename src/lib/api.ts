/** Browser-side calls to the app's own API. Every request carries the CSRF header. */

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
  ) {
    super(message);
  }
}

export async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(path, {
    method: init.method ?? (init.body === undefined ? "GET" : "POST"),
    headers: { "x-rabbithole": "1", ...(init.body === undefined ? {} : { "Content-Type": "application/json" }) },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    credentials: "same-origin",
    cache: "no-store",
  });
  const data = (await res.json().catch(() => ({}))) as { error?: string; code?: string };
  if (!res.ok) throw new ApiError(res.status, data.error ?? `Request failed (${res.status})`, data.code);
  return data as T;
}
