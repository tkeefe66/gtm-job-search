// One-shot back-fill: flags the roles that were already dead when ingest first
// saw them, for rows inserted before the never_live column existed.
//
// Usage (dry run, prints the rows and changes nothing):
//   railway run --service Postgres node db/backfill-never-live.mjs
// Then, to write:
//   railway run --service Postgres node db/backfill-never-live.mjs --apply
//
// `railway run` injects the PRIVATE DATABASE_URL (postgres.railway.internal),
// which is IPv6-only and unreachable from a laptop — hence the PUBLIC url
// first. Reversed, this connects to nothing and the failure is silent.
import pg from "pg";

const url = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;
if (!url) {
  console.error("Set DATABASE_PUBLIC_URL (or DATABASE_URL) before running.");
  process.exit(1);
}

const apply = process.argv.includes("--apply");

// The one definition of "was already dead when we found it", for rows that
// predate the column. Three conditions, two of them independent signals:
// unscored (ingest skips scoring for a dead role) and never touched after
// insert (the crawler and link-health both stamp updated_at when they close a
// role). `never_live = false` makes a re-run a no-op.
const PREDICATE = `
  status = 'Posting Closed'
  and fit_score is null
  and updated_at = created_at
  and never_live = false`;

const client = new pg.Client({
  connectionString: url,
  ssl: /sslmode=require/.test(url) ? { rejectUnauthorized: false } : undefined,
});

// ALWAYS print the error channel, never just the rows: `pg` rejects with an
// AggregateError whose message is the EMPTY STRING when every address of a
// dual-stack host refuses, and four such failures once read as "empty tables".
try {
  await client.connect();
} catch (e) {
  console.error(`Connect failed: name=${e?.name} message=${JSON.stringify(e?.message)}`);
  for (const sub of e?.errors ?? []) {
    console.error(`  cause: ${sub?.code} ${JSON.stringify(sub?.message)}`);
  }
  process.exit(1);
}

try {
  const { rows } = await client.query(
    `select id, company, role_title, source,
            to_char(created_at, 'YYYY-MM-DD HH24:MI') as created
       from jobs where ${PREDICATE} order by created_at`
  );

  console.log(`\n${rows.length} row(s) match:`);
  for (const r of rows) {
    console.log(`  ${r.created}  ${r.company} — ${r.role_title}  (${r.source})`);
  }

  if (!apply) {
    console.log("\nDry run. Nothing written. Re-run with --apply to flag these rows.");
  } else if (rows.length === 0) {
    console.log("\nNothing to do.");
  } else {
    const res = await client.query(`update jobs set never_live = true where ${PREDICATE}`);
    if (res.rowCount !== rows.length) {
      console.error(
        `MISMATCH: selected ${rows.length} rows but updated ${res.rowCount}. ` +
          `Investigate before trusting the tiles.`
      );
      process.exitCode = 1;
    } else {
      console.log(`\nFlagged ${res.rowCount} row(s) never_live.`);
    }
  }
} catch (e) {
  console.error(`Query failed: name=${e?.name} message=${JSON.stringify(e?.message)}`);
  process.exitCode = 1;
} finally {
  await client.end();
}
