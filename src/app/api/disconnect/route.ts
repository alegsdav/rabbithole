import { signOut } from "@/auth";
import { ctx } from "@/server/context";
import { env } from "@/server/env";
import { route } from "@/server/http";
import { disconnectUser } from "@/server/tokens";

/** Revokes the Google grant, deletes every row stored for the user, and ends the session. */
export const POST = route({ name: "disconnect", perMinute: 5 }, async ({ userId }) => {
  const e = env();
  const result = await disconnectUser(ctx().db, { encKey: e.TOKEN_ENC_KEY, clientId: e.AUTH_GOOGLE_ID, clientSecret: e.AUTH_GOOGLE_SECRET }, userId);
  await signOut({ redirect: false });
  return result;
});
