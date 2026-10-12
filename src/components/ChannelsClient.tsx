"use client";

import { useMemo, useState } from "react";

import { api } from "@/lib/api";

type Channel = { channelId: string; title: string; description: string; thumbUrl: string | null; laneId: string | null; source: "llm" | "user" };
type LaneBrief = { id: string; name: string; color: string };

export function ChannelsClient({ channels: initial, lanes }: { channels: Channel[]; lanes: LaneBrief[] }) {
  const [channels, setChannels] = useState(initial);
  const [filter, setFilter] = useState("");
  const shown = useMemo(() => {
    const f = filter.trim().toLowerCase();
    return f ? channels.filter((c) => c.title.toLowerCase().includes(f)) : channels;
  }, [channels, filter]);

  if (channels.length === 0) {
    return <p className="mt-6 text-sm text-muted">No subscriptions imported yet. Set up lanes from the home screen first.</p>;
  }

  return (
    <div className="mt-6">
      <label className="flex flex-col gap-1 text-sm">
        Filter channels
        <input type="search" value={filter} onChange={(e) => setFilter(e.target.value)} className="rounded-md border border-border bg-bg px-2 py-1.5" />
      </label>
      <ul className="mt-4 divide-y divide-border">
        {shown.map((ch) => (
          <li key={ch.channelId} className="flex items-center gap-3 py-3">
            {ch.thumbUrl ? (
              // eslint-disable-next-line @next/next/no-img-element -- channel avatars come from yt3.ggpht.com
              <img src={ch.thumbUrl} alt="" width={36} height={36} loading="lazy" referrerPolicy="no-referrer" className="h-9 w-9 rounded-full bg-subtle" />
            ) : (
              <span className="h-9 w-9 rounded-full bg-subtle" aria-hidden="true" />
            )}
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">{ch.title}</p>
              <p className="truncate text-xs text-muted">{ch.source === "user" ? "Filed by you" : "Filed by Claude"}</p>
            </div>
            <label className="sr-only" htmlFor={`lane-${ch.channelId}`}>
              Lane for {ch.title}
            </label>
            <select
              id={`lane-${ch.channelId}`}
              value={ch.laneId ?? ""}
              onChange={async (e) => {
                const laneId = e.target.value || null;
                const prev = channels;
                setChannels((cs) => cs.map((c) => (c.channelId === ch.channelId ? { ...c, laneId, source: "user" } : c)));
                await api("/api/channels", { method: "PATCH", body: { channelId: ch.channelId, laneId } }).catch(() => setChannels(prev));
              }}
              className="rounded-md border border-border bg-bg px-2 py-1.5 text-sm"
            >
              <option value="">No lane</option>
              {lanes.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </select>
          </li>
        ))}
      </ul>
    </div>
  );
}
