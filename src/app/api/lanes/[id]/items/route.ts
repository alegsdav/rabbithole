import { z } from "zod";

import { ctx } from "@/server/context";
import { getSettings, laneItems, ownsLane } from "@/server/lanes";
import { HttpError, route } from "@/server/http";
import { PAGE_SIZE } from "@/shared/types";

/** The next page of a lane, read from the cache only (no API calls). */
export const GET = route(
  { name: "lanes:items", perMinute: 240, params: z.object({ id: z.uuid() }), body: z.object({ offset: z.coerce.number().int().min(0).max(1000) }) },
  async ({ userId, params, body }) => {
    const c = ctx();
    if (!ownsLane(c.db, userId, params.id)) throw new HttpError(404, "Lane not found");
    return laneItems(c.db, userId, params.id, body.offset, PAGE_SIZE, getSettings(c.db, userId).hideShorts);
  },
);
