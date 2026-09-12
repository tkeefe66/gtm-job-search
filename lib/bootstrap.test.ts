import { describe, expect, it, vi } from "vitest";
import { provisionAdmin } from "../db/provision-admin.mjs";
import { migrateDatabase } from "../db/migration-runner.mjs";
import { readdirSync } from "node:fs";

describe("database bootstrap safety", () => {
  it("refuses a populated unknown schema before running baseline DDL", async () => {
    // Mutation caught: bootstrap emptiness guard removed.
    const client = { query: vi.fn(async (sql: string) => ({ rows: sql.includes("pg_tables") ? [{ tablename: "jobs" }] : [] })) };
    await expect(migrateDatabase(client, { bootstrap: true })).rejects.toThrow("empty public schema");
    expect(client.query.mock.calls.some(([sql]) => /create table|begin/i.test(sql))).toBe(false);
  });

  it("dry runs a legacy baseline without creating its missing ledger", async () => {
    // Mutation caught: creating schema_migrations before checking --dry.
    const client = { query: vi.fn(async (sql: string) => ({ rows: sql.includes("pg_tables") ? [{ tablename: "users" }] : [] })) };
    await migrateDatabase(client, { dry: true });
    expect(client.query.mock.calls.some(([sql]) => /create|insert|revoke|begin/i.test(sql))).toBe(false);
  });

  it("repairs historical ledger grants even when all migrations are already applied", async () => {
    // Mutation caught: revoking ledger grants only inside the pending-file loop.
    const versions = readdirSync(new URL("../db/migrations/", import.meta.url)).filter(f => f.endsWith(".sql"));
    const client = { query: vi.fn(async (sql: string) => ({ rows: sql.includes("pg_tables")
      ? [{ tablename: "schema_migrations" }, { tablename: "users" }]
      : sql === "select version from schema_migrations" ? versions.map(version => ({ version })) : [] })) };
    await migrateDatabase(client);
    expect(client.query.mock.calls.some(([sql]) => sql.includes("revoke all on schema_migrations from app_rw"))).toBe(true);
    expect(client.query.mock.calls.some(([sql]) => sql === "begin")).toBe(false);
  });

  it("refuses missing and ambiguous administrator identities without a write", async () => {
    // Mutation caught: selecting the first matching email or accepting no linked identity.
    for (const rows of [[], [{ id: "one" }, { id: "two" }]]) {
      const client = { query: vi.fn(async () => ({ rows })) };
      await expect(provisionAdmin(client, "owner@example.test")).rejects.toThrow("exactly one");
      expect(client.query).toHaveBeenCalledTimes(1);
    }
  });

  it("promotes only the selected linked identity using parameters", async () => {
    // Mutation caught: email interpolated into SQL or role updated without selected user id.
    const client = { query: vi.fn(async () => ({ rows: [{ id: "selected-user" }] })) };
    await provisionAdmin(client, " owner@example.test ");
    expect(client.query).toHaveBeenNthCalledWith(1, expect.stringContaining('a."providerAccountId" = u.google_sub'), ["owner@example.test"]);
    expect(client.query).toHaveBeenNthCalledWith(2, "update users set role = 'admin' where id = $1", ["selected-user"]);
  });
});
