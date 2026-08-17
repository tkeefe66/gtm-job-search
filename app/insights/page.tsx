import Insights from "@/components/Insights";
import { requireActorPage } from "@/lib/require-actor";

// force-dynamic because this page now depends on the REQUEST (its session). A
// prerendered page has no request, so the auth check would run once at build
// time — against no session — and the result would be served to everyone.
export const dynamic = "force-dynamic";

export default async function InsightsPage() {
  await requireActorPage();
  return <Insights />;
}
