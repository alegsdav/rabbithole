/**
 * DO FIRST: checks against the owner's real account, after signing in once in the app.
 * Run: npm run check:youtube
 *
 * 1. youtube.readonly works: the stored token reads the subscription list.
 * 2. Channel-to-lane classification on the real subscriptions (prints every assignment).
 * 3. Quota units per lane refresh, measured from the quota ledger (first and second refresh).
 */
import { ctx } from "../src/server/context";
import { users } from "../src/server/db/schema";
import { laneBriefs, listChannels, refreshLane, setupLanes } from "../src/server/lanes";
import { quotaSummary } from "../src/server/quota";

async function main() {
  const c = ctx();
  const user = c.db.select().from(users).get();
  if (!user) {
    console.error("No signed-in user yet. Start the app (npm run dev), sign in with Google, then rerun.");
    process.exitCode = 1;
    return;
  }
  console.log(`User: ${user.email}  scope: ${user.scope}`);

  const report = await setupLanes(c, user.id);
  console.log(`\n1. OAuth OK. Subscriptions: ${report.sync.total} (+${report.sync.added} new, -${report.sync.removed} removed)`);

  const lanes = laneBriefs(c.db, user.id);
  const channels = listChannels(c.db, user.id);
  console.log(`\n2. Classification: ${lanes.length} lanes, ${report.assigned}/${report.classified} newly assigned`);
  for (const lane of lanes) {
    const mine = channels.filter((ch) => ch.laneId === lane.id);
    console.log(`\n  ${lane.name} (${mine.length})  ${lane.description}`);
    for (const ch of mine) console.log(`    - ${ch.title}${ch.source === "user" ? "  [corrected]" : ""}`);
  }
  const loose = channels.filter((ch) => !ch.laneId);
  if (loose.length) console.log(`\n  Unassigned (${loose.length}): ${loose.map((ch) => ch.title).join(", ")}`);

  console.log("\n3. Quota per lane refresh");
  for (const lane of lanes) {
    const first = await refreshLane(c, user.id, lane.id, { interactive: true });
    const second = await refreshLane(c, user.id, lane.id, { interactive: true });
    console.log(`  ${lane.name.padEnd(24)} first ${String(first.units).padStart(4)} units, cached-search refresh ${String(second.units).padStart(3)} units, ${first.items} videos${first.error ? `  ERROR ${first.error}` : ""}`);
  }
  const q = quotaSummary(c.db, c.limits);
  console.log(`\nQuota today (${q.day}): ${q.used}/${q.daily} units used`);
}

void main();
