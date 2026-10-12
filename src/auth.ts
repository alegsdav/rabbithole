import NextAuth from "next-auth";
import Google from "next-auth/providers/google";

import { db } from "@/server/db/client";
import { YOUTUBE_SCOPE, upsertUserFromSignIn } from "@/server/tokens";

declare module "next-auth" {
  interface Session {
    user: { id: string; name?: string | null; email?: string | null; image?: string | null };
  }
}

/**
 * Google sign-in (authorization code flow) with the read-only YouTube scope.
 * The session is an encrypted, httpOnly JWT cookie that carries only the user
 * id; Google tokens are sealed in the database and never reach the browser.
 */
export const { handlers, auth, signIn, signOut } = NextAuth({
  trustHost: true,
  session: { strategy: "jwt", maxAge: 30 * 24 * 60 * 60 },
  pages: { signIn: "/" },
  providers: [
    Google({
      clientId: process.env.AUTH_GOOGLE_ID,
      clientSecret: process.env.AUTH_GOOGLE_SECRET,
      authorization: {
        params: {
          scope: `openid email profile ${YOUTUBE_SCOPE}`,
          access_type: "offline",
          prompt: "consent",
          include_granted_scopes: "true",
        },
      },
    }),
  ],
  callbacks: {
    async signIn({ account }) {
      // Without the YouTube scope there is nothing to show; send them back to grant it.
      return account?.provider !== "google" || (account.scope ?? "").includes(YOUTUBE_SCOPE) ? true : "/?error=scope";
    },
    async jwt({ token, account, profile }) {
      if (account?.provider === "google" && profile?.sub) {
        const encKey = process.env.TOKEN_ENC_KEY;
        if (!encKey) throw new Error("TOKEN_ENC_KEY is not set");
        token.uid = upsertUserFromSignIn(db(), { encKey }, {
          sub: profile.sub,
          email: profile.email,
          name: profile.name,
          image: typeof profile.picture === "string" ? profile.picture : null,
          accessToken: account.access_token,
          refreshToken: account.refresh_token,
          expiresAt: account.expires_at,
          scope: account.scope,
        });
      }
      return token;
    },
    async session({ session, token }) {
      if (typeof token.uid === "string") session.user.id = token.uid;
      return session;
    },
  },
});
