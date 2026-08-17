import { redirect } from "next/navigation";
import AdminUsers from "@/components/AdminUsers";
import { requireActorPage } from "@/lib/require-actor";

export const dynamic = "force-dynamic";

export default async function AdminPage() {
  const actor = await requireActorPage();
  // Checked here AND in every action in app/actions/admin.ts. This one stops a
  // non-admin seeing the page; that one stops them calling the actions directly,
  // which they can do without ever loading it.
  if (!actor.isAdmin) redirect("/discover");
  return <AdminUsers />;
}
