import { z } from "zod";

import { ctx } from "@/server/context";
import { ownsLane, searchInLane } from "@/server/lanes";
import { recordCorrection } from "@/server/router";
import { HttpError, route } from "@/server/http";

/** Runs a search inside a lane. `corrected` marks a lane the user picked over the router's choice. */
export const POST = route(
  {
    name: "search",
    perMinute: 20,
    body: z.object({ query: z.string().trim().min(1).max(200), laneId: z.uuid(), corrected: z.boolean().default(false) }),
  },
  async ({ userId, body }) => {
    const c = ctx();
    if (!ownsLane(c.db, userId, body.laneId)) throw new HttpError(404, "Lane not found");
    if (body.corrected) recordCorrection(c, userId, body.query, body.laneId);
    return searchInLane(c, userId, body.laneId, body.query);
  },
);
