import { redirect } from "next/navigation";
import { isPlatform } from "@/lib/platform-context";
import { accessFor } from "@/lib/auth-policy";
import { readOnboardedAtFor } from "@/lib/settings-store";

/**
 * Who is making this request.
 *
 * `tenantId` rather than `userId` deliberately, even though one user is one
 * tenant today: when the tenancy work lands, the FK column on every scoped table
 * is named `tenant_id`, and having callers already speak that word means the
 * change is a new resolver rather than a rename across ~36 call sites.
 */
export interface Actor {
  userId: string;
  tenantId: string;
  email: string;
  isAdmin: boolean;
}

async function readActor(): Promise<Actor | null> {
  // Imported lazily, not at module scope. Every server action imports this file,
  // so a static `import { auth } from "@/auth"` pulls next-auth — and through it
  // `next/server` — into every module that touches an action, including the test
  // suite, which runs in a plain node environment and cannot resolve it. The
  // deferred import also means the auth stack is not constructed for requests
  // that never reach a session check.
  const { auth } = await import("@/auth");
  const session = await auth();
  if (!session) return null;

  const s = session as unknown as {
    userId?: string;
    status?: string;
    role?: string;
    user?: { email?: string | null };
  };
  if (!s.userId) return null;
  if (!accessFor(s.status ?? "pending").allow) return null;

  return {
    userId: s.userId,
    tenantId: s.userId,
    email: s.user?.email ?? "",
    isAdmin: s.role === "admin",
  };
}

/**
 * Where an active tenant should be sent instead of the page they asked for, or
 * null to let them through.
 *
 * Pure and exported so the rule is testable: requireActorPage itself reads the
 * session and the database and can be reached from no test in this repo.
 *
 * `allowUnonboarded` is a PER-CALL-SITE opt-out, not a route list — this
 * function does not know which route called it, and revision 2 of the design
 * assumed a mechanism that does not exist. /admin is the only caller that
 * passes true.
 */
export function onboardingRedirect(input: {
  actor: Actor;
  onboardedAt: string | null;
  allowUnonboarded: boolean;
}): string | null {
  if (input.allowUnonboarded) return null;
  // Empty string is not a stamp: writeOnboardedAt always writes an ISO string,
  // so an empty one is a hand-edit or a bad write, and letting it through is
  // how a tenant reaches /discover with no criteria at all.
  return input.onboardedAt && input.onboardedAt.length > 0 ? null : "/welcome";
}

/**
 * For PAGES. Sends anyone without an allowed session to /signin, which doubles
 * as the waitlist screen for a pending user — and anyone who has not finished
 * onboarding to /welcome.
 *
 * Every tenant-scoped page must call this. A page that forgets is not merely
 * unprotected — under `force-dynamic` it would render one person's data to
 * whoever asks.
 *
 * The stamp is read through readOnboardedAtFor, which takes actor.tenantId
 * EXPLICITLY and never calls resolveTenantId. That is not a style choice:
 * resolveTenantId is `(await requireActor()).tenantId`, so a reader that
 * resolved its own tenant would call requireActor() from inside this flow,
 * unbounded. See the note on readOnboardedAtFor.
 *
 * Costs one extra query per page render on five force-dynamic pages. The cron
 * crawler is unaffected — it has no session and never reaches a page (see
 * isPlatform() above and the grep recorded in the task-9 report).
 */
export async function requireActorPage(opts?: { allowUnonboarded?: boolean }): Promise<Actor> {
  const actor = await readActor();
  if (!actor) redirect("/signin");
  const target = onboardingRedirect({
    actor,
    onboardedAt: await readOnboardedAtFor(actor.tenantId),
    allowUnonboarded: opts?.allowUnonboarded === true,
  });
  if (target) redirect(target);
  return actor;
}

/**
 * For /admin, which opts OUT of the onboarding gate.
 *
 * A bug in onboarding must not lock the only admin out of the approval screen.
 * Admin ACTIONS need nothing equivalent: app/actions/admin.ts reads no criteria
 * and scores nothing, so the empty-criteria protection is irrelevant to it and
 * there is no second lockout behind the Approve button.
 *
 * Deliberately NOT an isAdmin exemption inside requireActorPage: the admin is
 * the account that would dogfood this flow, and exempting them by role would
 * leave it untested by the one person able to judge whether its output is any
 * good.
 */
export async function requireAdminPage(): Promise<Actor> {
  return requireActorPage({ allowUnonboarded: true });
}

/**
 * For SERVER ACTIONS. Throws rather than redirecting, because an action is an
 * RPC call and a redirect is not a refusal.
 *
 * Server Actions are addressed by an ID that ships in the client bundle, so a
 * page-level check does NOT protect them: anyone who reads the JS can POST an
 * action id directly and reach findAndSaveRoles or saveSetting without ever
 * loading a page. This has to be the first statement of every exported action —
 * there is no framework-level place to put it on Next 14, because middleware
 * runs on Edge and cannot reach Postgres to validate a database session.
 */
export async function requireActor(): Promise<Actor> {
  // The platform runs on its own behalf with no session — see
  // lib/platform-context.ts. Entered ONLY by the cron route, and only after its
  // CRON_SECRET check has passed. Checked before the session read because there
  // is no session to read.
  if (isPlatform()) return PLATFORM_ACTOR;

  const actor = await readActor();
  if (!actor) throw new Error("Not authenticated");
  return actor;
}

/**
 * The identity scheduled work acts under.
 *
 * `isAdmin: false` deliberately: the crawler crawls and scores, and nothing it
 * does should pass an admin-only check. If a future action needs both platform
 * access and admin rights, that is a decision to make explicitly rather than one
 * to inherit from a cron job.
 */
const PLATFORM_ACTOR: Actor = {
  userId: "platform",
  tenantId: "platform",
  email: "platform@internal",
  isAdmin: false,
};
