import { NextResponse, type NextRequest } from "next/server";

/**
 * A shared-secret password in front of the entire app.
 *
 * DELIBERATELY THROWAWAY. This is a stopgap until Google login lands
 * (docs/superpowers/specs/2026-08-15-multi-tenant-auth-design.md, sub-project
 * B); delete this file and app/gate/* on the day that ships. It has no concept
 * of users, sessions, or revocation — it is a lock on a door that currently has
 * none, on an app that is publicly reachable at jobs.tomkeefe.ai and whose
 * buttons spend Anthropic credits.
 *
 * WHY MIDDLEWARE, AND WHY THIS CAN'T BE THE REAL AUTH
 *
 * Middleware runs on every request matching the matcher below, and crucially
 * that INCLUDES the POSTs that React Server Actions ride on. Server actions are
 * RPC endpoints addressed by an ID that ships in the client bundle, so a
 * page-level check does not protect them — but a middleware check does, all 39
 * of them at once, with no per-action code to forget.
 *
 * The catch is that middleware runs on the EDGE runtime, which has no
 * net/dns/tls and therefore cannot reach Postgres. Comparing a cookie to an
 * environment variable needs no database, so this works. Real auth with
 * database-backed sessions needs a lookup per request, which Edge cannot do,
 * and Node-runtime middleware does not exist until Next 15.2 (this app is on
 * 14.2.x). That is the entire reason sub-project B is a redesign rather than a
 * config change, and the reason this stopgap is cheap while the real thing is
 * not.
 */

const COOKIE = "gate";

/**
 * Fails CLOSED when GATE_TOKEN is unset or empty: every route is blocked
 * rather than served.
 *
 * The alternative — treating a missing secret as "no gate configured, let
 * everyone through" — reproduces exactly the bug this file exists to fix, and
 * would do it silently on any deploy that forgot the variable. Same doctrine as
 * app/api/cron/crawl/route.ts, which returns 401 when CRON_SECRET is absent.
 * The visible cost is that a deploy missing the variable locks the owner out
 * too; that is the correct direction to fail.
 */
function configured(): string | null {
  const token = process.env.GATE_TOKEN;
  return token ? token : null;
}

/** Hex SHA-256. WebCrypto, because Edge has no node:crypto. */
async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Constant-time string comparison.
 *
 * `a === b` on a secret returns as soon as it finds a differing byte, which
 * leaks how much of a guess was correct. Edge has no timingSafeEqual, so this
 * accumulates the XOR of every byte pair and checks the total at the end — no
 * early return, and the length check is folded in rather than short-circuiting.
 * Both inputs here are fixed-width hex digests, so lengths always match in
 * practice; the guard is for the malformed-cookie case.
 */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function middleware(req: NextRequest) {
  const token = configured();
  // Unconfigured: send everything to the gate page, which explains the state.
  // Not a 500, because the owner needs a page that tells them what is wrong.
  if (!token) return NextResponse.redirect(new URL("/gate", req.url));

  const presented = req.cookies.get(COOKIE)?.value ?? "";
  const expected = await sha256Hex(token);
  if (safeEqual(presented, expected)) return NextResponse.next();

  // No `?next=` round-trip on purpose. Carrying a return path means validating
  // it against open-redirect abuse, and this gate is not worth that surface —
  // unlocking lands on the home page and the user navigates from there.
  return NextResponse.redirect(new URL("/gate", req.url));
}

export const config = {
  matcher: [
    /*
     * Everything except:
     *   gate            — the unlock page itself, or there is no way in
     *   api/gate        — the unlock handler, same reason
     *   api/auth        — Auth.js's OAuth handshake. Google redirects the
     *                     browser back to /api/auth/callback/google with no
     *                     gate cookie in play; gating it makes sign-in
     *                     impossible to complete, and the failure looks like a
     *                     broken Google app rather than a local redirect.
     *   signin          — the sign-in / waitlist page, reachable before a user
     *                     has any session at all.
     *   api/cron/crawl  — carries its own bearer secret (CRON_SECRET) and is
     *                     called by the Railway cron service, which has no
     *                     cookie and no browser. Gating it would break the
     *                     crawler silently: a redirect is a 3xx, so the cron
     *                     would report success while crawling nothing.
     *   _next/*, favicon, static assets — no secrets, and gating them breaks
     *                     the gate page's own styling.
     *
     * NOTE the gate is still an OUTER layer over the app while Google sign-in
     * is being proven. Both are active: the password gets you past the door,
     * the session decides who you are. Delete this file once sign-in is
     * enforced on every server action.
     */
    "/((?!gate|api/gate|api/auth|signin|api/cron/crawl|_next/static|_next/image|favicon.ico).*)",
  ],
};
