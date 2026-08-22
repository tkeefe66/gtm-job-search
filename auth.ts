import NextAuth from "next-auth";
import Google from "next-auth/providers/google";
import PostgresAdapter from "@auth/pg-adapter";
import type { Adapter } from "next-auth/adapters";
import { authPool } from "@/lib/supabase";
import { sessionVerdict, resolveIdentity } from "@/lib/auth-policy";

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
/**
 * Turns the ISO strings this app's `pg` configuration produces back into Dates.
 *
 * lib/supabase.ts installs a GLOBAL type parser mapping every `timestamptz` to
 * an ISO string, so the server actions can treat timestamps as strings. Auth.js
 * expects real `Date` objects, and hands `session.expires` straight to the cookie
 * serializer — which rejects a string with
 * `TypeError: option expires is invalid`, breaking sign-in at the last step
 * after the user has already been created.
 *
 * A separate pool would NOT fix it: `types.setTypeParser` is global to the `pg`
 * module, not per-pool. So the conversion has to happen here, at the adapter
 * boundary, on every value Auth.js expects to be temporal.
 */
function reviveDates<T>(row: T): T {
  if (!row || typeof row !== "object") return row;
  const out = row as unknown as Record<string, unknown>;
  for (const key of ["expires", "emailVerified", "created_at"]) {
    const v = out[key];
    if (typeof v === "string") out[key] = new Date(v);
  }
  return row;
}

function guardedAdapter(): Adapter {
  const base = PostgresAdapter(authPool()) as Adapter;
  const inner = base.getSessionAndUser!.bind(base);

  // Every adapter method that hands Auth.js a row carrying a timestamp needs the
  // revival above. Wrapped generically rather than one-by-one so a method added
  // by a future beta cannot quietly skip it.
  // `R | PromiseLike<R>` — Auth.js's `Awaitable<R>`. Not `Promise<R>`: adapter
  // methods may return synchronously, and PromiseLike is wider than Promise, so
  // anything narrower rejects every method the adapter actually defines.
  const wrap = <A extends unknown[], R>(fn?: (...a: A) => R | PromiseLike<R>) =>
    fn
      ? async (...args: A): Promise<R> => {
          const r = await fn(...args);
          if (r && typeof r === "object") {
            const rec = r as unknown as Record<string, unknown>;
            // getSessionAndUser returns { session, user }; everything else is a row.
            if (rec.session || rec.user) {
              reviveDates(rec.session);
              reviveDates(rec.user);
            } else {
              reviveDates(r);
            }
          }
          return r;
        }
      : fn;

  return {
    ...base,
    createSession: wrap(base.createSession?.bind(base)),
    updateSession: wrap(base.updateSession?.bind(base)),
    createUser: wrap(base.createUser?.bind(base)),
    updateUser: wrap(base.updateUser?.bind(base)),
    getUser: wrap(base.getUser?.bind(base)),
    getUserByEmail: wrap(base.getUserByEmail?.bind(base)),
    getUserByAccount: wrap(base.getUserByAccount?.bind(base)),

    async getSessionAndUser(sessionToken: string) {
      const result = await inner(sessionToken);
      if (!result) return null;
      // Same revival as the wrapped methods above — this one is hand-written
      // because it also carries the cap and status checks below.
      reviveDates(result.session);
      reviveDates(result.user);

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

      // STATUS IS NOT CHECKED HERE, DELIBERATELY. It used to be, and that was the
      // sign-in loop of 2026-08-18: refusing here returns null, so `auth()` reports
      // NO SESSION rather than a refused one, and /signin — the waitlist screen —
      // could not tell a pending user apart from a stranger. It showed them the
      // Google button, the click minted another session, /discover bounced them
      // back, forever. One account had three sessions inside three minutes.
      //
      // The refusal lives at the surfaces instead, where it can still say why:
      // readActor (lib/require-actor.ts) gates every page and every server action,
      // and signInView (lib/auth-policy.ts) gates this page. Both call accessFor,
      // so the fail-closed rule is unchanged.
      //
      // The property this check was written for survives: status arrives on the
      // session from the user row joined RIGHT HERE, on every request, so a
      // suspension still bites on the next request rather than at the end of the
      // 7-day sliding window. What changed is who acts on it, not when it is read.
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
     * place to reject an identity. Returning false here aborts before
     * `createUser`, so a rejected signup leaves no row behind at all. Anything
     * that returns true here is created 'active' immediately (db/schema.sql's
     * column default) — there is no pending/waitlist step any more.
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
     * The admin is designated by CONFIG, not by a pre-seeded row.
     *
     * Seeding a `users` row ahead of first sign-in deadlocks the whole flow:
     * Auth.js refuses to attach a Google account to an existing user matched only
     * by email — `OAuthAccountNotLinked` — which is the same protection the `sub`
     * identity rule exists to provide, and it fires on a row created with no
     * `accounts` row beside it. The obvious escape,
     * `allowDangerousEmailAccountLinking: true`, reopens exactly the takeover
     * this design is built to prevent.
     *
     * So the row is created by the normal signup path and promoted here, at the
     * one moment the user demonstrably controls the address: Google has just
     * verified it. Everyone else is created `active` (the column default) and
     * gets in immediately — this only ever needs to set `role`.
     */
    async createUser({ user }) {
      const admin = process.env.ADMIN_EMAIL;
      if (!admin || !user.email || user.email.toLowerCase() !== admin.toLowerCase()) return;
      try {
        await authPool().query(`update users set role = 'admin' where id = $1`, [user.id]);
        console.log("auth: promoted the configured admin on first sign-in");
      } catch (err) {
        // EXPECTED on any database carrying db/migrations/009: `role` is no
        // longer writable by app_rw, because a table-level UPDATE grant on this
        // column is a privilege-escalation path for any future mass-assigning
        // write.
        //
        // Swallowed rather than rethrown because this runs inside an Auth.js
        // EVENT: throwing here fails the sign-in that just succeeded, turning a
        // missing promotion into a locked door. The account is still created
        // 'active' (the column default) regardless of this UPDATE's outcome —
        // only `role` is at risk here, not access — so a failed promotion just
        // means the owner is signed in as a plain user until they run the
        // statement below, as the database owner rather than as the app.
        const message = err instanceof Error ? err.message : String(err);
        console.error(
          `auth: could not self-promote the configured admin (${message}). ` +
            `This is expected once db/migrations/009_users_column_grants.sql is applied. ` +
            `Promote manually, as the database owner:\n` +
            `  update users set role = 'admin' where email = '${admin}';`
        );
      }
    },

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
