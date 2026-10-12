import { ctx } from "@/server/context";
import { quotaSummary } from "@/server/quota";
import { route } from "@/server/http";

export const GET = route({ name: "quota", perMinute: 60 }, async () => quotaSummary(ctx().db, ctx().limits));
