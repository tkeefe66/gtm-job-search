import { readFileSync } from "node:fs";
import { describe, test, expect } from "vitest";
import {
  accessFor,
  sessionVerdict,
  resolveIdentity,
  signInView,
  signInError,
  signInBody,
  IDLE_MS,
  ABSOLUTE_MS,
} from "./auth-policy";

const NOW = new Date("2026-08-16T12:00:00Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms);

describe("accessFor", () => {
  test("only active gets in", () => {
    expect(accessFor("active")).toEqual({ allow: true });
  });

  test("every other known status is refused with its reason", () => {
    expect(accessFor("pending")).toEqual({ allow: false, reason: "waitlist" });
    expect(accessFor("suspended")).toEqual({ allow: false, reason: "suspended" });
    expect(accessFor("denied")).toEqual({ allow: false, reason: "denied" });
  });

  // The one that matters for a future migration: a status this build has never
  // heard of must not fall through to access.
  test("an unrecognised status fails CLOSED", () => {
    expect(accessFor("trialing")).toEqual({ allow: false, reason: "unknown" });
    expect(accessFor("")).toEqual({ allow: false, reason: "unknown" });
    expect(accessFor("ACTIVE")).toEqual({ allow: false, reason: "unknown" });
  });
});

describe("sessionVerdict", () => {
  test("a fresh, recently-used session is valid", () => {
    expect(
      sessionVerdict({ createdAt: ago(1000), expires: new Date(NOW.getTime() + 1000) }, NOW)
    ).toEqual({ valid: true });
  });

  test("an abandoned session expires on idle", () => {
    expect(
      sessionVerdict({ createdAt: ago(IDLE_MS + 1000), expires: ago(1) }, NOW)
    ).toEqual({ valid: false, reason: "idle" });
  });

  // THE reason this module exists. Auth.js pushes `expires` forward on every
  // request, so a stolen cookie that is actively used keeps renewing itself.
  // Only a cap measured from createdAt stops it.
  test("a CONTINUOUSLY USED session still dies at the absolute cap", () => {
    const v = sessionVerdict(
      {
        createdAt: ago(ABSOLUTE_MS + 1000),
        // expires is far in the future — the attacker's own traffic kept it alive
        expires: new Date(NOW.getTime() + IDLE_MS),
      },
      NOW
    );
    expect(v).toEqual({ valid: false, reason: "absolute" });
  });

  test("the absolute cap outranks a healthy idle window", () => {
    // Both rules consulted; absolute is checked first so the reason is accurate.
    const v = sessionVerdict(
      { createdAt: ago(ABSOLUTE_MS + 1), expires: ago(IDLE_MS + 1) },
      NOW
    );
    expect(v).toEqual({ valid: false, reason: "absolute" });
  });

  test("exactly at the cap is still valid; past it is not", () => {
    const future = new Date(NOW.getTime() + 1000);
    expect(sessionVerdict({ createdAt: ago(ABSOLUTE_MS), expires: future }, NOW)).toEqual({
      valid: true,
    });
    expect(sessionVerdict({ createdAt: ago(ABSOLUTE_MS + 1), expires: future }, NOW)).toEqual({
      valid: false,
      reason: "absolute",
    });
  });
});

describe("resolveIdentity", () => {
  const verified = { sub: "google-123", email: "a@corp.com", emailVerified: true };

  test("an unverified email is refused before anything else is considered", () => {
    expect(
      resolveIdentity({ ...verified, emailVerified: false }, { userId: "u1", googleSub: "google-123" })
    ).toEqual({ kind: "unverified-email" });
  });

  test("no existing row is a new user", () => {
    expect(resolveIdentity(verified, null)).toEqual({ kind: "new-user" });
  });

  test("a matching sub is the known user", () => {
    expect(resolveIdentity(verified, { userId: "u1", googleSub: "google-123" })).toEqual({
      kind: "known-user",
      userId: "u1",
    });
  });

  // The account-takeover path. Alice leaves; Corp reassigns alice@corp.com to a
  // new hire. Same email, different Google sub. Keyed on email, the new hire
  // inherits Alice's pipeline, fit brain, comp floor and stored API key.
  test("same email, DIFFERENT sub is a collision — never the existing user", () => {
    expect(
      resolveIdentity({ ...verified, sub: "google-999" }, { userId: "u1", googleSub: "google-123" })
    ).toEqual({ kind: "sub-collision", existingUserId: "u1" });
  });

  // The seeded admin row has no sub until the first real sign-in claims it.
  test("a row with no recorded sub is claimable once", () => {
    expect(resolveIdentity(verified, { userId: "admin", googleSub: null })).toEqual({
      kind: "known-user",
      userId: "admin",
    });
  });

  test("a claimed row is no longer claimable by a different sub", () => {
    const claimed = { userId: "admin", googleSub: "google-123" };
    expect(resolveIdentity({ ...verified, sub: "attacker" }, claimed)).toEqual({
      kind: "sub-collision",
      existingUserId: "admin",
    });
  });
});

describe("signInView", () => {
  // Mutation this catches: signInView returning "signin" for a pending session —
  // which is exactly what the app did on 2026-08-18, because the adapter nulled
  // a pending user's session before /signin could read its status. The button
  // came back, the click minted another session, and the user circled forever.
  // Three sessions in three minutes for one account are in the sessions table.
  test("a pending session lands on the waitlist, NEVER back on the button", () => {
    expect(signInView("pending")).toBe("waitlist");
  });

  // Mutation this catches: collapsing the refused statuses into the waitlist
  // branch. "You're on the waitlist" is a false promise to a denied account.
  test("suspended and denied are refused, not queued", () => {
    expect(signInView("suspended")).toBe("refused");
    expect(signInView("denied")).toBe("refused");
  });

  // Mutation this catches: treating any session as good enough to bounce to
  // /discover, which sends a pending user into the redirect loop from the other
  // direction — /discover refuses them straight back to here.
  test("only an active session is bounced into the app", () => {
    expect(signInView("active")).toBe("redirect");
  });

  // The sign-in button is for people with NO session. A session whose status
  // this build cannot read is refused (accessFor fails closed); showing the
  // button there would re-mint the same unreadable session on every click.
  test("no session shows the button; an unknown status does not", () => {
    expect(signInView(null)).toBe("signin");
    expect(signInView(undefined)).toBe("signin");
    expect(signInView("trialing")).toBe("refused");
  });
});

/**
 * A SOURCE guard, not a unit test, because auth.ts imports next-auth and cannot
 * be loaded in this suite's plain node environment (the same constraint that
 * makes readActor import it lazily).
 */
describe("the session adapter does not deny by status", () => {
  // Mutation this catches: re-adding `if (!accessFor(status).allow) return null`
  // to getSessionAndUser. That reads as defence in depth and is not — it nulls a
  // pending user's session before /signin can read it, and every surface then
  // treats a waitlisted user as a signed-out one. That IS the loop.
  test("auth.ts never calls accessFor", () => {
    const src = readFileSync(new URL("../auth.ts", import.meta.url), "utf8");
    const calls = src
      .split("\n")
      .filter((line) => !line.trim().startsWith("//") && !line.trim().startsWith("*"))
      .filter((line) => /accessFor\s*\(/.test(line));
    expect(calls).toEqual([]);
  });
});

describe("signInError", () => {
  // Mutation this catches: a `default: return null` for codes this build does
  // not recognise. That is the silent circle — Auth.js redirects to
  // /signin?error=<code>, the page renders nothing but the Google button, and
  // the click is refused again with no message. An unknown code MUST still say
  // something.
  test("an unrecognised code still produces a notice", () => {
    const notice = signInError("SomethingNewInBeta33");
    expect(notice).not.toBeNull();
    expect(notice?.message.length).toBeGreaterThan(0);
  });

  // Mutation this catches: refusals falling through to the generic message. The
  // two the signIn callback actually returns false for are the ones a user can
  // act on — verify the address, or use the Google account that owns it — and a
  // generic "something went wrong" tells them neither.
  test("a refused Google account is told which two causes to check", () => {
    const notice = signInError("AccessDenied");
    expect(notice?.message).toMatch(/verif/i);
    expect(notice?.message).toMatch(/different Google account|another Google account/i);
  });

  // Mutation this catches: `retryable` hardcoded true. A misconfigured server
  // cannot be fixed by clicking again; offering the button there is the same
  // silent loop wearing a message.
  test("a server misconfiguration is not retryable, an access refusal is", () => {
    expect(signInError("Configuration")?.retryable).toBe(false);
    expect(signInError("AccessDenied")?.retryable).toBe(true);
  });

  // Mutation this catches: returning a notice unconditionally, which would put
  // an error banner in front of every first-time visitor who has never failed
  // anything.
  test("no error param is no notice", () => {
    expect(signInError(null)).toBeNull();
    expect(signInError(undefined)).toBeNull();
    expect(signInError("")).toBeNull();
  });
});

describe("signInBody", () => {
  // The whole reason this is a function and not a JSX ternary: the branch that
  // decides whether the Google button appears is the branch that produced the
  // sign-in loop twice already, and JSX in a server component is reachable from
  // no test in this repo.

  // Mutation this catches: evaluating the notice branch BEFORE the session
  // branch. A waitlisted user who arrives carrying any ?error= would then be
  // shown the button, click it, mint another session, and bounce off /discover
  // — the exact loop 8d9d4a5 fixed, reached through the query string instead.
  test("a waitlisted session never gets a button, even carrying a retryable error", () => {
    const body = signInBody("waitlist", signInError("AccessDenied"));
    expect(body.kind).toBe("waitlist");
  });

  test("a refused session never gets a button either", () => {
    expect(signInBody("refused", signInError("AccessDenied")).kind).toBe("refused");
  });

  // Mutation this catches: ignoring `retryable` and always rendering the button.
  // Clicking it cannot fix a misconfigured server, so offering it is the silent
  // loop wearing a message.
  test("a non-retryable notice leaves no button to click", () => {
    expect(signInBody("signin", signInError("Configuration")).kind).toBe("notice-only");
  });

  // Mutation this catches: dropping the button for every notice, retryable or
  // not — which strands a user whose only problem is a Google account they can
  // switch.
  test("a retryable notice keeps the button but drops the stock prompt", () => {
    const body = signInBody("signin", signInError("AccessDenied"));
    expect(body).toEqual({ kind: "button", prompt: false });
  });

  // Mutation this catches: rendering the notice-only body when there is no
  // notice at all, which would blank the page for every first-time visitor.
  test("no session and no error is the ordinary button, prompt and all", () => {
    expect(signInBody("signin", null)).toEqual({ kind: "button", prompt: true });
  });

  // Mutation this catches: an unknown error code suppressing the redirect. An
  // active session belongs on /discover no matter what is in the query string.
  test("an active session redirects regardless of any error code", () => {
    expect(signInBody("redirect", signInError("SomethingNewInBeta33")).kind).toBe("redirect");
  });
});
