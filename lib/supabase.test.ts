import { describe, expect, test, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describeThrown, isTenantTable, supabase, TENANT_TABLES } from "./supabase";
import { UNDESCRIBED_DB_ERROR } from "./write-failure";

// describeThrown is the only part of lib/supabase.ts reachable without a live
// pool — and it is the part carrying a decision, so it is the part worth
// pinning. Everything around it (build/execute/rawQuery) needs a database:
// SKIPPED, deliberately, not overlooked.

describe("describeThrown keeps the transport honest", () => {
  test("an ordinary driver error passes through verbatim", () => {
    expect(describeThrown(new Error("getaddrinfo ENOTFOUND db.invalid"))).toEqual({
      message: "getaddrinfo ENOTFOUND db.invalid",
    });
  });

  test("an AggregateError's EMPTY message is preserved, not filled in", () => {
    // The doctrine, stated as an assertion. Filling `message` from
    // aggregateCauses(e) reads like an improvement and is the opposite: it
    // makes the empty message impossible, which turns every presence check in
    // this codebase into untestable dead code. lib/settings-store.ts's comment
    // is explicit that a transport which invents text breaks the half that
    // actually matters.
    const agg = new AggregateError(
      [new Error("connect ECONNREFUSED ::1:5432"), new Error("connect ECONNREFUSED 127.0.0.1:5432")],
      ""
    );
    expect(describeThrown(agg)).toEqual({ message: "" });
    // And it must not smuggle the stand-in in through the back door either —
    // substitution belongs at the point of DISPLAY.
    expect(describeThrown(agg).message).not.toContain(UNDESCRIBED_DB_ERROR);
  });

  test("the hidden causes reach the LOG, which is the only place they exist", () => {
    // The other half: preserving "" must not mean throwing the diagnostic
    // away. lib/supabase.ts's catch is the last point in the process that can
    // still see .errors[].
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      describeThrown(new AggregateError([new Error("connect ECONNREFUSED ::1:5432")], ""));
      expect(spy).toHaveBeenCalledTimes(1);
      const line = String(spy.mock.calls[0][0]);
      expect(line).toContain("connect ECONNREFUSED ::1:5432");
      expect(line).toContain("unreachable entirely");
    } finally {
      spy.mockRestore();
    }
  });

  test("a described failure logs NOTHING — the log line is for the blind case only", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      describeThrown(new Error("relation \"jobs\" does not exist"));
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  test("a non-Error throwable is stringified rather than lost", () => {
    expect(describeThrown("a bare string")).toEqual({ message: "a bare string" });
  });
});

describe("tenant scoping", () => {
  // The registry decides which tables are protected, and a table MISSING from it
  // is silently treated as global — so the failure mode of forgetting is shared
  // data, not an error. That is exactly the leak this pins: the list is checked
  // against db/schema.sql, so adding a `tenant_id` column without classifying
  // the table fails here rather than in production.
  test("every table with a tenant_id column is registered as tenant-scoped", () => {
    const schema = readFileSync(
      path.join(__dirname, "..", "db", "schema.sql"),
      "utf8"
    );
    const migration = readFileSync(
      path.join(__dirname, "..", "db", "migrations", "001_tenant_id.sql"),
      "utf8"
    );
    const sql = `${schema}\n${migration}`;

    const scoped = new Set<string>();
    for (const m of sql.matchAll(/alter table (\w+)\s+add column if not exists tenant_id/gi)) {
      scoped.add(m[1]);
    }
    expect(scoped.size).toBeGreaterThan(0);

    for (const table of scoped) {
      expect(
        isTenantTable(table),
        `${table} has a tenant_id column but is not in TENANT_TABLES — every query against it would be unscoped and read every tenant's rows`
      ).toBe(true);
    }
  });

  test("an unscoped query against a tenant table throws rather than returning rows", () => {
    for (const table of TENANT_TABLES) {
      expect(() => supabase.from(table)).toThrow(/tenant-scoped/);
    }
  });

  test("global tables are still reachable without a tenant", () => {
    expect(() => supabase.from("discovered_startups")).not.toThrow();
    expect(() => supabase.from("crawl_runs")).not.toThrow();
  });

  // An empty string would build `tenant_id = ''`, which matches nothing and
  // reads as "this tenant has no data" — silent-empty, the failure this design
  // exists to avoid.
  test("forTenant refuses an empty tenant id", () => {
    expect(() => supabase.forTenant("")).toThrow(/requires a tenant id/);
  });
});
