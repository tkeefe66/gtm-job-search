# GTM Job Search

A multi-tenant job search app with Google sign-in. Each user's onboarding profile supplies career targets, location preferences and fit-scoring criteria. Discover searches hiring signals and roles; Watchlist schedules company checks; Roles holds the job pipeline and résumé tools; Settings controls the profile, limits and API key. Administrators manage accounts and platform settings through `/admin`.

Next.js 15 (App Router), React 19, TypeScript, Tailwind, PostgreSQL, Auth.js and Anthropic web search. The query layer in `lib/supabase.ts` uses `pg`; no Supabase service is required. Model calls and stored API keys remain server-side. Tenant tables use forced row-level security with the restricted `app_rw` database role.

## Fresh local setup

1. Run `npm install`. Provision an **empty PostgreSQL database** and retain its owner connection URL for setup and upgrades. The owner must be able to create the `pgcrypto` extension and manage roles. Keep this credential separate from the application runtime.

2. Bootstrap the database using the owner's URL in the shell:

   ```bash
   DATABASE_URL="$DATABASE_OWNER_URL" node db/apply-schema.mjs
   ```

   This applies the historical baseline in `db/schema.sql`, then every numbered migration in `db/migrations/`. It creates auth tables, tenant columns and constraints, current résumé/grading tables, RLS policies and grants. The obsolete insights cache is removed by its migration. Each migration and its ledger entry commit together; a failure stops the sequence and rolls back that migration. Re-run the same command to resume. Subsequent successful runs apply only pending migrations. The baseline is never replayed on an existing installation; unrecognized populated schemas are refused.

   No user or OAuth account is seeded. Migrations 001/002 allow an empty database without an admin, but still refuse populated legacy tables with no owner. This avoids Auth.js rejecting a pre-seeded email with `OAuthAccountNotLinked`.

3. Enable login for `app_rw` using an owner `psql` session:

   ```sql
   ALTER ROLE app_rw LOGIN;
   ```

   Use the interactive psql command `\password app_rw` to set a strong password without putting it in SQL files or command history. Build the runtime URL with username `app_rw` and its password (URL-encode reserved password characters). This role must remain `NOSUPERUSER NOBYPASSRLS`, and must not own the tables. Do not run the web app with the owner URL.

4. Configure a Google OAuth web client. Register `http://localhost:3000/api/auth/callback/google` as an authorized redirect URI. Put runtime configuration into gitignored `.env.local`:

   ```dotenv
   DATABASE_URL=postgres://app_rw:URL_ENCODED_PASSWORD@localhost:5432/DATABASE_NAME
   AUTH_GOOGLE_ID=YOUR_GOOGLE_CLIENT_ID
   AUTH_GOOGLE_SECRET=YOUR_GOOGLE_CLIENT_SECRET
   AUTH_SECRET=YOUR_RANDOM_SESSION_SECRET
   AUTH_URL=http://localhost:3000
   ADMIN_EMAIL=YOUR_GOOGLE_EMAIL
   APP_ENCRYPTION_KEY=YOUR_64_HEX_CHARACTER_KEY
   ANTHROPIC_API_KEY=YOUR_PLATFORM_ANTHROPIC_KEY
   CRON_SECRET=YOUR_RANDOM_CRON_SECRET
   ```

   Generate independent secrets, for example `openssl rand -base64 32` for session/cron secrets and `openssl rand -hex 32` for the encryption key. Keep the encryption key durable: replacing it makes existing stored tenant API keys unreadable. Ordinary users supply their own Anthropic key; the platform key supports the administrator's model calls. Node setup scripts read shell environment variables; they do not automatically load `.env.local`.

5. Run `npm run dev`, open [localhost:3000](http://localhost:3000), and sign in with the intended administrator's Google account. New accounts are active; onboarding opens at `/welcome`. Then promote that real linked account using the owner URL and explicit email in the shell:

   ```bash
   DATABASE_URL="$DATABASE_OWNER_URL" ADMIN_EMAIL="$ADMIN_EMAIL" node db/provision-admin.mjs
   ```

   The command requires one active user with a matching linked Google identity and fails without changing anything if signup has not happened. It never fabricates an account or reactivates a suspended user. The runtime role cannot grant administrator privileges; the first-signup automatic promotion warning is expected. Reload `/admin` after promotion, then finish onboarding before searching.

## Existing database upgrades

Back up the database first. Keep its users, accounts, tenant ownership and `schema_migrations` ledger. Run upgrades using the owner's URL:

```bash
DATABASE_URL="$DATABASE_OWNER_URL" node db/migrate.mjs --dry
DATABASE_URL="$DATABASE_OWNER_URL" node db/migrate.mjs
```

The dry run reads without changing the schema or ledger. Applied migrations are skipped; each new migration runs in its own transaction. Do not manually replay `db/schema.sql` or migration 003: replaying its blanket grants would reopen admin-column permissions. A legacy installation predating tenant migrations needs an existing real administrator to own its historical rows before migrations 001/002; those guards deliberately fail if ownership cannot be established.

## Railway deployment

Confirm project `gtm-job-search`, service `web` before deployment. Configure the same runtime settings, an HTTPS `AUTH_URL`, the production Google callback URI, and `AUTH_TRUST_HOST=true` for the trusted Railway proxy. Use an `app_rw` connection URL on `web`; retain owner credentials only for operator setup, upgrades and backups. Local operator scripts need Railway's public database URL; container traffic can use its private host. Configure TLS according to the database endpoint and CA; these scripts honor the connection URL's PostgreSQL TLS options.

Apply pending migrations and run `npm run build` and `npm test` before releasing code that needs the new schema. The configured GitHub `main` branch deploys automatically on push. `railway up --service web --detach` is the manual alternative and uploads the working directory; `.railwayignore` must exclude local secrets. Verify Railway reports success for the intended commit, then verify the authenticated live route.

The separate `crawler` service needs `WEB_URL` and the same `CRON_SECRET` as `web`. Cron routes `/api/cron/crawl-next`, `/api/cron/crawl` and `/api/cron/purge-resumes` require that bearer secret.

`/api/health` is intentionally public and returns only `ok` (200) or `unavailable` (503). It checks database connectivity and essential schema permissions without reading tenant records, using bounded connection/query timeouts. Configure the web service healthcheck path to `/api/health` with a 60-second startup allowance; `railway.toml` declares these settings for services using repository configuration. Confirm effective settings in Railway before release. This deployment readiness check is not continuous uptime monitoring.

Backup service packaging, storage manifests and isolated restore instructions are in [docs/recovery.md](docs/recovery.md).

## Verification

```bash
npm run build
npm test
```

The build includes the production TypeScript and lint checks. `npm run lint` is not a configured standalone check. An optional isolated PostgreSQL bootstrap integration test is documented in `db/bootstrap-smoke.mjs`; it never reads the application's runtime database URL.
