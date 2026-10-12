"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { api } from "@/lib/api";
import type { QuotaSummary } from "@/shared/types";

export function SettingsClient({
  initial,
  quota,
  laneCount,
  unassigned,
}: {
  initial: { hideShorts: boolean };
  quota: QuotaSummary;
  laneCount: number;
  unassigned: number;
}) {
  const router = useRouter();
  const [hideShorts, setHideShorts] = useState(initial.hideShorts);
  const [syncState, setSyncState] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const pct = Math.min(100, Math.round((quota.used / quota.daily) * 100));

  return (
    <div className="mt-6 flex flex-col gap-8">
      <section className="flex flex-col gap-2">
        <h2 className="font-semibold">Feed</h2>
        <label className="flex items-center gap-3 text-sm">
          <input
            type="checkbox"
            checked={hideShorts}
            onChange={async (e) => {
              const next = e.target.checked;
              setHideShorts(next);
              await api("/api/settings", { method: "PUT", body: { hideShorts: next } }).catch(() => setHideShorts(!next));
            }}
            className="h-4 w-4"
          />
          Hide videos shorter than 60 seconds (Shorts)
        </label>
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="font-semibold">Subscriptions</h2>
        <p className="text-sm text-muted">
          {laneCount} lanes. {unassigned} subscribed channel{unassigned === 1 ? " is" : "s are"} not in any lane.{" "}
          <Link href="/channels" className="underline">
            Review channels
          </Link>
        </p>
        <div>
          <button
            type="button"
            className="rounded-full border border-border px-4 py-2 text-sm hover:bg-subtle disabled:opacity-50"
            disabled={syncState === "Syncing…"}
            onClick={async () => {
              setSyncState("Syncing…");
              try {
                const res = await api<{ report: { sync: { added: number; removed: number }; assigned: number } }>("/api/setup", { body: {} });
                setSyncState(`Done: ${res.report.sync.added} new, ${res.report.sync.removed} removed, ${res.report.assigned} filed into lanes.`);
              } catch (err) {
                setSyncState(err instanceof Error ? err.message : "Sync failed");
              }
            }}
          >
            Re-sync subscriptions
          </button>
          {syncState && <p role="status" className="mt-2 text-sm text-muted">{syncState}</p>}
        </div>
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="font-semibold">YouTube API quota</h2>
        <div className="h-2 w-full overflow-hidden rounded-full bg-subtle" role="meter" aria-valuemin={0} aria-valuemax={quota.daily} aria-valuenow={quota.used} aria-label="Quota used today">
          <div className="h-full rounded-full bg-fg" style={{ width: `${pct}%` }} />
        </div>
        <p className="text-sm text-muted">
          {quota.used.toLocaleString()} of {quota.daily.toLocaleString()} units used today ({quota.day}, Pacific time). Background refreshes stop at {(quota.daily - quota.reserve).toLocaleString()} to keep room for searches; when quota runs low, lanes show their saved videos.
        </p>
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="font-semibold">About playback</h2>
        <p className="text-sm text-muted">
          Videos play in YouTube&apos;s embedded player. Embedded plays may not be added to your YouTube watch history; use “Open on YouTube” when you want a view to count there. Clicks, watch time and likes in Rabbithole only tune its own ranking and are never sent to YouTube.
        </p>
      </section>

      <section className="flex flex-col gap-2 rounded-2xl border border-border p-4">
        <h2 className="font-semibold">Disconnect</h2>
        <p className="text-sm text-muted">Revokes Rabbithole&apos;s access to your Google account and deletes your lanes, channels, saved videos, signals and search history from this server.</p>
        {!confirming ? (
          <div>
            <button type="button" className="rounded-full bg-danger px-4 py-2 text-sm font-medium text-on-danger" onClick={() => setConfirming(true)}>
              Disconnect and delete my data
            </button>
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm">This can&apos;t be undone.</span>
            <button
              type="button"
              disabled={disconnecting}
              className="rounded-full bg-danger px-4 py-2 text-sm font-medium text-on-danger disabled:opacity-50"
              onClick={async () => {
                setDisconnecting(true);
                try {
                  await api("/api/disconnect", { body: {} });
                } finally {
                  router.replace("/");
                  router.refresh();
                }
              }}
            >
              {disconnecting ? "Disconnecting…" : "Yes, disconnect"}
            </button>
            <button type="button" className="rounded-full px-4 py-2 text-sm hover:bg-subtle" onClick={() => setConfirming(false)}>
              Cancel
            </button>
          </div>
        )}
      </section>
    </div>
  );
}
