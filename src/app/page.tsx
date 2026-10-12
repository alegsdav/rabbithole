import { eq } from "drizzle-orm";
import { connection } from "next/server";

import { auth, signIn } from "@/auth";
import { Home, Logo } from "@/components/Home";
import { db } from "@/server/db/client";
import { users } from "@/server/db/schema";
import { isAuthConfigured } from "@/server/env";
import { listLanes } from "@/server/lanes";

export default async function Page({ searchParams }: PageProps<"/">) {
  // Per-request: the session, the CSP nonce and the user's cached lanes.
  await connection();
  if (!isAuthConfigured()) return <SetupNeeded />;

  const session = await auth();
  const userId = session?.user?.id;
  const known = userId ? db().select({ id: users.id }).from(users).where(eq(users.id, userId)).get() : undefined;
  if (!userId || !known) {
    const { error } = await searchParams;
    return <Landing error={typeof error === "string" ? error : undefined} />;
  }

  // Rendered straight from the SQLite cache: no YouTube calls on this path.
  return <Home initialLanes={listLanes(db(), userId)} userName={session.user.name ?? null} />;
}

function Landing({ error }: { error?: string }) {
  return (
    <main className="mx-auto flex min-h-full max-w-xl flex-1 flex-col items-center justify-center gap-6 px-6 py-16 text-center">
      <div className="flex items-center gap-3 text-3xl font-bold tracking-tight">
        <Logo />
        Rabbithole
      </div>
      <p className="text-lg text-muted">
        YouTube as one home screen of lanes: one per interest, each ranked on its own, so one weekend binge can&apos;t bury everything else.
      </p>
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error === "scope" ? "Rabbithole needs read-only access to your YouTube account. Please allow it on the Google screen." : "Sign-in didn't complete. Try again."}
        </p>
      )}
      <form
        action={async () => {
          "use server";
          await signIn("google", { redirectTo: "/" });
        }}
      >
        <button type="submit" className="rounded-full bg-fg px-6 py-3 font-medium text-bg">
          Sign in with Google
        </button>
      </form>
      <p className="max-w-md text-xs text-muted">
        Read-only access (youtube.readonly) to your subscriptions. Tokens stay encrypted on this server and are never sent to your browser. You can disconnect and delete everything at any time in Settings.
      </p>
    </main>
  );
}

function SetupNeeded() {
  return (
    <main className="mx-auto max-w-2xl px-6 py-16">
      <h1 className="text-2xl font-bold">Rabbithole needs configuration</h1>
      <p className="mt-3 text-muted">
        Copy <code>.env.example</code> to <code>.env.local</code> and fill in the Google OAuth client, <code>AUTH_SECRET</code>, <code>TOKEN_ENC_KEY</code> and{" "}
        <code>GEMINI_API_KEY</code> / <code>GEMINI_MODEL</code>, then restart the server. The README walks through creating the Google OAuth client in Testing mode.
      </p>
    </main>
  );
}
