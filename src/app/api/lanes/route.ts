import { z } from "zod";

import { LANE_COLORS } from "@/shared/types";
import { ctx } from "@/server/context";
import { createLane, listLanes, refreshLane } from "@/server/lanes";
import { recordCorrection } from "@/server/router";
import { route } from "@/server/http";

export const GET = route({ name: "lanes:list", perMinute: 120 }, async ({ userId }) => ({ lanes: listLanes(ctx().db, userId) }));

const createBody = z.object({
  name: z.string().trim().min(1).max(40),
  description: z.string().trim().max(300).default(""),
  color: z.enum(LANE_COLORS).optional(),
  /** Set when the lane comes from a confirmed router proposal for this query. */
  fromQuery: z.string().trim().min(1).max(200).optional(),
});

/** Creates a lane: only ever on an explicit user action (a router proposal is confirmed here). */
export const POST = route({ name: "lanes:create", perMinute: 20, body: createBody }, async ({ userId, body }) => {
  const c = ctx();
  const id = createLane(c.db, userId, {
    name: body.name,
    description: body.description,
    color: body.color,
    createdBy: body.fromQuery ? "router" : "user",
  });
  if (body.fromQuery) {
    recordCorrection(c, userId, body.fromQuery, id);
  } else {
    await refreshLane(c, userId, id, { interactive: true });
  }
  return { id };
});
