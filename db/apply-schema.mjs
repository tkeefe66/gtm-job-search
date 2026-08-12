// Applies db/schema.sql to a Postgres database.
// Usage: DATABASE_URL=postgres://... node db/apply-schema.mjs
// (Use DATABASE_PUBLIC_URL when running from outside Railway's network.)
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import pg from "pg";

const url = process.env.DATABASE_URL || process.env.DATABASE_PUBLIC_URL;
if (!url) {
  console.error("Set DATABASE_URL (or DATABASE_PUBLIC_URL) before running.");
  process.exit(1);
}

const here = dirname(fileURLToPath(import.meta.url));
const sql = readFileSync(join(here, "schema.sql"), "utf8");

const client = new pg.Client({
  connectionString: url,
  ssl: /sslmode=require/.test(url) ? { rejectUnauthorized: false } : undefined,
});

try {
  await client.connect();
  await client.query(sql);
  const { rows } = await client.query(
    "select table_name from information_schema.tables where table_schema = 'public' order by table_name"
  );
  console.log("Schema applied. Tables:", rows.map((r) => r.table_name).join(", "));
} catch (e) {
  console.error("Failed to apply schema:", e.message);
  process.exit(1);
} finally {
  await client.end();
}
