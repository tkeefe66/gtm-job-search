/**
 * Decides whether a dump is allowed to be written, given what the source
 * database actually contains.
 *
 * WHY THIS EXISTS: a green backup job is not evidence of a backup.
 *
 * Railway's `${{Postgres.DATABASE_URL}}` reference points at the platform's
 * DEFAULT database (`PGDATABASE=railway`), which is frequently not the one an
 * app created its tables in. `pg_dump` against the wrong database succeeds — it
 * dumps an empty schema, uploads a valid few-kilobyte file over the previous
 * good backup's key, and reports success. Every signal says healthy and the
 * recovery point is gone.
 *
 * So the job asserts, before writing a single byte, that the app's own tables
 * exist in the source it is about to dump.
 */

/**
 * TABLES, not rows.
 *
 * A row-count or dump-size threshold looks equivalent and is not: a legitimately
 * empty install still has a full schema, so a row check false-positives on it
 * and refuses a backup that should have been taken. A wrong database has no app
 * tables at all. Presence of the schema is the signal that distinguishes them.
 */
export const REQUIRED_TABLES = [
  "jobs",
  "watchlist",
  "app_settings",
  "discovered_roles",
  "discovered_startups",
  "crawl_runs",
  "role_searches",
];

/**
 * `found` counts only tables we require. Extra tables are irrelevant — a
 * superset is still the right database.
 */
export function backupGuard(input) {
  const present = new Set(input.tables);
  const missing = REQUIRED_TABLES.filter((t) => !present.has(t));

  if (missing.length === REQUIRED_TABLES.length) {
    return {
      ok: false,
      database: input.database,
      missing: [...missing],
      // Named separately from the partial case because the operator response
      // differs: this one means "you are pointed at the wrong database", which
      // is a configuration fix, not a migration.
      reason:
        `none of the app's ${REQUIRED_TABLES.length} tables exist in "${input.database}" — ` +
        `this is almost certainly the wrong database (Railway's default is "railway", ` +
        `which is not where this app's schema lives). Refusing to write a dump that ` +
        `would overwrite a good backup with an empty one.`,
    };
  }

  if (missing.length > 0) {
    return {
      ok: false,
      database: input.database,
      missing: [...missing],
      // Deliberately also a refusal. A partial schema means either a half-applied
      // migration or a database that is not the one we think; dumping it would
      // produce a backup that restores into a broken app, which is worse than no
      // backup because it looks like one.
      reason:
        `"${input.database}" is missing ${missing.length} of the app's tables ` +
        `(${missing.join(", ")}). Refusing: a partial schema restores into a broken ` +
        `app while still looking like a successful backup.`,
    };
  }

  return { ok: true, database: input.database, found: REQUIRED_TABLES.length };
}

/**
 * Date-stamped object key.
 *
 * The stamp is what stops a bad run from destroying a good backup: with a fixed
 * key like `latest.sql.gz`, one refused-then-forced or corrupt run overwrites
 * the only copy. With a date, the worst case is one missing day.
 *
 * UTC deliberately, unlike lib/applied-date.ts's local stamp — this names a
 * server-side artifact, not a date a user reads, and the job may run from any
 * timezone. Keeping it UTC means the key is the same whoever triggers it.
 */
export function backupKey(now, prefix = "gtm-job-search") {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  const d = String(now.getUTCDate()).padStart(2, "0");
  return `${prefix}/${y}-${m}-${d}.sql.gz`;
}
