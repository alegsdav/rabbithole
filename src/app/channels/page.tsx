import Link from "next/link";

import { ChannelsClient } from "@/components/ChannelsClient";
import { ctx } from "@/server/context";
import { laneBriefs, listChannels } from "@/server/lanes";
import { requireUserId } from "@/lib/session";

export default async function ChannelsPage() {
  const userId = await requireUserId();
  const c = ctx();
  return (
    <main className="mx-auto w-full max-w-3xl px-4 py-8">
      <Link href="/" className="text-sm text-muted underline">
        Back to lanes
      </Link>
      <h1 className="mt-4 text-2xl font-bold">Channels</h1>
      <p className="mt-1 text-sm text-muted">
        Claude filed each subscription into a lane from its title and description. Change any of them; your choice sticks when subscriptions are re-synced.
      </p>
      <ChannelsClient channels={listChannels(c.db, userId)} lanes={laneBriefs(c.db, userId)} />
    </main>
  );
}
