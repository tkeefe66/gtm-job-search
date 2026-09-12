import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import pg from "pg";

const DIR = fileURLToPath(new URL("./migrations/", import.meta.url));
const BASELINE = "000_bootstrap";
const LOCK = 741926035; // Serialize bootstrap and upgrades against this database.
const ledgerSql = `create table if not exists schema_migrations (
  version text primary key, applied_at timestamptz not null default now()
)`;

export async function migrateDatabase(client, { bootstrap = false, dry = false } = {}) {
  await client.query("select pg_advisory_lock($1)", [LOCK]);
  try {
    const { rows: tables } = await client.query(
      "select tablename from pg_tables where schemaname = 'public'"
    );
    const hasLedger = tables.some((r) => r.tablename === "schema_migrations");
    const applied = new Set(hasLedger
      ? (await client.query("select version from schema_migrations")).rows.map((r) => r.version)
      : []);
    if (bootstrap && !applied.has(BASELINE)) {
      if (tables.length) throw new Error("Bootstrap requires an empty public schema. Existing databases must use db/migrate.mjs; no schema was reapplied.");
      await client.query("begin");
      try {
        await client.query(readFileSync(new URL("./schema.sql", import.meta.url), "utf8"));
        await client.query(ledgerSql);
        await client.query("insert into schema_migrations(version) values ($1)", [BASELINE]);
        await client.query("commit");
        applied.add(BASELINE);
      } catch (error) {
        await client.query("rollback");
        throw error;
      }
    } else if (!hasLedger && !tables.some((r) => r.tablename === "users")) {
      throw new Error("No application baseline found. Run db/apply-schema.mjs on an empty database first.");
    }

    const pending = readdirSync(DIR).filter((f) => /^\d+.*\.sql$/.test(f)).sort()
      .filter((f) => !applied.has(f));
    console.log(`migrate: ${pending.length} pending migration(s)${dry ? " (dry run)" : ""}`);
    if (dry) { console.log(pending.join("\n")); return; }
    await client.query(ledgerSql);
    // 003 grants every table to app_rw. The ledger is operator state.
    for (const file of pending) {
      await client.query("begin");
      try {
        await client.query(readFileSync(`${DIR}/${file}`, "utf8"));
        await client.query("insert into schema_migrations(version) values ($1)", [file]);
        await client.query(`do $$ begin
          if exists (select 1 from pg_roles where rolname = 'app_rw') then
            revoke all on schema_migrations from app_rw;
          end if;
        end $$`);
        await client.query("commit");
        console.log(`migrate: ${file} applied`);
      } catch (error) {
        await client.query("rollback");
        throw new Error(`${file} failed and was rolled back; later migrations were not applied: ${error.message}`);
      }
    }
    // Already-current installations received 003's historical blanket grant.
    // Repair those too, even when there are no pending migration files.
    await client.query(`do $$ begin
      if exists (select 1 from pg_roles where rolname = 'app_rw') then
        revoke all on schema_migrations from app_rw;
      end if;
    end $$`);
  } finally {
    await client.query("select pg_advisory_unlock($1)", [LOCK]);
  }
}

export async function runDatabaseCommand(options) {
  const connectionString = process.env.DATABASE_URL || process.env.DATABASE_PUBLIC_URL;
  if (!connectionString) { console.error("Set DATABASE_URL (or DATABASE_PUBLIC_URL) to the database owner's URL first."); process.exitCode = 2; return; }
  const client = new pg.Client({ connectionString });
  try {
    await client.connect();
    const { rows } = await client.query("select current_database() as db");
    console.log(`migrate: database = ${rows[0].db}`);
    await migrateDatabase(client, options);
    console.log("migrate: done");
  } catch (error) {
    console.error(`Database setup failed: ${error.message}`);
    process.exitCode = 1;
  } finally { await client.end(); }
}
