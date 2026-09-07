import { accessFor } from "@/lib/auth-policy";

/**
 * True when the browser's session cookie still resolves to an allowed
 * account — checked against Auth.js's own session endpoint directly, not
 * inferred from a Server Action's thrown message.
 *
 * requireActor() (lib/require-actor.ts) throws "Not authenticated" for an
 * expired or refused session, but a production build masks every uncaught
 * Server Action exception down to a generic "Server Components render"
 * sentence before it reaches the client — only a `digest` survives, and
 * relying on that would mean pattern-matching an undocumented Next.js
 * internal. Asking the session endpoint directly sidesteps that entirely:
 * it's the same userId/status shape auth.ts's session callback attaches for
 * requireActor() to read, so this mirrors that check exactly.
 */
export async function hasLiveSession(): Promise<boolean> {
  try {
    const res = await fetch("/api/auth/session", { cache: "no-store" });
    if (!res.ok) return false;
    const data = (await res.json()) as { userId?: string; status?: string } | null;
    if (!data?.userId) return false;
    return accessFor(data.status ?? "pending").allow;
  } catch {
    return false;
  }
}
