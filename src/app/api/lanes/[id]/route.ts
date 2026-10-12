import { z } from "zod";

import { LANE_COLORS } from "@/shared/types";
import { ctx } from "@/server/context";
import { deleteLane, ownsLane, updateLane } from "@/server/lanes";
import { HttpError, route } from "@/server/http";

const params = z.object({ id: z.uuid() });

export const PATCH = route(
  {
    name: "lanes:update",
    perMinute: 60,
    params,
    body: z
      .object({
        name: z.string().trim().min(1).max(40).optional(),
        description: z.string().trim().max(300).optional(),
        color: z.enum(LANE_COLORS).optional(),
      })
      .refine((b) => Object.keys(b).length > 0, "Nothing to change"),
  },
  async ({ userId, params, body }) => {
    if (!ownsLane(ctx().db, userId, params.id)) throw new HttpError(404, "Lane not found");
    updateLane(ctx().db, userId, params.id, body);
    return { ok: true };
  },
);

export const DELETE = route({ name: "lanes:delete", perMinute: 30, params }, async ({ userId, params }) => {
  if (!ownsLane(ctx().db, userId, params.id)) throw new HttpError(404, "Lane not found");
  deleteLane(ctx().db, userId, params.id);
  return { ok: true };
});
