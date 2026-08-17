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
