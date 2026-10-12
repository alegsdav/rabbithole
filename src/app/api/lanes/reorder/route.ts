import { z } from "zod";

import { ctx } from "@/server/context";
import { reorderLanes } from "@/server/lanes";
import { route } from "@/server/http";

export const POST = route({ name: "lanes:reorder", perMinute: 60, body: z.object({ ids: z.array(z.uuid()).max(50) }) }, async ({ userId, body }) => {
  reorderLanes(ctx().db, userId, body.ids);
  return { ok: true };
});
