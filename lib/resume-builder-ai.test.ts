import { beforeEach, test, expect, vi } from 'vitest';
const h = vi.hoisted(() => ({ budget: vi.fn(), complete: vi.fn(), load: vi.fn(), job: vi.fn(), store: vi.fn() }));
vi.mock('./metered', () => ({ withBudget: h.budget }));
vi.mock('./model-call', () => ({ complete: h.complete, parseJson: JSON.parse }));
vi.mock('./resume-builder-store', () => ({ loadBuilderDocument: h.load, loadBuilderJob: h.job, storeBuilderProposals: h.store }));
import { parseBuilderInformation, proposeBuilderChanges } from './resume-builder-ai';
const id = '00000000-0000-0000-0000-000000000001';
const profile = { name: 'Synthetic', headline: '', contact: '', summary: 'Original', sections: [], sourceText: 'Actual source' };
beforeEach(() => { vi.resetAllMocks(); h.budget.mockImplementation(async ({ fn }) => ({ result: await fn() })); h.load.mockResolvedValue({ profile, revision: 1, jobId: null }); h.store.mockImplementation(async (_t, _id, _r, p) => p); });
// Mutation: trusting model source reference or filling career defaults.
test('model extraction retains exact supplied source and rejects missing fields', async () => { h.complete.mockResolvedValueOnce(JSON.stringify({ ...profile, sourceText: 'Invented' })); expect((await parseBuilderInformation(true, 'Real source')).sourceText).toBe('Real source'); h.complete.mockResolvedValueOnce('{}'); await expect(parseBuilderInformation(true, 'Real source')).rejects.toThrow(); });
// Mutation: truthy-only error or missing budget boundary.
test('budget empty error prevents completion and is actionable', async () => { h.budget.mockResolvedValue({ error: '' }); await expect(parseBuilderInformation(false, 'Source')).rejects.toThrow(/failed without a message/); expect(h.complete).not.toHaveBeenCalled(); });
// Mutation: swallowing provider categories into an unactionable generic failure.
test('provider auth, rate limit and timeout explain recovery', async () => { h.complete.mockRejectedValueOnce({ status: 401 }); await expect(parseBuilderInformation(true, 'Source')).rejects.toThrow(/API key/); h.complete.mockRejectedValueOnce({ status: 429 }); await expect(parseBuilderInformation(true, 'Source')).rejects.toThrow(/rate limit/); h.complete.mockRejectedValueOnce(new Error('timed out')); await expect(parseBuilderInformation(true, 'Source')).rejects.toThrow(/timed out/); });
// Mutation: trusting stale model targets and writing all suggestions.
test('unknown targets and wrong before text never persist', async () => { h.complete.mockResolvedValue(JSON.stringify([{ target: 'bullet:missing', before: 'Original', after: 'New', reason: 'Source' }])); await expect(proposeBuilderChanges(id, true, id, 1, 'Improve')).rejects.toThrow(/target/); expect(h.store).not.toHaveBeenCalled(); });
// Mutation: model call on stale document or before input bounds validation.
test('stale and excessive requests never invoke model', async () => { await expect(proposeBuilderChanges(id, true, id, 2, 'Improve')).rejects.toThrow(/changed/); await expect(proposeBuilderChanges(id, true, id, 1, 'x'.repeat(4001))).rejects.toThrow(); expect(h.complete).not.toHaveBeenCalled(); });
// Mutation: accepting a grouped or duplicate edit that silently changes multiple targets.
test('valid suggestions remain individual replacements and duplicate targets fail', async () => { const item = { target: 'summary', before: 'Original', after: 'Revised', reason: 'Source supports wording' }; h.complete.mockResolvedValueOnce(JSON.stringify([item])); expect(await proposeBuilderChanges(id, true, id, 1, 'Improve')).toEqual([item]); h.complete.mockResolvedValueOnce(JSON.stringify([item, item])); await expect(proposeBuilderChanges(id, true, id, 1, 'Improve')).rejects.toThrow(/duplicate/); expect(h.store).toHaveBeenCalledTimes(1); });
