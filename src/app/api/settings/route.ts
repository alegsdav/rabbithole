import { z } from "zod";

import { ctx } from "@/server/context";
import { getSettings, setSettings } from "@/server/lanes";
import { route } from "@/server/http";

export const GET = route({ name: "settings:get", perMinute: 60 }, async ({ userId }) => getSettings(ctx().db, userId));

export const PUT = route({ name: "settings:set", perMinute: 30, body: z.object({ hideShorts: z.boolean() }) }, async ({ userId, body }) => {
  setSettings(ctx().db, userId, body);
  return body;
});
