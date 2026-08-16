/**
 * Nightly backup: pg_dump the app database to Cloudflare R2, date-stamped.
 *
 * Run as its own Railway cron service — NEVER on `web`. The dump credential can
 * read every row in the database; a service that serves HTTP requests should not
 * hold it, so that compromising the app does not hand over the data.
 *
 *   node db/backup.mjs            # real run
 *   node db/backup.mjs --dry      # guard + pg_dump, no upload
 *
 * Required env (see README):
 *   PGHOST PGPORT PGUSER PGPASSWORD PGDATABASE
 *   R2_ACCOUNT_ID R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY R2_BUCKET
 */
import { spawn } from "node:child_process";
import { createGzip } from "node:zlib";
import { pipeline } from "node:stream/promises";
import { createReadStream, createWriteStream, statSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { backupGuard, backupKey } from "../lib/backup-guard.mjs";

const DRY = process.argv.includes("--dry");

/**
 * Composed from DISCRETE variables, never by parsing a URL.
 *
 * `urlparse`-style parsing does not percent-decode, so a password containing
 * `@` or `%` silently authenticates as the wrong string — a failure that looks
 * like bad credentials rather than a parsing bug. Railway exposes the discrete
 * PG* variables; use them.
 *
 * PGDATABASE is pinned explicitly rather than defaulted, because defaulting is
 * exactly how a job ends up dumping Railway's empty `railway` database.
 */
function conn() {
  const need = ["PGHOST", "PGUSER", "PGPASSWORD", "PGDATABASE"];
  const missing = need.filter((k) => !process.env[k]);
  if (missing.length) {
    console.error(`backup: refusing — missing env: ${missing.join(", ")}`);
    process.exit(2);
  }
  return {
    host: process.env.PGHOST,
    port: Number(process.env.PGPORT || 5432),
    user: process.env.PGUSER,
    password: process.env.PGPASSWORD,
    database: process.env.PGDATABASE,
    ssl: { rejectUnauthorized: false },
  };
}

async function main() {
  const cfg = conn();
  const client = new pg.Client(cfg);
  await client.connect();

  const { rows: dbRow } = await client.query("select current_database() as d");
  const database = dbRow[0].d;

  // information_schema.tables only shows tables the CURRENT ROLE holds some
  // privilege on, so a permissions change could hide tables and fake a
  // "wrong database" verdict. pg_tables is not privilege-filtered.
  const { rows } = await client.query(
    "select tablename from pg_tables where schemaname = 'public'"
  );
  await client.end();

  // Logged on EVERY run, pass or fail. When a backup is eventually restored,
  // the first question is "which database did this come from" and the log is
  // the only place that can answer it.
  console.log(`backup: source database = ${database}`);

  const verdict = backupGuard({ database, tables: rows.map((r) => r.tablename) });
  if (!verdict.ok) {
    console.error(`backup: REFUSED — ${verdict.reason}`);
    process.exit(1); // non-zero so the cron reports failure rather than success
  }
  console.log(`backup: guard passed (${verdict.found} app tables present)`);

  const key = backupKey(new Date());
  const gz = join(tmpdir(), "dump.sql.gz");

  // Credentials via env, never argv: a spawn failure's message embeds the whole
  // command line, and argv is visible in `ps` regardless of logging.
  //
  // stdout is "pipe" and streamed, NOT a createWriteStream handed to stdio.
  // spawn requires an already-open descriptor there, and a fresh WriteStream has
  // none yet — it throws TypeError before pg_dump ever runs. Streaming also means
  // the uncompressed dump never touches disk.
  const child = spawn("pg_dump", ["--no-owner", "--no-acl", "-d", cfg.database], {
    env: { ...process.env, PGPASSWORD: cfg.password },
    stdio: ["ignore", "pipe", "inherit"],
  });

  const exited = new Promise((resolve, reject) => {
    // Our own error text, built from the exit code — the child's own message
    // would carry the connection string.
    child.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`pg_dump exited ${code}`))
    );
    child.on("error", () => reject(new Error("pg_dump could not be started")));
  });

  // Both, not just the pipeline: a pg_dump that dies mid-stream still produces a
  // well-formed truncated gzip, so awaiting only the pipeline would report a
  // partial dump as success — the same "green job, no backup" failure the guard
  // above exists to prevent, reached one step later.
  await Promise.all([pipeline(child.stdout, createGzip(), createWriteStream(gz)), exited]);

  const bytes = statSync(gz).size;
  console.log(`backup: dumped ${bytes} bytes -> ${key}`);

  if (DRY) {
    console.log("backup: --dry, not uploading");
    unlinkSync(gz);
    return;
  }

  const { S3Client, PutObjectCommand } = await import("@aws-sdk/client-s3");
  const s3 = new S3Client({
    region: "auto",
    endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    },
  });
  await s3.send(
    new PutObjectCommand({
      Bucket: process.env.R2_BUCKET,
      Key: key,
      Body: createReadStream(gz),
      ContentLength: bytes,
    })
  );
  console.log(`backup: uploaded ${key} (${bytes} bytes)`);

  unlinkSync(gz);
}

main().catch((err) => {
  // A closed set of text, not the thrown message: driver and HTTP errors put
  // connection strings and signed URLs into exception text, and this output
  // goes to a log aggregator.
  console.error(`backup: FAILED — see logs (${err instanceof Error ? err.name : "unknown"})`);
  // Detail ONLY on an operator-driven dry run. Scheduled runs ship their output
  // to a log aggregator, and driver/HTTP exception text is where connection
  // strings and signed URLs get constructed — the leak path this repo's
  // redaction rule exists to close. A dry run is typed by a human at a terminal.
  if (DRY) console.error(err);
  process.exit(1);
});
