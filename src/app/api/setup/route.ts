import { ctx } from "@/server/context";
import { listLanes, refreshStaleLanes, setupLanes } from "@/server/lanes";
import { route } from "@/server/http";

/** Imports subscriptions, proposes lanes on first run, and files channels into lanes. */
export const POST = route({ name: "setup", perMinute: 2 }, async ({ userId }) => {
  const c = ctx();
  const report = await setupLanes(c, userId);
  const refreshed = await refreshStaleLanes(c, userId);
  return { report, refreshed, lanes: listLanes(c.db, userId) };
});
