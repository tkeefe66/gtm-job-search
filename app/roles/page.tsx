import RolesTable from "@/components/RolesTable";
import { readCompFloor } from "@/lib/settings-store";
import { requireActorPage } from "@/lib/require-actor";

// Rendered per request, not prerendered. This page now reads a setting, and a
// statically generated page would bake in whatever the BUILD saw — null, since
// the build has no database — and keep serving it after the floor is edited on
// /settings. rawQuery fails soft, so the wrong value would arrive silently.
export const dynamic = "force-dynamic";

// A server component reads the floor once, here, rather than adding a client
// round trip to RolesTable's own load(). RolesTable stays a client component;
// it just receives the number.
export default async function RolesPage() {
  const actor = await requireActorPage();
  return <RolesTable compFloor={await readCompFloor()} isAdmin={actor.isAdmin} />;
}
