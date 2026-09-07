// lib/require-resume-admin.ts
//
// The admin gate for every résumé surface, in ONE place.
//
// It lives in lib/ rather than in a "use server" file because in such a file
// every export becomes a POSTable RPC endpoint addressed by an id that ships in
// the client bundle — exporting an auth helper there would publish it.
//
// Mirrors app/actions/admin.ts's requireAdmin() exactly, and exists for the
// reason app/actions/auth-required.test.ts's own doc comment gives: a
// hand-written check is one someone forgets when adding the 37th action.
import { requireActor } from "@/lib/require-actor";

export async function requireResumeAdmin() {
  const actor = await requireActor();
  if (!actor.isAdmin) throw new Error("Not authorized");
  return actor;
}
