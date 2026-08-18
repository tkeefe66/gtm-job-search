// Split out of lib/onboarding-rules.ts on purpose: this function needs
// lib/settings-effects.ts -> lib/settings-store.ts -> lib/supabase.ts, which
// transitively imports `pg`. components/Onboarding.tsx imports
// lib/onboarding-rules.ts at RUNTIME (not just for types) for its two
// client-safe helpers, and `pg` imports `net`/`tls`/`fs`/`dns` — none of which
// exist in a browser bundle. Webpack cannot tree-shake this import away just
// because the client component never calls it: lib/supabase.ts opens a
// connection pool at module-scope, a side effect that forces the whole import
// chain into any bundle that reaches this file at all. Keeping it in its own
// module is what lets app/actions/onboarding.ts (server-only) use it while
// lib/onboarding-rules.ts stays safe for the browser.
//
// Same "pure decision kept out of app/actions/onboarding.ts" reasoning as
// lib/onboarding-rules.ts's own header: app/actions/auth-required.test.ts
// walks every exported function in every app/actions/*.ts file and requires
// it to reject an unauthenticated call, which a bare pure helper cannot do.

import { CACHES_TO_CLEAR } from "@/lib/settings-effects";
import { SETTING_KEYS } from "@/lib/settings-store";

/**
 * The cache tables a completed onboarding must clear, DERIVED from
 * lib/settings-effects.ts rather than listed here.
 *
 * Onboarding writes titles, locations, stackTerms, locationRule and fitBrain in
 * one transaction, so it invalidates the union of what saving each of them
 * would invalidate. Hand-listing the union is how it drifts from the map that
 * decides — and the consequence of drift is a role_searches cache full of the
 * PREVIOUS career, served to a user who just told the app they do something
 * else.
 */
export function cachesOnboardingClears(): string[] {
  const keys = [
    SETTING_KEYS.titles,
    SETTING_KEYS.locations,
    SETTING_KEYS.stackTerms,
    SETTING_KEYS.locationRule,
    SETTING_KEYS.fitBrain,
  ];
  return Array.from(new Set(keys.flatMap((k) => CACHES_TO_CLEAR[k])));
}
