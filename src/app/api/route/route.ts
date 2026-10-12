import { z } from "zod";

import { ctx } from "@/server/context";
import { routeSearch } from "@/server/router";
import { route } from "@/server/http";

/** Decides which lane a submitted search belongs in. Called only on Enter. */
export const POST = route({ name: "route", perMinute: 30, body: z.object({ query: z.string().trim().min(1).max(200) }) }, async ({ userId, body }) => ({
  decision: await routeSearch(ctx(), userId, body.query),
}));
