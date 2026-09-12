# Backup and isolated recovery

`db/backup.mjs` belongs on the dedicated Railway `backup` cron service, never on `web`. A configured credential is not evidence of a scheduled or successful backup. Configure the service source, build/start command (`node db/backup.mjs`), PostgreSQL client executable and cron schedule explicitly. Agree the maximum acceptable data loss (RPO) and recovery time (RTO) before choosing schedule and retention. Confirm the latest successful artifact **and matching manifest**, then run an isolated recovery drill. Wiring and running that service is an operational action separate from these code changes.

## Dedicated deployment packaging

`Dockerfile.backup` builds from the repository root and combines Node 22 with PostgreSQL 18 client tools. It installs production dependencies from the committed npm lockfile, including `pg` and the R2 S3 client, and copies both `db/recovery-metadata.mjs` and `lib/backup-guard.mjs` alongside the backup script. Its dedicated Docker ignore allowlist excludes workspace secrets and audit evidence from the build context. It runs as the unprivileged `postgres` OS user and clears the base image database entrypoint; it only runs the backup script. Verify the source database major is no newer than 18 before using this image.

For the existing `backup` Railway service, select repository root as build context and `/railway.backup.json` as its service-specific configuration file. Do **not** leave backup on root `railway.toml`: that file configures the web HTTP healthcheck, which a one-shot backup cannot serve. The backup config explicitly clears `healthcheckPath`, uses `Dockerfile.backup`, sets restart policy to `NEVER`, and proposes nightly execution at `06:00 UTC` (`0 6 * * *`). Confirm that schedule against the agreed RPO and set failure notifications before activation. No public domain, web listener or persistent database volume is needed on the backup service. Existing service settings are not changed merely by adding these files.

[Railway's configuration documentation](https://docs.railway.com/config-as-code) currently describes Config as Code as deprecated, with continued support for eligible existing services until December 1, 2026 and no opt-in for new services. Verify this existing service's eligibility before deployment. If it cannot select this config, apply the equivalent source/build/start/cron/restart settings through the supported service settings or Railway Infrastructure as Code workflow, explicitly clear the healthcheck, and verify the resulting deployment configuration. Do not deploy a cron service with the web config as a fallback. See [Railway's field reference](https://docs.railway.com/config-as-code/reference) for nullable healthcheck and Dockerfile settings.

Local packaging check (no credentials required):

```sh
docker build -f Dockerfile.backup -t readiness-backup-test .
docker run --rm --entrypoint node readiness-backup-test --check db/backup.mjs
docker run --rm --entrypoint pg_dump readiness-backup-test --version
```

Backup requires discrete `PGHOST`, `PGPORT`, `PGUSER`, `PGPASSWORD`, `PGDATABASE`, plus `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`. Keep credentials in the dedicated service. `node db/backup.mjs --dry` still reads and dumps real data; it does not upload. Run only with authorization to handle that source. PostgreSQL client's major version must support the source server version. Backup reads every row; its credential must bypass tenant RLS and see all relevant grants/catalog objects. Source connection currently retains the existing Railway TLS behavior; certificate validation is not strengthened by this change.

Every run uploads a unique dated `.sql.gz` and a `.sql.gz.manifest.json` companion. The manifest is uploaded last and marks completion; orphan dump objects without manifests are not verified recovery points. Uploads have a two-minute deadline. A failed upload cannot overwrite an earlier successful run. Apply a storage retention/lifecycle policy that retains matching artifact/manifest pairs and eventually removes incomplete uploads. File creation uses a unique owner-only temporary directory and files; normal failures and SIGINT/SIGTERM remove them. SIGKILL, host loss, exhausted storage and abrupt process termination cannot run cleanup; ephemeral storage and restricted host access remain necessary. Dump generation/metadata count duration is not capped, so monitor cron runtime and disk capacity.

The dump and counts share a PostgreSQL repeatable-read exported snapshot. The manifest contains table counts and catalog metadata (columns, constraints, indexes, policies, functions and non-owner table/column grants), a timestamp and a SHA-256 of the compressed object. Treat it as private operational metadata: it reveals database structure and sizes, and definitions/default expressions may contain application configuration. It contains no queried row values. SHA-256 detects corruption against the matching manifest; it is not a signature protecting against an attacker able to replace both objects.

## Operator restore command

Retrieve one authorized **stored artifact and its matching manifest** from private storage using your approved operator process. The verifier does not fetch/download backups and does not dump the current source. Old backups without manifests need a separately reviewed recovery drill; do not manufacture today's counts as a reference for historical data.

Use a dedicated disposable PostgreSQL server with no valuable databases or credentials. PostgreSQL SQL dumps are executable input; only restore trusted artifacts. The target role needs CREATE DATABASE, permission to restore all dumped objects and bypass RLS while verifying counts, and permission to drop the new database. Pre-provision named grant/policy roles (including `app_rw`) with the intended least-privilege attributes on this isolated server; a database dump does not create cluster roles. Keep the source service's environment out of this command.

Set these discrete variables through your secret manager or a private operator shell:

```text
RESTORE_ISOLATED_TARGET=yes
RESTORE_PGHOST=<isolated host>
RESTORE_PGPORT=<isolated port>
RESTORE_PGUSER=<isolated administrative role>
RESTORE_PGPASSWORD=<isolated password>
RESTORE_PGDATABASE=<isolated maintenance database>
RESTORE_PGSSLMODE=verify-full
```

Use `RESTORE_PGSSLMODE=disable` only for local synthetic PostgreSQL. The Node metadata connection requires a trusted server certificate whenever TLS is enabled; arrange the corresponding trusted CA configuration for both Node and `psql` on remote targets.

```sh
sh db/restore-verify.sh /private/path/dated.sql.gz /private/path/dated.sql.gz.manifest.json
```

The acknowledgement is an operator assertion of isolation, not infrastructure attestation. The script cannot independently prove that a supplied server is disposable. It generates a UUID database name, creates from `template0`, never drops/reuses a preexisting database, streams gzip directly to `psql -X --set=ON_ERROR_STOP=1 --single-transaction`, and asserts the restored metadata against the artifact's historical snapshot. All restore errors fail the command. Normal completion, SQL/metadata failure and handled interrupts close connections and drop only the database the invocation created. Cleanup failures name the generated scratch database and fail the command so the operator can remove it. No uncompressed SQL or row payloads are printed or written to disk. Sensitive SQL error output is suppressed; restore failures identify the failed phase and suggest checking target roles and compatibility.

## What a successful drill establishes

Success establishes checksum integrity, SQL execution, table counts and recorded public-schema/grant/RLS metadata equality for that artifact. `--no-owner` intentionally restores ownership to the drill role; owner identity is excluded from grant comparison. Grants are retained in new backups (`--no-acl` removed). This is not yet an app-role session/CRUD test, a complete cluster-role/default-privilege audit, sequence-state comparison, row-by-row content comparison, or an encrypted API-key decryption test. Extensions, schemas outside `public`, materialized-view contents and large objects restore through the dump but are not independently inventoried by the manifest.

Before declaring operational recovery complete, use a separately retained isolated restored environment to run the documented bootstrap/role security checks, authenticated cross-tenant CRUD and resume rendering, and a non-logging decryption check using the separately recovered original `APP_ENCRYPTION_KEY`. The verifier deliberately removes its scratch database, so it is not an environment for that subsequent app drill. Restore the artifact again into a dedicated app-drill environment under a separately approved operator procedure. Recover application secrets/configuration independently: they are not supplied by a database dump. Do not send email, invoke paid model calls or connect the restored app to production integrations during this check. Record artifact key, completion time, elapsed recovery time and the checks performed without including row contents or keys.
