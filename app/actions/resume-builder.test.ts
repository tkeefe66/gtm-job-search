import { beforeEach, test, expect, vi } from 'vitest';
const h = vi.hoisted(() => ({ actor: vi.fn(), create: vi.fn(), candidate: vi.fn(), commit: vi.fn(), fail: vi.fn(), render: vi.fn(), load: vi.fn(), save: vi.fn() }));
vi.mock('@/lib/require-resume-builder', () => ({ requireResumeBuilder: h.actor }));
vi.mock('@/lib/resume-builder-store', () => ({ createBuilder: h.create, builderProposalCandidate: h.candidate, commitBuilderProposal: h.commit, failBuilderRender: h.fail, loadBuilderDocument: h.load, saveBuilderSnapshot: h.save }));
vi.mock('@/lib/resume-builder-render', () => ({ renderBuilderPdf: h.render }));
vi.mock('@/lib/resume-builder-ai', () => ({ parseBuilderInformation: vi.fn(), proposeBuilderChanges: vi.fn() }));
import { createBuilderDocument, acceptBuilderProposal, saveBuilderVersion } from './resume-builder';
const id = '00000000-0000-0000-0000-000000000001';
const input = { title: 'Test', profile: { name: 'A', headline: '', summary: '', contact: '', sections: [], sourceText: '' }, design: { template: 'classic' as const, pageLimit: 1 as const, pageSize: 'letter' as const, accent: 'slate' as const, font: 'sans' as const } };
beforeEach(() => { vi.resetAllMocks(); h.actor.mockResolvedValue({ tenantId: id, isAdmin: true }); });
// Mutation: validation before authentication or persistence before strict validation.
test('auth precedes work and malformed input never writes', async () => { h.actor.mockRejectedValueOnce(new Error('Not authenticated')); await expect(createBuilderDocument(null as never)).rejects.toThrow('Not authenticated'); expect(h.create).not.toHaveBeenCalled(); expect((await createBuilderDocument({ ...input, profile: { ...input.profile, sections: null as never } })).error).toBeDefined(); expect(h.create).not.toHaveBeenCalled(); });
// Mutation: treating empty database error as success or leaking driver content.
test('empty driver errors remain visible failures', async () => { h.create.mockRejectedValue(new Error('')); const r = await createBuilderDocument(input); expect(r.error).toMatch(/service is unavailable/); expect(r.data).toBeUndefined(); });
// Mutation: committing before render validation or falling through on failure.
test('failed candidate rendering never commits and persists blocked status', async () => { h.candidate.mockResolvedValue({ candidate: input }); h.render.mockRejectedValue(new Error('Page limit exceeded')); const r = await acceptBuilderProposal(id, 1); expect(r.error).toBe('Page limit exceeded'); expect(h.fail).toHaveBeenCalledWith(id, id); expect(h.commit).not.toHaveBeenCalled(); });
// Mutation: re-rendering or recommitting an accepted proposal on double click.
test('duplicate accept returns original snapshot without rendering', async () => { h.candidate.mockResolvedValue({ accepted: { ...input, id, revision: 2 } }); const r = await acceptBuilderProposal(id, 1); expect(r.data?.revision).toBe(2); expect(h.render).not.toHaveBeenCalled(); expect(h.commit).not.toHaveBeenCalled(); });
// Mutation: rendering a stale version or saving client content instead of server snapshot.
test('version save renders only matching server revision', async () => { h.load.mockResolvedValue({ ...input, id, revision: 2 }); expect((await saveBuilderVersion(id, 1)).error).toMatch(/changed/); expect(h.render).not.toHaveBeenCalled(); h.render.mockResolvedValue({ pdf: Buffer.from('pdf'), pageCount: 1 }); h.save.mockResolvedValue({ id }); await saveBuilderVersion(id, 2); expect(h.render).toHaveBeenCalledWith(input.profile, input.design); expect(h.save).toHaveBeenCalledWith(id, id, 2, Buffer.from('pdf')); });
