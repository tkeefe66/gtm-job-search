// Run as database owner AFTER the intended administrator signs in with Google.
import { fileURLToPath } from "node:url";
import pg from "pg";
export async function provisionAdmin(client, email) {
  if (!email?.trim()) throw new Error("Set ADMIN_EMAIL to the intended administrator's Google email.");
  const { rows } = await client.query(`select u.id from users u
    where lower(u.email) = lower($1) and u.status = 'active'
    and u.google_sub is not null and exists (
      select 1 from accounts a where a."userId" = u.id
      and a.provider = 'google' and a."providerAccountId" = u.google_sub
    )`, [email.trim()]);
  if (rows.length !== 1) throw new Error("Expected exactly one active user with a linked Google identity. Sign in with the intended account first; no user was created or promoted.");
  await client.query("update users set role = 'admin' where id = $1", [rows[0].id]);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const connectionString = process.env.DATABASE_URL || process.env.DATABASE_PUBLIC_URL;
  const client = new pg.Client({ connectionString });
  try {
    if (!connectionString) throw new Error("Set DATABASE_URL to the database owner's URL.");
    await client.connect();
    await provisionAdmin(client, process.env.ADMIN_EMAIL);
    console.log("Configured Google account promoted to admin.");
  } catch (error) { console.error(`Admin provisioning failed: ${error.message}`); process.exitCode = 1; }
  finally { await client.end(); }
}
