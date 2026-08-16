import { describe, test, expect } from "vitest";
import { backupGuard, backupKey, REQUIRED_TABLES } from "./backup-guard.mjs";

const ALL = [...REQUIRED_TABLES];

describe("backupGuard", () => {
  test("passes when every app table is present", () => {
    const v = backupGuard({ database: "railway", tables: ALL });
    expect(v.ok).toBe(true);
  });

  test("extra tables do not matter — a superset is still the right database", () => {
    const v = backupGuard({
      database: "railway",
      tables: [...ALL, "sessions", "pg_stat_statements"],
    });
    expect(v.ok).toBe(true);
  });

  // THE failure this guard exists for: Railway's ${{Postgres.DATABASE_URL}}
  // points at the platform default, pg_dump succeeds, and a valid empty file
  // lands on top of the real backup.
  test("refuses a database with none of the app's tables", () => {
    const v = backupGuard({ database: "railway", tables: [] });
    expect(v.ok).toBe(false);
    if (v.ok) throw new Error("unreachable");
    expect(v.reason).toContain("wrong database");
    expect(v.missing).toHaveLength(REQUIRED_TABLES.length);
  });

  test("refuses a partial schema rather than dumping it", () => {
    const v = backupGuard({ database: "railway", tables: ["jobs", "watchlist"] });
    expect(v.ok).toBe(false);
    if (v.ok) throw new Error("unreachable");
    expect(v.missing).toContain("app_settings");
    expect(v.reason).toContain("partial schema");
  });

  // The distinction the guard is built on: an empty app is NOT a wrong
  // database. Checking rows instead of tables would refuse this, which is a
  // refusal to back up a perfectly good (new) install.
  test("an empty but fully-migrated database still backs up", () => {
    // No row counts are consulted at all — the input has none to give.
    const v = backupGuard({ database: "railway", tables: ALL });
    expect(v.ok).toBe(true);
    if (!v.ok) throw new Error("unreachable");
    expect(v.found).toBe(REQUIRED_TABLES.length);
  });

  test("the database name is always reported, pass or fail", () => {
    expect(backupGuard({ database: "wrong-db", tables: [] }).database).toBe("wrong-db");
    expect(backupGuard({ database: "right-db", tables: ALL }).database).toBe("right-db");
  });
});

describe("backupKey", () => {
  test("date-stamps so a bad run cannot overwrite a good backup", () => {
    expect(backupKey(new Date("2026-08-16T03:00:00Z"))).toBe(
      "gtm-job-search/2026-08-16.sql.gz"
    );
  });

  test("pads single-digit months and days", () => {
    expect(backupKey(new Date("2026-01-03T12:00:00Z"))).toBe(
      "gtm-job-search/2026-01-03.sql.gz"
    );
  });

  // UTC on purpose: this names a server-side artifact, so the key must not
  // depend on which timezone the job happened to run from.
  test("is UTC, not local", () => {
    // 23:30 UTC on the 16th is still the 16th, wherever the runner sits.
    expect(backupKey(new Date("2026-08-16T23:30:00Z"))).toBe(
      "gtm-job-search/2026-08-16.sql.gz"
    );
    expect(backupKey(new Date("2026-08-16T00:30:00Z"))).toBe(
      "gtm-job-search/2026-08-16.sql.gz"
    );
  });

  test("prefix is overridable for a second environment", () => {
    expect(backupKey(new Date("2026-08-16T03:00:00Z"), "staging")).toBe(
      "staging/2026-08-16.sql.gz"
    );
  });
});
