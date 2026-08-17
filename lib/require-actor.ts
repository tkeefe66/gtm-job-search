import { redirect } from "next/navigation";
import { isPlatform } from "@/lib/platform-context";
import { accessFor } from "@/lib/auth-policy";

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
 * For PAGES. Sends anyone without an allowed session to /signin, which doubles
 * as the waitlist screen for a pending user.
 *
 * Every tenant-scoped page must call this. A page that forgets is not merely
 * unprotected — under `force-dynamic` it would render one person's data to
 * whoever asks.
 */
export async function requireActorPage(): Promise<Actor> {
  const actor = await readActor();
  if (!actor) redirect("/signin");
  return actor;
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
