import { createHash, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";

/**
 * Unlock handler for the stopgap gate. See middleware.ts for why this exists
 * and when to delete it.
 *
 * Node runtime (the default for route handlers), not Edge, so this one can use
 * node:crypto's timingSafeEqual directly rather than the hand-rolled compare
 * the middleware needs.
 */

export const dynamic = "force-dynamic";

const COOKIE = "gate";

// 30 days. Long enough not to be a nuisance, short enough that a cookie copied
// off a machine does not work forever. There is no server-side session to
// revoke — that is a real limitation of a stopgap, and the mitigation is that
// changing GATE_TOKEN invalidates every outstanding cookie at once, since the
// cookie's value is derived from the token.
const MAX_AGE = 60 * 60 * 24 * 30;

function digest(s: string): Buffer {
  return createHash("sha256").update(s).digest();
}

export async function POST(req: Request) {
  const token = process.env.GATE_TOKEN;
  // Fails closed, matching the middleware: with no secret configured there is
  // nothing to check against, so nothing is let through.
  if (!token) {
    return NextResponse.json({ error: "not configured" }, { status: 503 });
  }

  let submitted = "";
  try {
    const form = await req.formData();
    submitted = String(form.get("password") ?? "");
  } catch {
    // A malformed body is a failed attempt, not a crash. Deliberately does not
    // echo the parse error: this is an auth path, and error text on an auth
    // path is where credential-bearing strings get constructed.
    submitted = "";
  }

  // Hashing both sides first makes the comparison fixed-width, which removes
  // length as an observable side channel and keeps timingSafeEqual from
  // throwing on mismatched buffers. Same construction as the cron route's
  // `authorized()`.
  if (!timingSafeEqual(digest(submitted), digest(token))) {
    console.warn("gate: failed unlock attempt");
    return NextResponse.redirect(new URL("/gate?e=1", req.url), { status: 303 });
  }

  // The cookie carries the DERIVED value, never the password itself, so a
  // cookie read off a device does not hand over the shared secret that the
  // owner may have reused elsewhere.
  const res = NextResponse.redirect(new URL("/", req.url), { status: 303 });
  res.cookies.set(COOKIE, digest(token).toString("hex"), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: MAX_AGE,
  });
  return res;
}
