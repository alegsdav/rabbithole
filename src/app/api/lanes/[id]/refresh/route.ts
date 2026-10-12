import { z } from "zod";

import { ctx } from "@/server/context";
import { laneItems, getSettings, ownsLane, refreshLane } from "@/server/lanes";
import { HttpError, route } from "@/server/http";

export const POST = route({ name: "lanes:refresh", perMinute: 10, params: z.object({ id: z.uuid() }) }, async ({ userId, params }) => {
  const c = ctx();
  if (!ownsLane(c.db, userId, params.id)) throw new HttpError(404, "Lane not found");
  const result = await refreshLane(c, userId, params.id, { interactive: true });
  return { result, ...laneItems(c.db, userId, params.id, 0, undefined, getSettings(c.db, userId).hideShorts) };
});
