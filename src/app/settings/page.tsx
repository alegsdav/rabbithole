import Link from "next/link";

import { ctx } from "@/server/context";
import { getSettings, laneBriefs, unassignedChannelCount } from "@/server/lanes";
import { quotaSummary } from "@/server/quota";
import { requireUserId } from "@/lib/session";
import { SettingsClient } from "@/components/SettingsClient";

export default async function SettingsPage() {
  const userId = await requireUserId();
  const c = ctx();
  const q = quotaSummary(c.db, c.limits);
  return (
    <main className="mx-auto w-full max-w-2xl px-4 py-8">
      <Link href="/" className="text-sm text-muted underline">
        Back to lanes
      </Link>
      <h1 className="mt-4 text-2xl font-bold">Settings</h1>
      <SettingsClient
        initial={getSettings(c.db, userId)}
        quota={{ day: q.day, used: q.used, daily: q.daily, reserve: q.reserve, remaining: q.remaining }}
        laneCount={laneBriefs(c.db, userId).length}
        unassigned={unassignedChannelCount(c.db, userId)}
      />
    </main>
  );
}
