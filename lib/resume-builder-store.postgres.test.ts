import { beforeAll, afterAll, beforeEach, describe, test, expect } from 'vitest';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import * as store from './resume-builder-store';
import type { BuilderProfile, BuilderDesign } from './resume-builder-model';
const url = process.env.TEST_POSTGRES_URL;
const schema = `builder_test_${randomUUID().replace(/-/g, '')}`;
const a = '00000000-0000-0000-0000-000000000001', b = '00000000-0000-0000-0000-000000000002';
const profile: BuilderProfile = { name: 'Synthetic', headline: 'Engineer', summary: 'Before', contact: '', sections: [], sourceText: 'Synthetic source' };
const design: BuilderDesign = { template: 'classic', templateVersion: '1', pageLimit: 1, pageSize: 'letter', accent: 'slate', font: 'sans' };
describe.skipIf(!url)('resume builder isolated PostgreSQL transactions', () => {
    let admin: Pool, pool: Pool, prior: Pool | undefined;
    beforeAll(async () => {
        if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(url!).hostname))
            throw new Error('TEST_POSTGRES_URL must be local and disposable.');
        admin = new Pool({ connectionString: url });
        await admin.query(`create schema ${schema}`);
        await admin.query("do $$ begin if not exists(select 1 from pg_roles where rolname='app_rw') then create role app_rw; end if; end $$");
        await admin.query(`create table ${schema}.users(id uuid primary key);create table ${schema}.jobs(id uuid primary key default gen_random_uuid(),tenant_id uuid,company text,role_title text,key_skills text,company_description text,posting jsonb)`);
        const setup = new Pool({ connectionString: url, options: `-c search_path=${schema}` });
        await setup.query(readFileSync('db/migrations/023_resume_builder.sql', 'utf8'));
        await setup.query('insert into users values($1),($2)', [a, b]);
        await setup.query(`grant usage on schema ${schema} to app_rw;grant select,insert,update,delete on jobs to app_rw`);
        await setup.end();
        pool = new Pool({ connectionString: url, max: 8, options: `-c search_path=${schema} -c role=app_rw` });
        const globalPool = globalThis as unknown as {
            __pgPool?: Pool;
        };
        prior = globalPool.__pgPool;
        globalPool.__pgPool = pool;
    });
    beforeEach(async () => { await admin.query(`truncate ${schema}.resume_builder_documents cascade;truncate ${schema}.resume_builder_profiles;truncate ${schema}.jobs cascade`); });
    afterAll(async () => { (globalThis as unknown as {
        __pgPool?: Pool;
    }).__pgPool = prior; if (pool)
        await pool.end(); if (admin) {
        await admin.query(`drop schema ${schema} cascade`);
        await admin.end();
    } });
    const create = () => store.createBuilder(a, { title: 'Test', profile, design });
    const propose = (id: string) => store.storeBuilderProposals(a, id, 1, [{ target: 'summary', before: 'Before', after: 'After', reason: 'Source supports this' }]);
    // Mutation: deleting explicit tenant predicates or RLS policy.
    test('denies foreign documents, proposals, versions and jobs', async () => {
        const d = await create();
        const [p] = await propose(d.id);
        const v = await store.saveBuilderSnapshot(a, d.id, 1, Buffer.from('pdf'));
        await expect(store.loadBuilderDocument(b, d.id)).rejects.toThrow(/not found/);
        await expect(store.builderProposalCandidate(b, p.id, 1)).rejects.toThrow(/not found/);
        await expect(store.loadBuilderVersionPdf(b, d.id, v.id)).rejects.toThrow(/not found/);
        const job = randomUUID();
        await admin.query(`insert into ${schema}.jobs(id,tenant_id) values($1,$2)`, [job, b]);
        await expect(store.createBuilder(a, { title: 'Test', profile, design, jobId: job })).rejects.toThrow(/not found/);
        const c = await pool.connect();
        try {
            await c.query('begin');
            await c.query("select set_config('app.tenant_id',$1,true)", [b]);
            expect((await c.query('select * from resume_builder_documents')).rows).toHaveLength(0);
        }
        finally {
            await c.query('rollback');
            c.release();
        }
    });
    // Mutation: checking revision before transaction without locking, or failing to mark accepted atomically.
    test('double accept is idempotent and accepts one immutable snapshot', async () => {
        const d = await create();
        const [p] = await propose(d.id);
        await store.builderProposalCandidate(a, p.id, 1);
        const result = await Promise.all([store.commitBuilderProposal(a, p.id, 1, Buffer.from('pdf')), store.commitBuilderProposal(a, p.id, 1, Buffer.from('pdf'))]);
        expect(result[0]).toEqual(result[1]);
        expect(result[0].revision).toBe(2);
        const detail = await store.loadBuilderDetail(a, d.id);
        expect(detail.versions).toHaveLength(1);
        expect(detail.proposals[0].status).toBe('accepted');
        expect((await store.loadBuilderVersionPdf(a, d.id, detail.versions[0].id)).pdf.toString()).toBe('pdf');
        await expect(pool.query('update resume_builder_versions set title=$1', ['changed'])).rejects.toThrow(/permission denied/);
    });
    // Mutation: render completion commits against a newer revision.
    test('edit during render wins and stale acceptance leaves no snapshot', async () => {
        const d = await create();
        const [p] = await propose(d.id);
        await store.builderProposalCandidate(a, p.id, 1);
        await store.updateBuilder(a, d.id, 1, { title: d.title, profile: { ...profile, summary: 'User edit' }, design });
        await expect(store.commitBuilderProposal(a, p.id, 1, Buffer.from('pdf'))).rejects.toThrow(/changed/);
        const detail = await store.loadBuilderDetail(a, d.id);
        expect(detail.document.profile.summary).toBe('User edit');
        expect(detail.versions).toHaveLength(0);
        expect(detail.proposals[0].status).toBe('stale');
    });
    // Mutation: partial document acceptance commits when version insertion fails.
    test('version failure rolls back content and proposal status', async () => {
        const d = await create();
        const [p] = await propose(d.id);
        await expect(store.commitBuilderProposal(a, p.id, 1, null as unknown as Buffer)).rejects.toThrow();
        const detail = await store.loadBuilderDetail(a, d.id);
        expect(detail.document.revision).toBe(1);
        expect(detail.document.profile.summary).toBe('Before');
        expect(detail.proposals[0].status).toBe('pending');
    });
    // Mutation: removing expiry filter or allowing restore to rewrite an old snapshot.
    test('restore creates revision and expiration denies restore and download', async () => {
        const d = await create();
        const v = await store.saveBuilderSnapshot(a, d.id, 1, Buffer.from('pdf'));
        const expiry = Date.parse(v.expiresAt) - Date.parse(v.createdAt);
        expect(expiry).toBe(60 * 86400000);
        await store.updateBuilder(a, d.id, 1, { title: 'Edited', profile: { ...profile, summary: 'New' }, design });
        const restored = await store.restoreBuilder(a, d.id, 2, v.id);
        expect(restored.revision).toBe(3);
        expect(restored.profile.summary).toBe('Before');
        await admin.query(`update ${schema}.resume_builder_versions set expires_at=now()-interval '1 second' where id=$1`, [v.id]);
        await expect(store.restoreBuilder(a, d.id, 3, v.id)).rejects.toThrow(/not found/);
        await expect(store.loadBuilderVersionPdf(a, d.id, v.id)).rejects.toThrow(/not found/);
    });
    // Mutation: job deletion cascades independent documents.
    test('job deletion preserves document and source snapshots remain independent', async () => {
        const job = randomUUID();
        await admin.query(`insert into ${schema}.jobs(id,tenant_id) values($1,$2)`, [job, a]);
        const d = await store.createBuilder(a, { title: 'Linked', profile, design, jobId: job });
        await admin.query(`delete from ${schema}.jobs where id=$1`, [job]);
        expect((await store.loadBuilderDocument(a, d.id)).jobId).toBeNull();
        await store.createBuilder(a, { title: 'Other', profile: { ...profile, name: 'Different' }, design });
        expect((await store.loadBuilderDocument(a, d.id)).profile.name).toBe('Synthetic');
    });
});
