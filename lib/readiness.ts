import { Client } from "pg";

/** Resolve columns and grants without reading tenant records. Also exercised
 * against the complete migration chain in the schema integration test. */
export const READINESS_SCHEMA_SQL = `select u.id, s."sessionToken", j.tenant_id, j.grading_attempts,
  j.disposition, q.started_at, r.source_url, e.disposition_reason,
  k.aad_version, a.value, w.allow_paid_search, w.next_attempt_at,
  w.last_attempted_at, w.last_successful_check_at, w.model_retry_after,
  c.closure_eligible, p.criteria_fingerprint, o.tenant_id, o.billed_to,
  o.last_activity_at, x.tenant_id, x.pricing_snapshot, b.verified_at, b.evidence_kind
  from users u, sessions s, jobs j, tenant_api_keys k, app_settings a,
  source_quality_launch q, job_source_records r, job_disposition_events e,
  watchlist w, crawl_runs c, company_crawl_snapshots p, company_boards b,
  ai_operations o, ai_usage_requests x limit 0`;

/** A separate, bounded connection keeps probes out of the application's pool. */
export async function databaseReady(): Promise<boolean> {
  const connectionString = process.env.DATABASE_URL || process.env.DATABASE_PUBLIC_URL;
  if (!connectionString) return false;
  const client = new Client({
    connectionString,
    connectionTimeoutMillis: 1500,
    statement_timeout: 1500,
    query_timeout: 1800,
  });
  client.on("error", () => { /* Request reports unavailable; never expose connection details. */ });
  try {
    await client.connect();
    // Parse and permission-check critical schema without reading tenant records.
    await client.query(READINESS_SCHEMA_SQL);
    return true;
  } catch {
    return false;
  } finally {
    await client.end().catch(() => undefined);
  }
}
