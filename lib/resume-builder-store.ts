import { tenantTransaction } from './supabase';
import { BuilderInputError, applyBuilderProposal, type BuilderDocument, type BuilderProfile, type BuilderDesign, type BuilderProposal, type BuilderVersion } from './resume-builder-model';
type Q = Parameters<Parameters<typeof tenantTransaction>[1]>[0];
type Row = Record<string, unknown>;
const doc = (r: Row): BuilderDocument => ({ id: String(r.id), revision: Number(r.revision), title: String(r.title), jobId: r.job_id ? String(r.job_id) : null, profile: r.profile as BuilderProfile, design: r.design as BuilderDesign, updatedAt: new Date(r.updated_at as string).toISOString() });
const proposal = (r: Row): BuilderProposal => ({ id: String(r.id), documentId: String(r.document_id), revision: Number(r.revision), target: String(r.target), before: String(r.before_text), after: String(r.after_text), reason: String(r.reason), status: r.status as BuilderProposal['status'] });
const version = (r: Row): BuilderVersion => ({ id: String(r.id), documentId: String(r.document_id), title: String(r.title), createdAt: new Date(r.created_at as string).toISOString(), expiresAt: new Date(r.expires_at as string).toISOString() });
function must<T>(v: T | undefined): T { if (!v)
    throw new BuilderInputError('Resume item not found or unavailable for this account.'); return v; }
function current(d: BuilderDocument, revision: number) { if (d.revision !== revision)
    throw new BuilderInputError('Resume changed. Reload before trying again.'); }
async function read(q: Q, t: string, id: string, lock = false) { return doc(must((await q(`select * from resume_builder_documents where tenant_id=$1 and id=$2${lock ? ' for update' : ''}`, [t, id])).rows[0])); }
async function invalidate(q: Q, t: string, id: string) { await q("update resume_builder_proposals set status='stale' where tenant_id=$1 and document_id=$2 and status in ('pending','blocked')", [t, id]); }
async function write(q: Q, t: string, d: BuilderDocument, input: {
    title: string;
    profile: BuilderProfile;
    design: BuilderDesign;
}) { const r = must((await q('update resume_builder_documents set title=$3, profile=$4, design=$5, revision=revision+1,updated_at=now() where tenant_id=$1 and id=$2 returning *', [t, d.id, input.title, JSON.stringify(input.profile), JSON.stringify(input.design)])).rows[0]); await invalidate(q, t, d.id); return doc(r); }
async function snapshot(q: Q, t: string, d: BuilderDocument, pdf: Buffer) { return version(must((await q('insert into resume_builder_versions(tenant_id,document_id,title,snapshot,pdf) values($1,$2,$3,$4,$5) returning *', [t, d.id, d.title, JSON.stringify(d), pdf])).rows[0])); }
export async function loadBuilderDocument(t: string, id: string) { return tenantTransaction(t, q => read(q, t, id)); }
export async function loadBuilderVersionPdf(t: string, id: string, versionId: string) { return tenantTransaction(t, async (q) => { const r = must((await q('select pdf,title from resume_builder_versions where tenant_id=$1 and document_id=$2 and id=$3 and expires_at>now()', [t, id, versionId])).rows[0]); return { pdf: r.pdf as Buffer, title: String(r.title) }; }); }
export async function loadBuilderLibrary(t: string) { return tenantTransaction(t, async (q) => ({ documents: (await q('select * from resume_builder_documents where tenant_id=$1 order by updated_at desc', [t])).rows.map(doc), profile: ((await q('select profile from resume_builder_profiles where tenant_id=$1', [t])).rows[0]?.profile as BuilderProfile | undefined) ?? null })); }
export async function loadBuilderDetail(t: string, id: string) { return tenantTransaction(t, async (q) => ({ document: await read(q, t, id), proposals: (await q('select * from resume_builder_proposals where tenant_id=$1 and document_id=$2 order by id', [t, id])).rows.map(proposal), versions: (await q('select id,document_id,title,created_at,expires_at from resume_builder_versions where tenant_id=$1 and document_id=$2 and expires_at>now() order by created_at desc', [t, id])).rows.map(version) })); }
export async function createBuilder(t: string, input: {
    title: string;
    profile: BuilderProfile;
    design: BuilderDesign;
    jobId?: string;
}) {
    return tenantTransaction(t, async (q) => {
        if (input.jobId)
            must((await q('select id from jobs where tenant_id=$1 and id=$2 for key share', [t, input.jobId])).rows[0]);
        const d = doc(must((await q('insert into resume_builder_documents(tenant_id,title,profile,design,job_id) values($1,$2,$3,$4,$5) returning *', [t, input.title, JSON.stringify(input.profile), JSON.stringify(input.design), input.jobId ?? null])).rows[0]));
        await q('insert into resume_builder_profiles(tenant_id,profile) values($1,$2) on conflict(tenant_id) do update set profile=excluded.profile,updated_at=now()', [t, JSON.stringify(input.profile)]);
        return d;
    });
}
export async function updateBuilder(t: string, id: string, revision: number, input: {
    title: string;
    profile: BuilderProfile;
    design: BuilderDesign;
}) { return tenantTransaction(t, async (q) => { const d = await read(q, t, id, true); current(d, revision); return write(q, t, d, input); }); }
export async function storeBuilderProposals(t: string, id: string, revision: number, items: Pick<BuilderProposal, 'target' | 'before' | 'after' | 'reason'>[]) { return tenantTransaction(t, async (q) => { const d = await read(q, t, id, true); current(d, revision); const out: BuilderProposal[] = []; for (const p of items) {
    applyBuilderProposal(d.profile, p);
    out.push(proposal(must((await q('insert into resume_builder_proposals(tenant_id,document_id,revision,target,before_text,after_text,reason) values($1,$2,$3,$4,$5,$6,$7) returning *', [t, id, revision, p.target, p.before, p.after, p.reason])).rows[0])));
} return out; }); }
export async function builderProposalCandidate(t: string, id: string, revision: number) { return tenantTransaction(t, async (q) => { const r = must((await q('select * from resume_builder_proposals where tenant_id=$1 and id=$2', [t, id])).rows[0]); if (r.status === 'accepted')
    return { accepted: await read(q, t, String(r.document_id)) }; const d = await read(q, t, String(r.document_id)); current(d, revision); if (Number(r.revision) !== revision || !['pending', 'blocked'].includes(String(r.status)))
    throw new BuilderInputError('Suggestion is no longer pending. Request a new suggestion.'); const p = proposal(r); const candidate = { ...d, profile: applyBuilderProposal(d.profile, p) }; await q("update resume_builder_proposals set render_status='running',render_error=null where tenant_id=$1 and id=$2 and status in ('pending','blocked')", [t, id]); return { candidate }; }); }
export async function failBuilderRender(t: string, id: string) { await tenantTransaction(t, q => q("update resume_builder_proposals set render_status='failed',render_error='Render failed. Retry or request shorter wording.',status='blocked' where tenant_id=$1 and id=$2 and status in ('pending','blocked')", [t, id])); }
export async function commitBuilderProposal(t: string, id: string, revision: number, pdf: Buffer) {
    return tenantTransaction(t, async (q) => {
        // Always lock document before proposal, matching editor/restore invalidation order.
        const initial = must((await q('select document_id from resume_builder_proposals where tenant_id=$1 and id=$2', [t, id])).rows[0]);
        const d = await read(q, t, String(initial.document_id), true);
        const r = must((await q('select * from resume_builder_proposals where tenant_id=$1 and id=$2 for update', [t, id])).rows[0]);
        if (r.status === 'accepted')
            return d;
        current(d, revision);
        if (Number(r.revision) !== revision || !['pending', 'blocked'].includes(String(r.status)))
            throw new BuilderInputError('Suggestion changed. Reload and request another.');
        const next = await write(q, t, d, { ...d, profile: applyBuilderProposal(d.profile, proposal(r)) });
        await snapshot(q, t, next, pdf);
        await q("update resume_builder_proposals set status='accepted',render_status='passed',render_error=null where tenant_id=$1 and id=$2", [t, id]);
        return next;
    });
}
export async function rejectBuilder(t: string, id: string) { return tenantTransaction(t, async (q) => { must((await q("update resume_builder_proposals set status='rejected' where tenant_id=$1 and id=$2 and status in ('pending','blocked','rejected') returning id", [t, id])).rows[0]); return null; }); }
export async function saveBuilderSnapshot(t: string, id: string, revision: number, pdf: Buffer) { return tenantTransaction(t, async (q) => { const d = await read(q, t, id, true); current(d, revision); return snapshot(q, t, d, pdf); }); }
export async function restoreBuilder(t: string, id: string, revision: number, versionId: string) { return tenantTransaction(t, async (q) => { const d = await read(q, t, id, true); current(d, revision); const r = must((await q('select snapshot from resume_builder_versions where tenant_id=$1 and document_id=$2 and id=$3 and expires_at>now()', [t, id, versionId])).rows[0]); const s = r.snapshot as BuilderDocument; return write(q, t, d, { title: s.title, profile: s.profile, design: s.design }); }); }
export async function deleteBuilder(t: string, id: string, revision: number) { return tenantTransaction(t, async (q) => { const d = await read(q, t, id, true); current(d, revision); await q('delete from resume_builder_documents where tenant_id=$1 and id=$2', [t, id]); return null; }); }
export async function loadBuilderJob(t: string, id: string) { return tenantTransaction(t, async (q) => must((await q('select company,role_title,key_skills,company_description,posting from jobs where tenant_id=$1 and id=$2', [t, id])).rows[0])); }
