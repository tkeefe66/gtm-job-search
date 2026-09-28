import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import pg from "pg";

// Disposable local-only PostgreSQL; never consumes DATABASE_URL or mounts host data.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bundledDocker = "/Applications/Docker.app/Contents/Resources/bin/docker";
const docker = process.env.COST_TEST_DOCKER ?? (existsSync(bundledDocker) ? bundledDocker : "docker");
const image = process.env.COST_TEST_POSTGRES_IMAGE ?? "postgres:18";
const container = `codex-cost-concurrency-${process.pid}-${randomUUID().slice(0, 8)}`;
const password = randomUUID();
let started = false;
function dockerRun(args, tolerateFailure = false) {
  const result = spawnSync(docker, args, { encoding: "utf8", timeout: 30_000 });
  if (!tolerateFailure && result.status !== 0) throw new Error(`Docker ${args[0]} failed: ${result.stderr || result.error?.message || "unknown error"}`);
  return result;
}
try {
  dockerRun(["run", "--detach", "--rm", "--pull", "never", "--name", container,
    "--label", "codex.test=cost-concurrency", "--publish", "127.0.0.1::5432",
    "--tmpfs", "/var/lib/postgresql:rw,size=256m",
    "--env", `POSTGRES_PASSWORD=${password}`, "--env", "POSTGRES_DB=codex_cost_concurrency", image]);
  started = true;
  const address = dockerRun(["port", container, "5432/tcp"]).stdout.trim();
  if (!/^127\.0\.0\.1:\d+$/.test(address)) throw new Error("Refusing a database port not bound exclusively to IPv4 loopback.");
  const url = `postgresql://postgres:${password}@${address}/codex_cost_concurrency`;
  const deadline = Date.now() + 20_000;
  let version;
  while (Date.now() < deadline) {
    const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 500 });
    try {
      await client.connect();
      version = (await client.query("select version() version")).rows[0].version;
      break;
    } catch { await new Promise(resolve => setTimeout(resolve, 100)); }
    finally { await client.end().catch(() => {}); }
  }
  if (!version) throw new Error("Disposable PostgreSQL did not become ready within 20 seconds.");
  console.log(`Concurrency verification: ${version}; localhost only; disposable container ${container}`);
  const env = { ...process.env, COST_TEST_POSTGRES_URL: url, COST_TEST_DISPOSABLE_CONTAINER: container };
  delete env.DATABASE_URL;
  const result = spawnSync(process.execPath, [path.join(root, "node_modules/vitest/vitest.mjs"), "run",
    "lib/usage-store.postgres.test.ts", "--reporter=verbose", ...process.argv.slice(2)],
  { cwd: root, env, stdio: "inherit", timeout: 120_000 });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  if (started) {
    const removed = dockerRun(["rm", "--force", container], true);
    if (removed.status !== 0) {
      console.error(`Could not remove disposable test container ${container}: ${removed.stderr}`);
      process.exitCode = 1;
    } else console.log(`Removed disposable PostgreSQL container ${container}.`);
  }
}
