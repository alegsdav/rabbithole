import { z } from "zod";

import { ctx } from "@/server/context";
import { recordSignal } from "@/server/lanes";
import { route } from "@/server/http";

const videoId = z.string().regex(/^[\w-]{11}$/);

/** Local ranking signals: a click, seconds watched in the player, or a like. Never sent to YouTube. */
export const POST = route(
  {
    name: "signals",
    perMinute: 240,
    body: z.object({
      videoId,
      kind: z.enum(["click", "watch", "like"]),
      value: z.number().min(0).max(21_600).optional(),
      laneId: z.uuid().nullable().optional(),
      channelId: z.string().max(64).nullable().optional(),
    }),
  },
  async ({ userId, body }) => {
    recordSignal(ctx().db, userId, body);
    return { ok: true };
  },
);
