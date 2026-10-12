import "server-only";
import { eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import { connection } from "next/server";

import { auth } from "@/auth";
import { db } from "@/server/db/client";
import { users } from "@/server/db/schema";
import { isAuthConfigured } from "@/server/env";

/** The signed-in user's id for a page, or a redirect home. */
export async function requireUserId(): Promise<string> {
  await connection();
  if (!isAuthConfigured()) redirect("/");
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId || !db().select({ id: users.id }).from(users).where(eq(users.id, userId)).get()) redirect("/");
  return userId;
}
