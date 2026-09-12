import { Client } from "pg";

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
    await client.query(`select u.id, s."sessionToken", j.tenant_id, j.grading_attempts,
      k.aad_version, a.value from users u, sessions s, jobs j,
      tenant_api_keys k, app_settings a limit 0`);
    return true;
  } catch {
    return false;
  } finally {
    await client.end().catch(() => undefined);
  }
}
