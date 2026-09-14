export type BuilderTemplate = 'classic' | 'editorial' | 'sidebar';
export type BuilderSection = {
    id: string;
    title: string;
    entries: {
        id: string;
        heading: string;
        subheading: string;
        dates: string;
        bullets: {
            id: string;
            text: string;
        }[];
    }[];
};
export type BuilderProfile = {
    name: string;
    headline: string;
    contact: string;
    summary: string;
    sections: BuilderSection[];
    sourceText: string;
};
export type BuilderDesign = {
    template: BuilderTemplate;
    templateVersion?: '1';
    pageLimit: 1 | 2;
    pageSize: 'letter' | 'a4';
    accent: 'slate' | 'blue' | 'green';
    font: 'sans' | 'serif';
};
export type BuilderDocument = {
    id: string;
    revision: number;
    title: string;
    jobId: string | null;
    profile: BuilderProfile;
    design: BuilderDesign;
    updatedAt: string;
};
export type BuilderProposal = {
    id: string;
    documentId: string;
    revision: number;
    target: string;
    before: string;
    after: string;
    reason: string;
    status: 'pending' | 'accepted' | 'rejected' | 'stale' | 'blocked';
};
export type BuilderVersion = {
    id: string;
    documentId: string;
    title: string;
    createdAt: string;
    expiresAt: string;
};
export type BuilderResult<T> = {
    data: T;
    error?: never;
} | {
    data?: never;
    error: string;
};
export class BuilderInputError extends Error {
}
export function builderText(v: unknown, max: number, label: string, required = false): string {
    if (typeof v !== 'string' || v.length > max || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(v) || (required && !v.trim()))
        throw new BuilderInputError(`${label} is missing or exceeds ${max} characters.`);
    return v.replace(/\u2014/g, '-');
}
function object(v: unknown): Record<string, unknown> { if (!v || typeof v !== 'object' || Array.isArray(v))
    throw new BuilderInputError('Invalid resume structure.'); return v as Record<string, unknown>; }
function list(v: unknown, max: number): unknown[] { if (!Array.isArray(v) || v.length > max)
    throw new BuilderInputError(`Resume list must contain at most ${max} items.`); return v; }
export function validateBuilderProfile(input: unknown): BuilderProfile {
    const v = object(input), ids = new Set<string>();
    let total = 0;
    const id = (value: unknown) => { const s = builderText(value, 80, 'Item ID', true); if (!/^[a-zA-Z0-9_-]+$/.test(s) || ids.has(s))
        throw new BuilderInputError('Item IDs must be unique letters, numbers, underscores or hyphens.'); ids.add(s); return s; };
    const text = (value: unknown, max: number, label: string) => { const s = builderText(value, max, label); total += s.length; if (total > 100000)
        throw new BuilderInputError('Resume content is too long.'); return s; };
    return { name: text(v.name, 200, 'Name'), headline: text(v.headline, 500, 'Headline'), contact: text(v.contact, 2000, 'Contact'), summary: text(v.summary, 6000, 'Summary'), sourceText: text(v.sourceText, 60000, 'Source text'), sections: list(v.sections, 20).map(x => { const s = object(x); return { id: id(s.id), title: text(s.title, 200, 'Section title'), entries: list(s.entries, 40).map(y => { const e = object(y); return { id: id(e.id), heading: text(e.heading, 500, 'Heading'), subheading: text(e.subheading, 500, 'Subheading'), dates: text(e.dates, 200, 'Dates'), bullets: list(e.bullets, 30).map(z => { const b = object(z); return { id: id(b.id), text: text(b.text, 4000, 'Bullet') }; }) }; }) }; }) };
}
export function validateBuilderDesign(input: unknown): BuilderDesign {
    const v = object(input);
    if (v.templateVersion !== undefined && v.templateVersion !== '1')
        throw new BuilderInputError('Unsupported template version.');
    if (!['template', 'pageSize', 'accent', 'font'].every(k => typeof v[k] === 'string') || !['classic', 'editorial', 'sidebar'].includes(String(v.template)) || ![1, 2].includes(v.pageLimit as number) || !['letter', 'a4'].includes(String(v.pageSize)) || !['slate', 'blue', 'green'].includes(String(v.accent)) || !['sans', 'serif'].includes(String(v.font)))
        throw new BuilderInputError('Choose a supported template, page size, page limit, accent and font.');
    return { template: v.template as BuilderTemplate, templateVersion: '1', pageLimit: v.pageLimit as 1 | 2, pageSize: v.pageSize as 'letter' | 'a4', accent: v.accent as BuilderDesign['accent'], font: v.font as BuilderDesign['font'] };
}
export function validateBuilderId(id: unknown): asserts id is string { if (typeof id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))
    throw new BuilderInputError('Invalid resume identifier.'); }
export function validateBuilderRevision(rev: unknown): asserts rev is number { if (!Number.isSafeInteger(rev) || Number(rev) < 1)
    throw new BuilderInputError('Invalid resume revision. Reload and try again.'); }
export function applyBuilderProposal(profile: BuilderProfile, p: Pick<BuilderProposal, 'target' | 'before' | 'after'>): BuilderProfile {
    const next = validateBuilderProfile(profile);
    let found = false;
    const replace = (before: string, max: number) => { if (before !== p.before)
        throw new BuilderInputError('This content changed. Request a fresh suggestion.'); found = true; const after = builderText(p.after, max, 'Replacement', true); if (after !== p.after)
        throw new BuilderInputError('Suggestion contains unsupported punctuation. Request another suggestion.'); return after; };
    if (p.target === 'summary')
        next.summary = replace(next.summary, 6000);
    if (p.target === 'headline')
        next.headline = replace(next.headline, 500);
    for (const s of next.sections)
        for (const e of s.entries) {
            if (p.target === `entry:${e.id}:heading`)
                e.heading = replace(e.heading, 500);
            if (p.target === `entry:${e.id}:subheading`)
                e.subheading = replace(e.subheading, 500);
            for (const b of e.bullets)
                if (p.target === `bullet:${b.id}`)
                    b.text = replace(b.text, 4000);
        }
    if (!found)
        throw new BuilderInputError('Suggestion target no longer exists. Request a fresh suggestion.');
    return validateBuilderProfile(next);
}
