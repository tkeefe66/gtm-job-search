import NextAuth from "next-auth";
import Google from "next-auth/providers/google";
import PostgresAdapter from "@auth/pg-adapter";
import type { Adapter } from "next-auth/adapters";
import { authPool } from "@/lib/supabase";
import { accessFor, sessionVerdict, resolveIdentity } from "@/lib/auth-policy";

/**
 * Google sign-in, database sessions, and the two rules Auth.js does not provide.
 *
 * Version-pinned EXACTLY (`next-auth@5.0.0-beta.32`, `@auth/pg-adapter@1.11.3`)
 * rather than with a caret. v5 has no stable release — 32 betas and counting —
 * and the two packages pin `@auth/core` to the same exact version. Bumping one
 * alone puts two copies of `@auth/core` in node_modules and the mismatch surfaces
 * as an `Adapter` type error in `npm run build`, which is the project's gate.
 */

/**
 * Wraps the adapter to enforce what the library will not.
 *
 * `getSessionAndUser` is where EVERY session read funnels, which is why the
 * checks live here rather than in the `session` callback: under the database
 * strategy that callback returns `Session` with no `null` in its type, so it
 * cannot deny. A check placed there looks correct and is bypassed by every
 * other read path.
 */
function guardedAdapter(): Adapter {
  const base = PostgresAdapter(authPool()) as Adapter;
  const inner = base.getSessionAndUser!.bind(base);

  return {
    ...base,

    async getSessionAndUser(sessionToken: string) {
      const result = await inner(sessionToken);
      if (!result) return null;

      // `created_at` is ours, added in db/schema.sql. The adapter selects * so it
      // arrives at runtime even though AdapterSession does not type it.
      const raw = result.session as unknown as { expires: Date; created_at?: Date };
      const createdAt = raw.created_at ? new Date(raw.created_at) : new Date(raw.expires);

      const verdict = sessionVerdict(
        { createdAt, expires: new Date(raw.expires) },
        new Date()
      );
      if (!verdict.valid) {
        // Delete rather than merely refuse. A session past its absolute cap is
        // dead permanently; leaving the row lets a stolen cookie keep being
        // presented, and keeps the table growing.
        await base.deleteSession?.(sessionToken);
        console.warn(`auth: session rejected (${verdict.reason})`);
        return null;
      }

      // Status is re-read on EVERY request, not just at sign-in. Checking only at
      // sign-in would mean a suspension takes up to the sliding window (7 days)
      // to bite, because the session keeps renewing itself in the meantime.
      // The user row is already joined here, so this costs nothing.
      const status = (result.user as unknown as { status?: string }).status ?? "pending";
      if (!accessFor(status).allow) return null;

      return result;
    },
  };
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  adapter: guardedAdapter(),
  session: {
    strategy: "database",
    // The SLIDING window. The absolute cap is separate and enforced above —
    // Auth.js advances `expires` on use, so this alone would let an actively
    // used stolen cookie live forever.
    maxAge: 7 * 24 * 60 * 60,
  },
  // Railway terminates TLS at its proxy and forwards to the container on PORT,
  // so without this Auth.js builds the callback URL from the bound address and
  // sends users to localhost:8080 — breaking sign-in entirely rather than one page.
  trustHost: true,
  pages: { signIn: "/signin", error: "/signin" },
  providers: [
    Google({
      // Google returns unverified addresses in some flows, and an unverified
      // address matching an approved row is account takeover with fewer steps.
      // Checked again in signIn below; requested here so the claim is present.
      authorization: { params: { scope: "openid email profile" } },
    }),
  ],
  callbacks: {
    /**
     * Runs BEFORE the adapter creates a user, which is what makes it the right
     * place to reject an identity — and the wrong place to create the waitlist
     * row. Returning false here aborts before `createUser`, so a rejected signup
     * leaves nothing for the admin to approve; that is why a PENDING user is
     * allowed through to creation and denied later at session read instead.
     */
    async signIn({ profile }) {
      const sub = profile?.sub;
      const email = profile?.email;
      if (!sub || !email) return false;

      const { rows } = await authPool().query(
        `select id, google_sub from users where email = $1`,
        [email]
      );
      const existing = rows[0]
        ? { userId: rows[0].id as string, googleSub: rows[0].google_sub as string | null }
        : null;

      const verdict = resolveIdentity(
        { sub, email, emailVerified: profile?.email_verified === true },
        existing
      );

      if (verdict.kind === "unverified-email") {
        console.warn("auth: refused unverified email");
        return false;
      }
      if (verdict.kind === "sub-collision") {
        // Same address, different Google account. Either the address was
        // reassigned by a Workspace admin, or someone is claiming it. Never the
        // existing user — that would hand over their pipeline and stored API key.
        console.warn(`auth: sub collision on an existing account (${verdict.existingUserId})`);
        return false;
      }
      return true;
    },

    async session({ session, user }) {
      // Carry the fields every downstream check needs, so nothing has to re-read
      // the user row per request.
      const u = user as unknown as { id: string; status?: string; role?: string };
      (session as unknown as Record<string, unknown>).userId = u.id;
      (session as unknown as Record<string, unknown>).status = u.status ?? "pending";
      (session as unknown as Record<string, unknown>).role = u.role ?? "user";
      return session;
    },
  },
  events: {
    /**
     * `accounts.providerAccountId` IS the Google `sub`, but identity checks read
     * `users.google_sub`, so it is recorded here — the first moment both the user
     * row and the provider account exist. Written only when absent, so a claimed
     * row can never be silently re-pointed at a different Google account.
     */
    async linkAccount({ user, account }) {
      if (account.provider !== "google") return;
      await authPool().query(
        `update users set google_sub = $1 where id = $2 and google_sub is null`,
        [account.providerAccountId, user.id]
      );
    },
  },
});
