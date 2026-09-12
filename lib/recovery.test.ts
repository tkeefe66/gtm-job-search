import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { Writable } from 'node:stream';
import { EventEmitter } from 'node:events';
import { sha256, assertMetadata } from '../db/recovery-metadata.mjs';
const state = vi.hoisted(() => ({clientEnvs: [] as Record<string,string>[], queries: [] as string[], args: [] as string[], env: {} as Record<string,string>, restoreCode:0, failCreate:false, failCounts:false}));
vi.mock('pg', () => ({default:{Client:class {
  constructor() { state.clientEnvs.push({...process.env} as Record<string,string>); }
  async connect() {}
  async end() {}
  async query(sql:string) {
    state.queries.push(sql);
    if (state.failCreate && sql.startsWith('CREATE DATABASE')) throw new Error('collision');
    if (sql.includes('FROM pg_class c')) return {rows:state.failCounts ? [{name:'unexpected',rls:false,force_rls:false}] : []};
    if (sql.startsWith('SELECT count')) return {rows:[{count:'2'}]};
    return {rows:[]};
  }
}}}));
vi.mock('node:child_process', () => ({spawn:(_exe:string,args:string[],options:{env:Record<string,string>}) => {
  state.env=options.env;
  state.args=args;
  const child = new EventEmitter() as EventEmitter & {stdin:Writable;kill:()=>void};
  child.stdin = new Writable({write(_chunk,_enc,done){done();},final(done){done();setImmediate(()=>child.emit('close',state.restoreCode));}});
  child.kill=()=>child.emit('close',1);
  return child;
}}));
import { main } from '../db/restore-verify.mjs';
let temp:string;
let argv:string[];
beforeEach(async () => {
  state.clientEnvs=[];state.queries=[];state.args=[];state.restoreCode=0;state.failCreate=false;state.failCounts=false;
  temp=mkdtempSync(join(tmpdir(),'recovery-test-'));argv=process.argv;
  const artifact=join(temp,'stored.sql.gz');writeFileSync(artifact,gzipSync('SELECT 1;'));
  const metadata={tables:[],columns:[],constraints:[],indexes:[],policies:[],grants:[],columnGrants:[],functions:[]};
  const manifest=join(temp,'manifest.json');writeFileSync(manifest,JSON.stringify({version:1,metadata,sha256:await sha256(artifact)}));
  process.argv=['node','restore-verify.mjs',artifact,manifest];
  for(const key of ['HOST','PORT','USER','PASSWORD','DATABASE']) vi.stubEnv(`RESTORE_PG${key}`,key==='PORT'?'5432':'synthetic');
  vi.stubEnv('RESTORE_ISOLATED_TARGET','yes');
});
afterEach(()=>{process.argv=argv;vi.unstubAllEnvs();rmSync(temp,{recursive:true,force:true});});
describe('stored artifact recovery',()=>{
  it('asserts metadata and cleans its newly created scratch after success',async()=>{
    await main();
    expect(state.args).toContain('--set=ON_ERROR_STOP=1');
    expect(state.args).toContain('--single-transaction');
    expect(state.queries.filter(sql=>sql.startsWith('DROP DATABASE'))).toHaveLength(1);
    expect(state.queries.find(sql=>sql.startsWith('CREATE DATABASE'))).toMatch(/restore_verify_[a-f0-9]{32}/);
  });
  it('fails on SQL error and still drops scratch',async()=>{
    state.restoreCode=3;await expect(main()).rejects.toThrow('Restore SQL failed');
    expect(state.queries.some(sql=>sql.startsWith('DROP DATABASE'))).toBe(true);
  });
  it('never drops a database whose creation failed',async()=>{
    state.failCreate=true;await expect(main()).rejects.toThrow('collision');
    expect(state.queries.some(sql=>sql.startsWith('DROP DATABASE'))).toBe(false);
  });
  it('fails on restored count/table mismatch and cleans scratch',async()=>{
    state.failCounts=true;await expect(main()).rejects.toThrow('Restored tables differ');
    expect(state.queries.some(sql=>sql.startsWith('DROP DATABASE'))).toBe(true);
  });
  it('rejects checksum mismatch before connecting or creating',async()=>{
    writeFileSync(process.argv[2],gzipSync('changed'));await expect(main()).rejects.toThrow('checksum');expect(state.queries).toEqual([]);
  });
  it('strips all ambient libpq routing and configuration from restore child',async()=>{
    for(const key of ['PGHOSTADDR','PGSERVICE','PGSERVICEFILE','PGOPTIONS','PGPASSFILE','PGSSLROOTCERT']) vi.stubEnv(key,'source-value');
    await main();
    for(const key of ['PGHOSTADDR','PGSERVICE','PGSERVICEFILE','PGOPTIONS','PGPASSFILE','PGSSLROOTCERT']) expect(state.env[key]).toBeUndefined();
    expect(state.env.PGHOST).toBe('synthetic');
    expect(state.env.PGUSER).toBe('synthetic');
    expect(state.clientEnvs).toHaveLength(2);
    for(const captured of state.clientEnvs) for(const key of Object.keys(captured)) expect(key.startsWith('PG')).toBe(false);
    expect(process.env.PGHOSTADDR).toBe('source-value');
  });
  it('requires explicit isolated target acknowledgement',async()=>{
    vi.stubEnv('RESTORE_ISOLATED_TARGET','');await expect(main()).rejects.toThrow('isolated');expect(state.queries).toEqual([]);
  });
  it('rejects missing or changed grants/schema metadata',()=>{
    expect(()=>assertMetadata({grants:[]},{grants:[{grantee:'app_rw',privilege_type:'DELETE'}]})).toThrow('grants');
    expect(()=>assertMetadata({},{columns:[]})).toThrow('columns');
  });
});
