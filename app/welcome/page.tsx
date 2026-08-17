import Onboarding from "@/components/Onboarding";
import { requireActorPage } from "@/lib/require-actor";

// force-dynamic for the same reason every other page here is: it depends on the
// REQUEST (its session), and a prerendered page would run the auth check once
// at build time against no session.
export const dynamic = "force-dynamic";

/**
 * The one page that opts out of the onboarding gate, because it IS the
 * onboarding. Without the opt-out this page redirects to itself.
 */
export default async function WelcomePage() {
  await requireActorPage({ allowUnonboarded: true });
  return <Onboarding />;
}
