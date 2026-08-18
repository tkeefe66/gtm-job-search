/**
 * The three auth decisions that are pure, and therefore the three that can be
 * pinned by tests before any OAuth credential exists.
 *
 * Each one is a place the 2026-08-15 spec review found a defect that would have
 * shipped silently:
 *   - identity keyed on email lets a reassigned address inherit a pipeline
 *   - Auth.js rolls `expires` forward, so a stolen cookie never dies
 *   - a suspended user keeps working until their sliding session lapses
 *
 * Kept out of the Auth.js callbacks deliberately. Those run inside a library
 * whose behaviour is version-dependent and beta; these rules are ours and should
 * not move when `next-auth` does.
 */

/** Where a user sits with respect to being allowed in at all. */
export type AccountStatus = "pending" | "active" | "suspended" | "denied";

export type AccessVerdict =
  | { allow: true }
  | { allow: false; reason: "waitlist" | "suspended" | "denied" | "unknown" };

/**
 * Only `active` gets in. Everything else — including a status string this build
 * does not recognise — is refused.
 *
 * Fails CLOSED on an unknown value on purpose: a future status added by a
 * migration but not yet handled here must not default to access. The cost of
 * being wrong in this direction is a user seeing a waitlist screen; the cost in
 * the other direction is a denied account still working.
 */
export function accessFor(status: string): AccessVerdict {
  switch (status) {
    case "active":
      return { allow: true };
    case "pending":
      return { allow: false, reason: "waitlist" };
    case "suspended":
      return { allow: false, reason: "suspended" };
    case "denied":
      return { allow: false, reason: "denied" };
    default:
      return { allow: false, reason: "unknown" };
  }
}

export type SessionVerdict =
  | { valid: true }
  | { valid: false; reason: "idle" | "absolute" };

/** 7 days of inactivity. */
export const IDLE_MS = 7 * 24 * 60 * 60 * 1000;
/** 30 days since issue, regardless of use. */
export const ABSOLUTE_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Auth.js gives a sliding `expires` and nothing else. That means an ACTIVELY
 * USED stolen cookie never expires: every request pushes `expires` further out,
 * so the attacker's own traffic keeps it alive indefinitely.
 *
 * The absolute cap is measured from `createdAt`, which must never be advanced —
 * only `expires` moves. Checking both is the point: idle catches an abandoned
 * session, absolute catches a busy one.
 *
 * Enforced in a wrapper around the adapter's `getSessionAndUser`, not in the
 * `session` callback: under the database strategy that callback's return type is
 * `Session`, with no `null`, so it cannot deny. A check placed there looks
 * correct and is bypassed by every other read.
 */
export function sessionVerdict(
  session: { createdAt: Date; expires: Date },
  now: Date
): SessionVerdict {
  if (now.getTime() - session.createdAt.getTime() > ABSOLUTE_MS) {
    return { valid: false, reason: "absolute" };
  }
  if (now.getTime() > session.expires.getTime()) {
    return { valid: false, reason: "idle" };
  }
  return { valid: true };
}

export type IdentityVerdict =
  | { kind: "known-user"; userId: string }
  | { kind: "new-user" }
  | { kind: "sub-collision"; existingUserId: string }
  | { kind: "unverified-email" };

/**
 * Decides who is signing in, from Google's profile and whatever row already
 * matches that email.
 *
 * IDENTITY IS `sub`, NEVER EMAIL. Google's `sub` is stable and unique forever;
 * the email is a mutable attribute that Workspace admins reassign. Matching a
 * waitlist row on email means that when alice@corp.com leaves and the address is
 * handed to a new hire, the new hire signs in with a DIFFERENT sub, matches the
 * approved row, and inherits Alice's pipeline, her fit brain, her comp floor, and
 * her stored Anthropic key. Auth.js's `allowDangerousEmailAccountLinking: false`
 * protects the accounts table and does nothing for a waitlist keyed on email.
 *
 * So a sub that does not match the stored sub for that email is a COLLISION — a
 * new pending user, never the existing one — and the admin console must show it,
 * because it is either a reassigned address or an attempt to claim one.
 *
 * `email_verified` is checked first. Google does not always return true, and an
 * unverified address matching an approved row is the same takeover with fewer
 * steps.
 */
export function resolveIdentity(
  profile: { sub: string; email: string; emailVerified: boolean },
  existing: { userId: string; googleSub: string | null } | null
): IdentityVerdict {
  if (!profile.emailVerified) return { kind: "unverified-email" };
  if (!existing) return { kind: "new-user" };

  // A row created before a sub was recorded (e.g. the seeded admin) is claimable
  // once, by the first verified sign-in for that address.
  if (existing.googleSub === null) return { kind: "known-user", userId: existing.userId };

  if (existing.googleSub !== profile.sub) {
    return { kind: "sub-collision", existingUserId: existing.userId };
  }
  return { kind: "known-user", userId: existing.userId };
}

/** What /signin should render for whatever session (if any) the request carries. */
export type SignInView = "redirect" | "waitlist" | "refused" | "signin";

/**
 * Sign-in and waitlist are ONE page, so this is the whole of that page's logic.
 *
 * Pure and exported because the page itself is a server component that reads a
 * session and can be reached from no test in this repo — and because the branch
 * that matters is the one that was unreachable in production: a PENDING session
 * must show the waitlist, never the sign-in button. Showing the button to a user
 * who already holds a session is the sign-in loop: the click mints another
 * session, /discover refuses it, and the redirect lands back here.
 *
 * `status` is null/undefined when there is no session at all — the only state
 * the button belongs to. An unrecognised status is refused rather than offered a
 * retry, for the same reason accessFor fails closed on it.
 */
export function signInView(status: string | null | undefined): SignInView {
  if (status === null || status === undefined) return "signin";
  const verdict = accessFor(status);
  if (verdict.allow) return "redirect";
  return verdict.reason === "waitlist" ? "waitlist" : "refused";
}

/** What /signin should say about a failed attempt, and whether retrying can help. */
export interface SignInNotice {
  message: string;
  retryable: boolean;
}

/**
 * Turns Auth.js's `?error=` code into something the person reading it can act on.
 *
 * Both `pages.signIn` and `pages.error` are /signin, so EVERY refusal Auth.js
 * raises lands here carrying a code — including the two this app raises itself by
 * returning false from the signIn callback (an unverified Google address, and a
 * sub collision, both AccessDenied). Before this existed the page ignored the
 * parameter entirely and rendered the Google button, so a refused user clicked,
 * was refused again, and circled with nothing on screen and only a console.warn
 * in the server log. That is the same defect as the waitlist loop above, reached
 * by a different door.
 *
 * An unrecognised code therefore MUST NOT return null. Auth.js's client-safe set
 * grows between betas, and a code this build has never heard of is still a failed
 * sign-in that owes the user a sentence.
 */
export function signInError(code: string | null | undefined): SignInNotice | null {
  if (!code) return null;
  switch (code) {
    case "AccessDenied":
      return {
        // Deliberately names both causes rather than guessing between them: the
        // server knows which one fired, but saying "that address belongs to a
        // different Google account" to someone who merely has an unverified
        // address is a false accusation, and the reverse understates a takeover
        // attempt. The log line distinguishes them for the admin.
        message:
          "Google wouldn't let us sign you in with that account. Two things cause " +
          "this: the address isn't verified with Google, or it's already claimed " +
          "by a different Google account. Verify the address, or try the account " +
          "that owns it.",
        retryable: true,
      };
    case "OAuthAccountNotLinked":
      return {
        message:
          "There's already an account for that address that wasn't created " +
          "through Google. Ask the owner of this app to sort it out — signing in " +
          "again won't fix it.",
        retryable: false,
      };
    case "Configuration":
      return {
        message:
          "Sign-in is misconfigured on the server, so nobody can get in right " +
          "now. This isn't something you can fix by trying again — tell the owner " +
          "of this app.",
        retryable: false,
      };
    case "Verification":
      return {
        message: "That sign-in link has expired or was already used. Start again below.",
        retryable: true,
      };
    default:
      return {
        message: `Sign-in didn't complete (${code}). Trying again is safe; if it keeps failing, tell the owner of this app and quote that code.`,
        retryable: true,
      };
  }
}

/**
 * What /signin renders below the heading, once the session and any `?error=`
 * have both been read.
 *
 * `prompt` is the stock "Sign in to continue." line, which is noise next to an
 * error notice and belongs only on a clean first visit.
 */
export type SignInBody =
  | { kind: "redirect" }
  | { kind: "waitlist" }
  | { kind: "refused" }
  | { kind: "notice-only" }
  | { kind: "button"; prompt: boolean };

/**
 * The page's whole rendering decision, pure and therefore testable.
 *
 * Extracted for the same reason signInView was: the branch that decides whether
 * the Google button appears is the branch that has produced the sign-in loop
 * twice, and a server component's JSX is reachable from no test in this repo. In
 * a ternary this logic was green under a suite that could not see it.
 *
 * ORDER IS THE POINT. The session is consulted BEFORE the notice, because a
 * waitlisted user who arrives carrying any ?error= must still get the waitlist
 * and never the button — reversing these two lines rebuilds the loop through the
 * query string. A session that is allowed in redirects no matter what the query
 * string claims went wrong.
 */
export function signInBody(
  view: SignInView,
  notice: SignInNotice | null
): SignInBody {
  if (view === "redirect") return { kind: "redirect" };
  if (view === "waitlist") return { kind: "waitlist" };
  if (view === "refused") return { kind: "refused" };
  if (notice && !notice.retryable) return { kind: "notice-only" };
  return { kind: "button", prompt: notice === null };
}
