import pg from 'pg';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { readFileSync, createReadStream } from 'node:fs';
import { createGunzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { spawn } from 'node:child_process';
import { identifier, sha256, recoveryMetadata, assertMetadata } from './recovery-metadata.mjs';
// node-postgres also consults process.env for PGOPTIONS/PGREPLICATION/etc.
// Constructor capture is synchronous; restore ambient env immediately afterward.
function isolatedClient(config) {
  const saved = {};
  for (const key of Object.keys(process.env)) if (key.startsWith('PG')) { saved[key] = process.env[key]; delete process.env[key]; }
  try { return new pg.Client(config); }
  finally { Object.assign(process.env, saved); }
}
export async function main() {
  const [artifact, manifestPath] = process.argv.slice(2);
  if (!artifact || !manifestPath || process.argv.length !== 4) throw new Error('Usage: sh db/restore-verify.sh ARTIFACT.sql.gz MANIFEST.json');
  if (process.env.RESTORE_ISOLATED_TARGET !== 'yes') throw new Error('Set RESTORE_ISOLATED_TARGET=yes only for an isolated disposable PostgreSQL server');
  for (const key of ['RESTORE_PGHOST','RESTORE_PGPORT','RESTORE_PGUSER','RESTORE_PGPASSWORD','RESTORE_PGDATABASE']) if (!process.env[key]) throw new Error(`Missing ${key}`);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (manifest.version !== 1 || !manifest.metadata || !/^[a-f0-9]{64}$/.test(manifest.sha256)) throw new Error('Invalid recovery manifest');
  if (await sha256(artifact) !== manifest.sha256) throw new Error('Artifact checksum mismatch');
  const env = { ...process.env };
  // libpq honors PGHOSTADDR before PGHOST; no ambient source routing, service,
  // options, passfile or TLS overrides may cross into the isolated target.
  for (const key of Object.keys(env)) if (key.startsWith('PG')) delete env[key];
  for (const name of ['HOST','PORT','USER','PASSWORD','DATABASE']) env[`PG${name}`] = process.env[`RESTORE_PG${name}`];
  env.PGSSLMODE = process.env.RESTORE_PGSSLMODE || 'require';
  env.PGCONNECT_TIMEOUT = '10';
  const config = { host:env.PGHOST, port:Number(env.PGPORT), user:env.PGUSER, password:env.PGPASSWORD, database:env.PGDATABASE, connectionTimeoutMillis:10000, ssl:env.PGSSLMODE === 'disable' ? false : {rejectUnauthorized:true} };
  const admin = isolatedClient(config);
  let scratch, restored, child, stopping = false;
  const interrupt = () => { stopping = true; child?.kill('SIGTERM'); };
  process.on('SIGINT', interrupt); process.on('SIGTERM', interrupt);
  try {
    await admin.connect();
    const name = `restore_verify_${randomUUID().replaceAll('-', '')}`;
    // CREATE collision fails; a preexisting database is never dropped or reused.
    await admin.query(`CREATE DATABASE ${identifier(name)} TEMPLATE template0`);
    scratch = name;
    if (stopping) throw new Error('Recovery drill interrupted');
    child = spawn('psql', ['-X','--no-password','--set=ON_ERROR_STOP=1','--single-transaction','--dbname',scratch], {env,stdio:['pipe','ignore','ignore']});
    const exited = new Promise((resolve,reject) => {
      child.once('error', () => reject(new Error('psql could not start')));
      child.once('close', code => code === 0 ? resolve() : reject(new Error(`Restore SQL failed (psql exit ${code}); verify role prerequisites and artifact compatibility`)));
    });
    const streamed = pipeline(createReadStream(artifact),createGunzip(),child.stdin);
    try { await Promise.all([streamed,exited]); }
    catch(error) { child.kill('SIGTERM'); await Promise.allSettled([streamed,exited]); throw error; }
    if (stopping) throw new Error('Recovery drill interrupted');
    restored = isolatedClient({...config,database:scratch});
    await restored.connect();
    await restored.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    assertMetadata(manifest.metadata,await recoveryMetadata(restored));
    await restored.query('COMMIT');
    if (stopping) throw new Error('Recovery drill interrupted');
    console.log('restore: artifact checksum, counts, schema, RLS, policies and recorded grants match');
  } finally {
    try {
      await restored?.end();
      if (scratch) {
        try { await admin.query(`DROP DATABASE ${identifier(scratch)} WITH (FORCE)`); }
        catch { throw new Error(`Scratch cleanup failed for ${scratch}; remove it on the isolated target before continuing`); }
      }
    } finally {
      await admin.end();
      process.off('SIGINT',interrupt); process.off('SIGTERM',interrupt);
    }
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => {
  console.error(`restore: FAILED (${error.constructor === Error ? error.message : 'database operation failed; inspect isolated target configuration/cleanup'})`);
  process.exitCode = 1;
});
