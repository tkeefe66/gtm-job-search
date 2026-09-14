"use server";
import { requireResumeBuilder } from '@/lib/require-resume-builder';
import { BuilderInputError, builderText, validateBuilderProfile, validateBuilderDesign, validateBuilderId, validateBuilderRevision, type BuilderResult, type BuilderDocument, type BuilderProfile, type BuilderDesign, type BuilderProposal, type BuilderVersion } from '@/lib/resume-builder-model';
import * as store from '@/lib/resume-builder-store';
import { renderBuilderPdf } from '@/lib/resume-builder-render';
import { parseBuilderInformation, proposeBuilderChanges } from '@/lib/resume-builder-ai';
async function guarded<T>(operation: string, fn: () => Promise<T>): Promise<BuilderResult<T>> { try {
    return { data: await fn() };
}
catch (e) {
    console.error('resume-builder', operation, e instanceof BuilderInputError ? 'validation' : 'operation-failed');
    return { error: e instanceof BuilderInputError ? e.message : `Could not ${operation}. ${e instanceof Error && e.message ? 'Please retry; contact support if this continues.' : 'The service is unavailable. Please retry.'}` };
} }
function edit(input: {
    title: string;
    profile: BuilderProfile;
    design: BuilderDesign;
}) { if (!input || typeof input !== 'object')
    throw new BuilderInputError('Resume input is required.'); return { title: builderText(input.title, 200, 'Title', true), profile: validateBuilderProfile(input.profile), design: validateBuilderDesign(input.design) }; }
export async function getBuilderLibrary(): Promise<BuilderResult<{
    documents: BuilderDocument[];
    profile: BuilderProfile | null;
}>> { const a = await requireResumeBuilder(); return guarded('load resumes', () => store.loadBuilderLibrary(a.tenantId)); }
export async function getBuilderDocument(id: string): Promise<BuilderResult<{
    document: BuilderDocument;
    proposals: BuilderProposal[];
    versions: BuilderVersion[];
}>> { const a = await requireResumeBuilder(); return guarded('load resume', async () => { validateBuilderId(id); return store.loadBuilderDetail(a.tenantId, id); }); }
export async function parseBuilderProfile(text: string): Promise<BuilderResult<BuilderProfile>> { const a = await requireResumeBuilder(); return guarded('parse career information', () => parseBuilderInformation(a.isAdmin, text)); }
export async function suggestBuilderChanges(id: string, revision: number, instruction: string): Promise<BuilderResult<BuilderProposal[]>> { const a = await requireResumeBuilder(); return guarded('suggest changes', () => proposeBuilderChanges(a.tenantId, a.isAdmin, id, revision, instruction)); }
export async function createBuilderDocument(input: {
    title: string;
    profile: BuilderProfile;
    design: BuilderDesign;
    jobId?: string;
}): Promise<BuilderResult<BuilderDocument>> { const a = await requireResumeBuilder(); return guarded('create resume', async () => { const validated = edit(input); if (input.jobId !== undefined)
    validateBuilderId(input.jobId); return store.createBuilder(a.tenantId, { ...validated, jobId: input.jobId }); }); }
export async function updateBuilderDocument(id: string, revision: number, input: {
    title: string;
    profile: BuilderProfile;
    design: BuilderDesign;
}): Promise<BuilderResult<BuilderDocument>> { const a = await requireResumeBuilder(); return guarded('save resume', async () => { validateBuilderId(id); validateBuilderRevision(revision); return store.updateBuilder(a.tenantId, id, revision, edit(input)); }); }
export async function acceptBuilderProposal(id: string, revision: number): Promise<BuilderResult<BuilderDocument>> { const a = await requireResumeBuilder(); return guarded('accept suggestion', async () => { validateBuilderId(id); validateBuilderRevision(revision); const result = await store.builderProposalCandidate(a.tenantId, id, revision); if (result.accepted)
    return result.accepted; const candidate = result.candidate!; let pdf: Buffer; try {
    pdf = (await renderBuilderPdf(candidate.profile, candidate.design)).pdf;
}
catch (e) {
    await store.failBuilderRender(a.tenantId, id);
    throw new BuilderInputError(e instanceof Error && e.message ? e.message : 'Rendering failed. Retry or request shorter wording.');
} return store.commitBuilderProposal(a.tenantId, id, revision, pdf); }); }
export async function rejectBuilderProposal(id: string): Promise<BuilderResult<null>> { const a = await requireResumeBuilder(); return guarded('reject suggestion', async () => { validateBuilderId(id); return store.rejectBuilder(a.tenantId, id); }); }
export async function saveBuilderVersion(id: string, revision: number): Promise<BuilderResult<BuilderVersion>> { const a = await requireResumeBuilder(); return guarded('save version', async () => { validateBuilderId(id); validateBuilderRevision(revision); const d = await store.loadBuilderDocument(a.tenantId, id); if (d.revision !== revision)
    throw new BuilderInputError('Resume changed. Reload before saving a version.'); let pdf: Buffer; try {
    pdf = (await renderBuilderPdf(d.profile, d.design)).pdf;
}
catch (e) {
    throw new BuilderInputError(e instanceof Error && e.message ? e.message : 'Rendering failed. Retry.');
} return store.saveBuilderSnapshot(a.tenantId, id, revision, pdf); }); }
export async function restoreBuilderVersion(id: string, revision: number, versionId: string): Promise<BuilderResult<BuilderDocument>> { const a = await requireResumeBuilder(); return guarded('restore version', async () => { validateBuilderId(id); validateBuilderId(versionId); validateBuilderRevision(revision); return store.restoreBuilder(a.tenantId, id, revision, versionId); }); }
export async function deleteBuilderDocument(id: string, revision: number): Promise<BuilderResult<null>> { const a = await requireResumeBuilder(); return guarded('delete resume', async () => { validateBuilderId(id); validateBuilderRevision(revision); return store.deleteBuilder(a.tenantId, id, revision); }); }
