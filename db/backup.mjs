/** Isolated Railway backup cron. See docs/recovery.md. Credentials never on argv. */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createGzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { createReadStream, createWriteStream, statSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { pathToFileURL } from 'node:url';
import { backupGuard, backupKey } from '../lib/backup-guard.mjs';
import { sha256, recoveryMetadata } from './recovery-metadata.mjs';
const DRY = process.argv.includes('--dry');
export async function main() {
  const required = ['PGHOST','PGUSER','PGPASSWORD','PGDATABASE',...(!DRY ? ['R2_ACCOUNT_ID','R2_ACCESS_KEY_ID','R2_SECRET_ACCESS_KEY','R2_BUCKET'] : [])];
  if (required.some(key => !process.env[key])) throw new Error('Missing required backup configuration');
  process.umask(0o077);
  const cfg = {host:process.env.PGHOST,port:Number(process.env.PGPORT || 5432),user:process.env.PGUSER,password:process.env.PGPASSWORD,database:process.env.PGDATABASE,connectionTimeoutMillis:10000,ssl:process.env.PGSSLMODE === 'disable' ? false : {rejectUnauthorized:false}};
  const client = new pg.Client(cfg);
  let temp, child, stopping = false;
  const interrupt = () => { stopping = true; child?.kill('SIGTERM'); };
  process.on('SIGINT',interrupt); process.on('SIGTERM',interrupt);
  try {
    await client.connect();
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const {rows} = await client.query("SELECT tablename FROM pg_tables WHERE schemaname='public'");
    const verdict = backupGuard({database:cfg.database,tables:rows.map(row => row.tablename)});
    if (!verdict.ok) throw new Error('Source schema guard refused backup');
    const snapshot = (await client.query('SELECT pg_export_snapshot() AS snapshot')).rows[0].snapshot;
    const metadata = await recoveryMetadata(client);
    const createdAt = new Date().toISOString();
    // Each run is immutable: retries cannot replace today's previous good dump.
    const key = backupKey(new Date()).replace('.sql.gz',`-${Date.now()}-${randomUUID()}.sql.gz`);
    temp = mkdtempSync(join(tmpdir(),'job-backup-'));
    const gz = join(temp,'dump.sql.gz');
    if (stopping) throw new Error('Backup interrupted');
    child = spawn('pg_dump',['--no-owner','--snapshot',snapshot,'-d',cfg.database],{env:{...process.env,PGPASSWORD:cfg.password},stdio:['ignore','pipe','ignore']});
    const exited = new Promise((resolve,reject) => {
      child.once('close',code => code === 0 ? resolve() : reject(new Error('pg_dump failed')));
      child.once('error',() => reject(new Error('pg_dump unavailable')));
    });
    const streamed = pipeline(child.stdout,createGzip(),createWriteStream(gz,{mode:0o600,flags:'wx'}));
    try { await Promise.all([streamed,exited]); }
    catch(error) { child.kill('SIGTERM'); await Promise.allSettled([streamed,exited]); throw error; }
    await client.query('COMMIT');
    if (stopping) throw new Error('Backup interrupted');
    const bytes = statSync(gz).size;
    const manifest = JSON.stringify({version:1,key,createdAt,sourceDatabase:cfg.database,bytes,sha256:await sha256(gz),metadata});
    writeFileSync(join(temp,'manifest.json'),manifest,{mode:0o600});
    if (DRY) { console.log('backup: dry dump and same-snapshot manifest verified; upload skipped'); return; }
    const { S3Client,PutObjectCommand } = await import('@aws-sdk/client-s3');
    const s3 = new S3Client({region:'auto',endpoint:`https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,credentials:{accessKeyId:process.env.R2_ACCESS_KEY_ID,secretAccessKey:process.env.R2_SECRET_ACCESS_KEY}});
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(),120000);
    const abortUpload = () => controller.abort();
    process.on('SIGINT',abortUpload); process.on('SIGTERM',abortUpload);
    try {
      await s3.send(new PutObjectCommand({Bucket:process.env.R2_BUCKET,Key:key,Body:createReadStream(gz),ContentLength:bytes,IfNoneMatch:'*'}),{abortSignal:controller.signal});
      // Manifest last is the completion marker. Artifact alone is not a recovery point.
      await s3.send(new PutObjectCommand({Bucket:process.env.R2_BUCKET,Key:`${key}.manifest.json`,Body:manifest,ContentType:'application/json',IfNoneMatch:'*'}),{abortSignal:controller.signal});
    } finally { clearTimeout(timeout); s3.destroy(); process.off('SIGINT',abortUpload); process.off('SIGTERM',abortUpload); }
    if (stopping) throw new Error('Backup interrupted');
    console.log(`backup: uploaded artifact and manifest (${bytes} bytes) -> ${key}`);
  } finally {
    try { await client.end(); }
    finally { if (temp) rmSync(temp,{recursive:true,force:true}); process.off('SIGINT',interrupt); process.off('SIGTERM',interrupt); }
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(() => { console.error('backup: FAILED; verify configuration, source privileges, pg_dump compatibility and storage access'); process.exitCode=1; });
