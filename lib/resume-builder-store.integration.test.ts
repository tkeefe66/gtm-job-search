import { beforeAll, afterAll, beforeEach, describe, test, expect, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
let db: PGlite;
vi.mock('./supabase', () => ({ tenantTransaction: async (t: string, fn: (q: (sql: string, args?: unknown[]) => Promise<unknown>) => Promise<unknown>) => db.transaction(async (tx) => { await tx.query("select set_config('app.tenant_id',$1,true)", [t]); await tx.exec('set local role app_rw'); return fn((sql, args = []) => tx.query(sql, args)); }) }));
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import * as store from './resume-builder-store';
import type { BuilderProfile, BuilderDesign } from './resume-builder-model';
const schema = `builder_test_${randomUUID().replace(/-/g, '')}`;
const a = '00000000-0000-0000-0000-000000000001', b = '00000000-0000-0000-0000-000000000002';
const profile: BuilderProfile = { name: 'Synthetic', headline: 'Engineer', summary: 'Before', contact: '', sections: [], sourceText: 'Synthetic source' };
const design: BuilderDesign = { template: 'classic', templateVersion: '1', pageLimit: 1, pageSize: 'letter', accent: 'slate', font: 'sans' };
describe('resume builder PostgreSQL engine SQL and RLS (serialized transactions)', () => {
    let admin: {
        query: (sql: string, args?: unknown[]) => Promise<unknown>;
    };
    beforeAll(async () => {
        db = new PGlite();
        await db.exec(`create role app_rw;create schema ${schema};set search_path=${schema};create table users(id uuid primary key);create table jobs(id uuid primary key default gen_random_uuid(),tenant_id uuid,company text,role_title text,key_skills text,company_description text,posting jsonb)`);
        await db.exec(readFileSync('db/migrations/023_resume_builder.sql', 'utf8'));
        await db.query('insert into users values($1),($2)', [a, b]);
        await db.exec(`grant usage on schema ${schema} to app_rw;grant select,insert,update,delete on jobs to app_rw`);
        admin = { query: async (sql, args) => args ? db.query(sql, args) : db.exec(sql) };
    });
    beforeEach(async () => { await db.exec('truncate resume_builder_documents cascade;truncate resume_builder_profiles;truncate jobs cascade'); });
    afterAll(async () => { await db.close(); });
    const create = () => store.createBuilder(a, { title: 'Test', profile, design });
    const propose = (id: string) => store.storeBuilderProposals(a, id, 1, [{ target: 'summary', before: 'Before', after: 'After', reason: 'Source supports this' }]);
    // Mutation: removing revision comparison permits a stale editor to overwrite a newer edit.
    test('stale editor revision cannot overwrite a newer document', async () => { const d = await create(); await store.updateBuilder(a, d.id, 1, { title: 'First editor', profile, design }); await expect(store.updateBuilder(a, d.id, 1, { title: 'Stale editor', profile, design })).rejects.toThrow(/changed/); expect((await store.loadBuilderDocument(a, d.id)).title).toBe('First editor'); });
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
        await db.transaction(async (tx) => { await tx.query("select set_config('app.tenant_id',$1,true)", [b]); await tx.exec('set local role app_rw'); expect((await tx.query('select * from resume_builder_documents')).rows).toHaveLength(0); });
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
        expect(Buffer.from((await store.loadBuilderVersionPdf(a, d.id, detail.versions[0].id)).pdf).toString()).toBe('pdf');
        await expect(db.transaction(async (tx) => { await tx.exec('set local role app_rw'); return tx.query('update resume_builder_versions set title=$1', ['changed']); })).rejects.toThrow(/permission denied/);
        await store.updateBuilder(a, d.id, 2, { title: 'Later edit', profile: { ...profile, summary: 'Later' }, design });
        expect((await store.builderProposalCandidate(a, p.id, 1)).accepted?.revision).toBe(3);
        expect((await store.commitBuilderProposal(a, p.id, 1, Buffer.from('pdf'))).revision).toBe(3);
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
