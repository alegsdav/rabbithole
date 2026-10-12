import { z } from "zod";

import { ctx } from "@/server/context";
import { assignChannel, laneBriefs, listChannels, ownsLane } from "@/server/lanes";
import { HttpError, route } from "@/server/http";

export const GET = route({ name: "channels:list", perMinute: 60 }, async ({ userId }) => {
  const c = ctx();
  return { channels: listChannels(c.db, userId), lanes: laneBriefs(c.db, userId) };
});

export const PATCH = route(
  { name: "channels:assign", perMinute: 120, body: z.object({ channelId: z.string().regex(/^UC[\w-]{22}$/), laneId: z.uuid().nullable() }) },
  async ({ userId, body }) => {
    const c = ctx();
    if (body.laneId && !ownsLane(c.db, userId, body.laneId)) throw new HttpError(404, "Lane not found");
    assignChannel(c.db, userId, body.channelId, body.laneId);
    return { ok: true };
  },
);
