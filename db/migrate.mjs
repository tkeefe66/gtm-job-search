/**
 * Forward-only migration runner with a ledger.
 *
 *   railway run --service Postgres sh -c 'DATABASE_URL="$DATABASE_PUBLIC_URL" node db/migrate.mjs'
 *   node db/migrate.mjs --dry     # show what WOULD run, touch nothing
 *
 * WHY THIS EXISTS, when db/apply-schema.mjs already applies schema.sql:
 *
 * apply-schema.mjs is a CURRENT-STATE document built from `create table if not
 * exists` and `add column if not exists`, sent as one query. That idiom cannot
 * express the tenancy work at all:
 *
 *   - `ADD COLUMN ... NOT NULL` fails on a populated table; it needs three
 *     ordered steps (add nullable, backfill, set not null) and the backfill has
 *     to happen BETWEEN them.
 *   - `ALTER TABLE ... ADD PRIMARY KEY` has no IF NOT EXISTS form, so a second
 *     run errors and one error rolls back the whole file.
 *   - `CREATE POLICY IF NOT EXISTS` does not exist in any Postgres version.
 *   - `CREATE ROLE` is not idempotent.
 *   - A backfill that reads columns the same file later drops cannot be both a
 *     fresh-install script and a migration.
 *
 * So: numbered files, applied once, recorded in a ledger. schema.sql stays as
 * the fresh-install bootstrap and is no longer the mechanism for changes.
 *
 * Each file runs in ITS OWN transaction. A failure rolls that file back
 * completely and stops the run — later migrations do not proceed against a
 * half-applied earlier one, which is the state that is genuinely hard to
 * recover from.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const DIR = join(dirname(fileURLToPath(import.meta.url)), "migrations");
const DRY = process.argv.includes("--dry");

const url = process.env.DATABASE_URL || process.env.DATABASE_PUBLIC_URL;
if (!url) {
  console.error("migrate: set DATABASE_URL (or DATABASE_PUBLIC_URL) first.");
  process.exit(2);
}

const client = new pg.Client({
  connectionString: url,
  ssl: /sslmode=require|proxy\.rlwy\.net/.test(url) ? { rejectUnauthorized: false } : undefined,
});
await client.connect();

const { rows: dbRows } = await client.query("select current_database() as d");
// Logged every run for the same reason the backup logs it: when something has
// gone wrong, "which database did this run against" is the first question.
console.log(`migrate: database = ${dbRows[0].d}`);

await client.query(`
  create table if not exists schema_migrations (
    version    text primary key,
    applied_at timestamptz not null default now()
  )
`);

const { rows: done } = await client.query("select version from schema_migrations");
const applied = new Set(done.map((r) => r.version));

const files = readdirSync(DIR).filter((f) => f.endsWith(".sql")).sort();
const pending = files.filter((f) => !applied.has(f));

console.log(`migrate: ${files.length} migration(s) on disk, ${applied.size} already applied`);
if (pending.length === 0) {
  console.log("migrate: nothing to do");
  await client.end();
  process.exit(0);
}
console.log(`migrate: pending -> ${pending.join(", ")}`);

if (DRY) {
  console.log("migrate: --dry, nothing applied");
  await client.end();
  process.exit(0);
}

for (const file of pending) {
  const sql = readFileSync(join(DIR, file), "utf8");
  process.stdout.write(`migrate: applying ${file} ... `);
  try {
    // Per-file transaction. A migration that fails leaves NOTHING of itself
    // behind, and the run stops here rather than applying later files on top of
    // a partial one.
    await client.query("begin");
    await client.query(sql);
    await client.query("insert into schema_migrations (version) values ($1)", [file]);
    await client.query("commit");
    console.log("ok");
  } catch (err) {
    await client.query("rollback").catch(() => {});
    console.log("FAILED");
    // The message is shown because a migration failure is an operator-facing
    // event at a terminal, not a logged request — and a Postgres DDL error names
    // the constraint or column, which is the whole diagnostic value.
    console.error(`migrate: ${file} failed and was rolled back:\n${err.message}`);
    console.error("migrate: stopping. Later migrations were NOT applied.");
    await client.end();
    process.exit(1);
  }
}

await client.end();
console.log("migrate: done");
