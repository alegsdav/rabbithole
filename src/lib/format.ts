export function formatDuration(sec: number | null, isLive = false): string | null {
  if (isLive) return "LIVE";
  if (sec === null) return null;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

export function formatViews(n: number | null): string | null {
  if (n === null) return null;
  const fmt = (v: number, unit: string) => `${v >= 10 ? Math.floor(v) : Math.floor(v * 10) / 10}${unit}`;
  if (n >= 1e9) return `${fmt(n / 1e9, "B")} views`;
  if (n >= 1e6) return `${fmt(n / 1e6, "M")} views`;
  if (n >= 1e3) return `${fmt(n / 1e3, "K")} views`;
  return `${n} view${n === 1 ? "" : "s"}`;
}

export function formatAge(at: number, now = Date.now()): string {
  const s = Math.max(0, (now - at) / 1000);
  const units: [number, string][] = [
    [365 * 86400, "year"],
    [30 * 86400, "month"],
    [7 * 86400, "week"],
    [86400, "day"],
    [3600, "hour"],
    [60, "minute"],
  ];
  for (const [size, name] of units) {
    if (s >= size) {
      const n = Math.floor(s / size);
      return `${n} ${name}${n === 1 ? "" : "s"} ago`;
    }
  }
  return "just now";
}
