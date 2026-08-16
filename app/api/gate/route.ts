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

/**
 * A RELATIVE redirect, deliberately — `NextResponse.redirect(new URL(path,
 * req.url))` is wrong here and shipped wrong once.
 *
 * Railway terminates TLS at its proxy and forwards to the container on PORT,
 * so inside a route handler `req.url` is the BOUND address, not the address the
 * user typed. In production that made every unlock 303 to
 * `https://localhost:8080/` — the cookie was set correctly and the browser then
 * landed on a dead host, which reads as "the password didn't work".
 *
 * The documented alternative is rebuilding the absolute URL from
 * `x-forwarded-host`. That header is client-controlled, and a redirect TARGET
 * built from a client-controlled value is an open redirect. A relative Location
 * needs no host at all: the browser resolves it against the origin it actually
 * requested, which is correct in production, in local dev, and behind any
 * proxy, with nothing to trust.
 */
function redirectTo(path: string): NextResponse {
  return new NextResponse(null, { status: 303, headers: { Location: path } });
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
    return redirectTo("/gate?e=1");
  }

  // The cookie carries the DERIVED value, never the password itself, so a
  // cookie read off a device does not hand over the shared secret that the
  // owner may have reused elsewhere.
  const res = redirectTo("/");
  res.cookies.set(COOKIE, digest(token).toString("hex"), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: MAX_AGE,
  });
  return res;
}
