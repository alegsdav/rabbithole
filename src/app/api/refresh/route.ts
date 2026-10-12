import { ctx } from "@/server/context";
import { listLanes, refreshStaleLanes } from "@/server/lanes";
import { route } from "@/server/http";

/** Refreshes lanes older than 30 minutes, one at a time; the client calls this on load and on a timer. */
export const POST = route({ name: "refresh:stale", perMinute: 4 }, async ({ userId }) => {
  const c = ctx();
  const results = await refreshStaleLanes(c, userId);
  return { results, lanes: listLanes(c.db, userId) };
});
