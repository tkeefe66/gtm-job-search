import { describe, expect, test, vi } from "vitest";
import { readdirSync } from "node:fs";
import path from "node:path";

/**
 * Every exported server action refuses when there is no session.
 *
 * This is the test the spec review asked for, and it exists because there is no
 * framework-level place to enforce it. Middleware runs on the Edge runtime and
 * cannot reach Postgres to validate a database session, and Node-runtime
 * middleware does not exist until Next 15.2 — so the check is a hand-written
 * first statement in ~36 functions, and a hand-written check is one someone
 * forgets when adding the 37th.
 *
 * It matters more than it looks: Server Actions are RPC endpoints addressed by
 * an ID that ships in the CLIENT BUNDLE. Anyone who reads the JavaScript can POST
 * an action id directly, without ever loading a page, so gating the pages does
 * nothing for them.
 *
 * The other action test files mock `@/lib/require-actor` so they can exercise
 * their own failure paths. That mock would quietly erase this coverage
 * everywhere — which is exactly why this assertion lives in its own file, with
 * the guard NOT mocked.
 */

// A session that does not exist. `@/auth` is mocked rather than left to load,
// because next-auth imports `next/server`, which does not resolve under
// vitest's node environment.
vi.mock("@/auth", () => ({ auth: async () => null }));

/**
 * Invoked by app/api/cron/crawl/route.ts, which authenticates with CRON_SECRET
 * and holds no browser session. They are reachable without one BY DESIGN; the
 * platform context in lib/platform-context.ts is what grants that, and it is
 * entered only after the secret check passes.
 */
const CRON_CALLED = new Set([
  "getDueCompanies",
  "repairJobLinks",
  // Enumerates tenants for the nightly crawl; the cron route has no session.
  "listCrawlableTenants",
]);

/** Not actions — re-exported types and constants carry no session requirement. */
function isAction(v: unknown): v is (...args: unknown[]) => Promise<unknown> {
  return typeof v === "function";
}

const dir = path.join(process.cwd(), "app", "actions");
const files = readdirSync(dir)
  .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
  .sort();

describe("every server action requires a session", () => {
  test("there are action files to check at all", () => {
    // Guards against the suite passing because a glob silently matched nothing.
    expect(files.length).toBeGreaterThan(5);
  });

  for (const file of files) {
    test(`${file}`, async () => {
      const mod = (await import(`./${file.replace(/\.ts$/, "")}`)) as Record<string, unknown>;
      const exported = Object.keys(mod).filter((n) => isAction(mod[n]));
      const names = exported.filter((n) => !CRON_CALLED.has(n));

      // Assert the module actually LOADED exports, not that it has ungated ones.
      // link-health.ts legitimately has zero: its only export is repairJobLinks,
      // which the cron route calls. Asserting on `names` instead would fail an
      // honest file, and "fixing" that by deleting the assertion is how this test
      // would come to pass against a module that silently exported nothing.
      expect(exported.length).toBeGreaterThan(0);

      for (const name of names) {
        const fn = mod[name] as (...a: unknown[]) => Promise<unknown>;
        await expect(
          fn(undefined, undefined, undefined),
          `${file}:${name} did not refuse an unauthenticated call`
        ).rejects.toThrow(/Not authenticated/);
      }
    });
  }
});
