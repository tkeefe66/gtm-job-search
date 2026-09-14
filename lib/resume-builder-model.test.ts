import { describe, it, expect } from 'vitest';
import { validateBuilderProfile, applyBuilderProposal } from './resume-builder-model';
const profile = { name: 'A', headline: 'Engineer', contact: '', summary: 'Original', sections: [{ id: 's', title: 'Projects', entries: [{ id: 'e', heading: 'Project', subheading: '', dates: '', bullets: [{ id: 'b', text: 'Built it' }] }] }], sourceText: 'Original source' };
describe('builder model', () => {
    // Mutation: replacing empty content with a shipped career profile.
    it('allows an empty career without fallback', () => { expect(validateBuilderProfile({ ...profile, name: '', headline: '', summary: '', sections: [], sourceText: '' }).sections).toEqual([]); });
    // Mutation: removing duplicate identity validation.
    it('rejects duplicate IDs across entity kinds', () => { expect(() => validateBuilderProfile({ ...profile, sections: [{ ...profile.sections[0], id: 'b' }] })).toThrow(/unique/); });
    // Mutation: removing length bound.
    it('rejects excessive source text', () => { expect(() => validateBuilderProfile({ ...profile, sourceText: 'x'.repeat(60001) })).toThrow(); });
    // Mutation: mutating the source profile or accepting wrong before text.
    it('applies exact stored text to a fresh snapshot and rejects stale targets', () => {
        const proposal = { target: 'bullet:b', before: 'Built it', after: 'Built this', revision: 1 };
        const result = applyBuilderProposal(profile, proposal);
        expect(result.sections[0].entries[0].bullets[0].text).toBe('Built this');
        expect(profile.sections[0].entries[0].bullets[0].text).toBe('Built it');
        expect(result.sourceText).toBe(profile.sourceText);
        expect(() => applyBuilderProposal(profile, { ...proposal, before: 'Wrong' })).toThrow(/changed/);
        expect(() => applyBuilderProposal(profile, { ...proposal, target: 'bullet:missing' })).toThrow();
    });
    // Mutation: stripping HTML-like literal career text rather than escaping in renderer.
    it('retains literal text and sanitizes em dashes', () => { expect(validateBuilderProfile({ ...profile, summary: '<script> — literal' }).summary).toBe('<script> - literal'); });
});
