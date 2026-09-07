// lib/saved-resume-purge.test.ts
//
// runPurge takes its dependencies as arguments precisely so these two
// behaviours are pure logic. npm test covers pure logic only; a purge that
// reached the database directly would have no seam and these assertions —
// the two most likely to pass vacuously — could not be written at all.
import { describe, expect, test } from "vitest";
import { runPurge } from "./saved-resume-purge";

describe("runPurge", () => {
  test("purges every tenant the enumerator returns, not just active ones", async () => {
    const seen: string[] = [];
    const report = await runPurge({
      listTenants: async () => ({ tenantIds: ["a", "b", "c"] }),
      purgeTenant: async (id) => {
        seen.push(id);
        return { deleted: 2 };
      },
      oldestSurviving: async () => null,
    });
    expect(seen).toEqual(["a", "b", "c"]);
    expect(report.tenants).toBe(3);
    expect(report.deleted).toBe(6);
    expect(report.failed).toBe(0);
  });

  test("one tenant failing does not abort the others", async () => {
    const seen: string[] = [];
    const report = await runPurge({
      listTenants: async () => ({ tenantIds: ["a", "b", "c"] }),
      purgeTenant: async (id) => {
        seen.push(id);
        if (id === "b") return { deleted: 0, error: "boom" };
        return { deleted: 1 };
      },
      oldestSurviving: async () => null,
    });
    expect(seen).toEqual(["a", "b", "c"]);
    expect(report.deleted).toBe(2);
    expect(report.failed).toBe(1);
  });

  test("an enumeration failure is reported, not swallowed", async () => {
    const report = await runPurge({
      listTenants: async () => ({ tenantIds: [], error: "cannot list" }),
      purgeTenant: async () => ({ deleted: 0 }),
      oldestSurviving: async () => null,
    });
    expect(report.error).toBe("cannot list");
    expect(report.tenants).toBe(0);
  });

  test("dryRun counts without deleting", async () => {
    let deletes = 0;
    const report = await runPurge({
      listTenants: async () => ({ tenantIds: ["a"] }),
      purgeTenant: async () => {
        deletes += 1;
        return { deleted: 1 };
      },
      countTenant: async () => 4,
      oldestSurviving: async () => null,
      dryRun: true,
    });
    expect(deletes).toBe(0);
    expect(report.deleted).toBe(4);
  });

  test("reports the oldest surviving expiry so a stalled purge is detectable", async () => {
    const report = await runPurge({
      listTenants: async () => ({ tenantIds: ["a"] }),
      purgeTenant: async () => ({ deleted: 0 }),
      oldestSurviving: async () => "2026-09-01T00:00:00.000Z",
    });
    expect(report.oldestSurviving).toBe("2026-09-01T00:00:00.000Z");
  });
});
