"use client";
import { useEffect, useMemo, useRef, useState } from 'react';
import * as actions from '@/app/actions/resume-builder';
import { readResumeUpload } from '@/app/actions/resume-upload';
import type { BuilderDesign, BuilderDocument, BuilderProfile, BuilderProposal, BuilderResult, BuilderVersion } from '@/lib/resume-builder-model';
import { builderHtml } from '@/lib/resume-builder-html';
import ResumePreview from './ResumePreview';
import ProfileEditor, { emptyProfile } from './ProfileEditor';
import { revisionReady } from './editor-state';
import './builder.css';
const defaultDesign: BuilderDesign = { template: 'classic', font: 'sans', accent: 'slate', pageSize: 'letter', pageLimit: 1 };
type Library = {
    documents: BuilderDocument[];
    profile: BuilderProfile | null;
};
type Draft = {
    title: string;
    profile: BuilderProfile;
    design: BuilderDesign;
};
const asDraft = (document: BuilderDocument): Draft => ({ title: document.title, profile: document.profile, design: document.design });
export default function ResumeBuilder({ initialLibrary, jobId }: {
    initialLibrary: BuilderResult<Library>;
    jobId?: string;
}) {
    const [library, setLibrary] = useState<Library>(initialLibrary.data ?? { documents: [], profile: null });
    const [editing, setEditing] = useState(!!jobId);
    const [saved, setSaved] = useState<BuilderDocument | null>(null);
    const [draft, setDraft] = useState<Draft>({ title: '', profile: emptyProfile(), design: defaultDesign });
    const [proposals, setProposals] = useState<BuilderProposal[]>([]);
    const [versions, setVersions] = useState<BuilderVersion[]>([]);
    const [busy, setBusy] = useState('');
    const lock = useRef(false);
    const [error, setError] = useState(initialLibrary.error !== undefined ? initialLibrary.error || 'Could not load resumes. Reload to try again.' : '');
    const [notice, setNotice] = useState('');
    const [instruction, setInstruction] = useState('');
    const [reviewed, setReviewed] = useState(false);
    const [panel, setPanel] = useState<'content' | 'design' | 'suggestions' | 'versions'>('content');
    const dirty = editing && (!saved || JSON.stringify(draft) !== JSON.stringify(asDraft(saved)));
    const ready = revisionReady(!!saved, !!busy, dirty);
    const preview = useMemo(() => builderHtml(draft.profile, draft.design), [draft.profile, draft.design]);
    useEffect(() => {
        if (!dirty)
            return;
        const leave = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
        const navigate = (event: MouseEvent) => {
            const link = (event.target as Element).closest?.('a[href]');
            if (link && !window.confirm('Leave this page and discard unsaved resume edits?')) {
                event.preventDefault();
                event.stopPropagation();
            }
        };
        // App Router history traversals do not trigger beforeunload or a link click.
        // Modern browsers can cancel these before Next handles the navigation.
        const navigation = (window as unknown as { navigation?: EventTarget }).navigation;
        const traverse = (event: Event) => {
            if ((event as Event & { navigationType?: string }).navigationType === 'traverse' && event.cancelable && !window.confirm('Leave this page and discard unsaved resume edits?')) event.preventDefault();
        };
        const currentUrl = window.location.href;
        const currentState = window.history.state;
        const fallbackTraversal = (event: PopStateEvent) => {
            if (!window.confirm('Leave this page and discard unsaved resume edits?')) {
                event.stopImmediatePropagation();
                // Older browsers cannot cancel a traversal; restore this editor's
                // URL before the router sees it, preserving the working draft.
                window.history.pushState(currentState, '', currentUrl);
            }
        };
        window.addEventListener('beforeunload', leave);
        document.addEventListener('click', navigate, true);
        if (navigation) navigation.addEventListener('navigate', traverse);
        else window.addEventListener('popstate', fallbackTraversal, true);
        return () => {
            window.removeEventListener('beforeunload', leave);
            document.removeEventListener('click', navigate, true);
            navigation?.removeEventListener('navigate', traverse);
            window.removeEventListener('popstate', fallbackTraversal, true);
        };
    }, [dirty]);
    async function run(label: string, operation: () => Promise<void>) {
        if (lock.current)
            return;
        lock.current = true;
        setBusy(label);
        setError('');
        setNotice('');
        try {
            await operation();
        }
        catch (cause) {
            setError(cause instanceof Error && cause.message ? cause.message : `${label} failed. Your draft is still here. Try again.`);
        }
        finally {
            lock.current = false;
            setBusy('');
        }
    }
    function unwrap<T>(result: BuilderResult<T>): T {
        if (result.error !== undefined)
            throw new Error(result.error || 'The request failed. Your draft is still here. Try again.');
        return result.data as T;
    }
    function adopt(document: BuilderDocument) {
        setSaved(document);
        setDraft(asDraft(document));
        setEditing(true);
        setReviewed(true);
        setLibrary(current => ({ ...current, documents: [document, ...current.documents.filter(item => item.id !== document.id)] }));
    }
    async function refreshDetails(id: string) {
        const details = unwrap(await actions.getBuilderDocument(id));
        setProposals(details.proposals);
        setVersions(details.versions);
        return details.document;
    }
    function newResume() {
        if (dirty && !window.confirm('Discard unsaved edits and create another resume?'))
            return;
        setSaved(null);
        setDraft({ title: '', profile: emptyProfile(), design: { ...defaultDesign } });
        setProposals([]);
        setVersions([]);
        setReviewed(false);
        setEditing(true);
        setPanel('content');
        setError('');
        setNotice('');
    }
    async function save() {
        await run('Saving draft', async () => {
            const document = unwrap(saved ? await actions.updateBuilderDocument(saved.id, saved.revision, draft) : await actions.createBuilderDocument({ ...draft, ...(jobId ? { jobId } : {}) }));
            adopt(document);
            if (!saved) setLibrary(current => ({ ...current, profile: document.profile }));
            setNotice('Draft saved. PDF export checks the selected page limit.');
            await refreshDetails(document.id);
        });
    }
    function changeProfile(profile: BuilderProfile) { setDraft(current => ({ ...current, profile })); if (!saved)
        setReviewed(false); }
    async function download(versionId?: string) {
        if (!saved || busy || (!versionId && !ready))
            return;
        await run('Preparing PDF', async () => {
            const response = await fetch(`/api/resume-builder/${encodeURIComponent(saved.id)}/pdf?${versionId ? `versionId=${encodeURIComponent(versionId)}` : `revision=${saved.revision}`}`, { cache: 'no-store' });
            if (!response.ok) {
                const body = await response.text();
                let message = 'PDF export failed. Check the page limit, save your edits and retry.';
                try {
                    const json = JSON.parse(body);
                    if (typeof json.error === 'string' && json.error)
                        message = json.error;
                }
                catch { /* HTML error pages are not user-facing export messages. */ }
                throw new Error(message);
            }
            if (!response.headers.get('content-type')?.includes('application/pdf'))
                throw new Error('PDF export returned an unexpected response. Sign in again and retry.');
            const url = URL.createObjectURL(await response.blob());
            const link = document.createElement('a');
            link.href = url;
            link.download = `${saved.title.replace(/[^a-zA-Z0-9 _-]/g, '').slice(0, 100) || 'resume'}.pdf`;
            link.click();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
            setNotice('PDF downloaded.');
        });
    }
    return <main className="rb-shell">
    <header className="rb-header"><div><h1>Resume studio</h1><p>Create a resume from your own career information.</p></div><div className="rb-row"><button disabled={!!busy} onClick={() => { if (!dirty || window.confirm('Discard unsaved edits and return to the library?'))
        setEditing(false); }}>Library</button><button disabled={!!busy} onClick={newResume}>Create resume</button></div></header>
    {error && <div role="alert" className="rb-error">{error}</div>}
    {(notice || busy) && <p role="status" className="rb-status">{busy ? `${busy}…` : notice}</p>}
    {!editing ? <section className="rb-library"><h2>Your resumes</h2>{library.documents.length === 0 ? <div className="rb-empty"><h3>Your next resume starts here.</h3><p>Import text from an existing resume or enter your experience. Review your information, then choose a design.</p><button className="rb-primary" onClick={newResume}>Create your first resume</button></div> : <ul>{library.documents.map(item => <li key={item.id}><div><h3>{item.title}</h3><p>{item.design.template} · {item.design.pageLimit}-page maximum · Updated {new Date(item.updatedAt).toLocaleDateString()}</p></div><button disabled={!!busy} onClick={() => run('Opening resume', async () => { const document = await refreshDetails(item.id); adopt(document); setPanel('content'); })}>Open <span className="sr-only">{item.title}</span></button></li>)}</ul>}</section> : <>
      <div className="rb-document-bar"><label>Resume title<input value={draft.title} disabled={!!busy} onChange={event => setDraft({ ...draft, title: event.target.value })}/></label><span className="rb-hint">{saved ? dirty ? 'Unsaved edits' : `Saved · Revision ${saved.revision}` : 'New draft'}</span><button className="rb-primary" disabled={!!busy || !draft.title.trim() || !draft.profile.name.trim() || (!saved && !reviewed)} onClick={save}>Save draft</button><button disabled={!ready} onClick={() => download()}>Download PDF</button></div>
      {(saved?.jobId || (!saved && jobId)) && <p className="rb-hint">Linked to the tracked role selected when this resume was created. Suggestions can use that role; your content changes only with approval.</p>}
      <div className="rb-workspace"><section className="rb-editor"><nav className="rb-tabs" aria-label="Resume editor">{(['content', 'design', 'suggestions', 'versions'] as const).map(tab => <button key={tab} onClick={() => setPanel(tab)} aria-current={panel === tab ? 'page' : undefined}>{tab.charAt(0).toUpperCase() + tab.slice(1)}</button>)}</nav>
        <fieldset disabled={!!busy} className="rb-panel">
          {panel === 'content' && <>
            {!saved && <details open className="rb-import"><summary>Add your information</summary><p>Text-based PDF, DOCX or TXT, up to 1 MB. PDFs can contain up to 10 source pages. Formatting is unused; scanned PDFs need OCR or pasted text.</p><label>Import resume<input type="file" accept=".pdf,.docx,.txt" onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (!file)
                    return; void run('Reading upload', async () => { const form = new FormData(); form.append('resume', file); const result = await readResumeUpload(form); if (result.error !== undefined)
                    throw new Error(result.error || 'Could not read this file. Paste the text instead.'); if (!result.text)
                    throw new Error('No usable text found. Paste text or use OCR for a scanned PDF.'); changeProfile({ ...draft.profile, sourceText: result.text }); setNotice('Text imported. Parse it into fields or fill them in yourself, then review.'); }); }}/></label>
              {library.profile && <button onClick={() => { if (window.confirm('Replace this draft’s fields with your previously reviewed career information?'))
                    changeProfile(JSON.parse(JSON.stringify(library.profile))); }}>Use previously reviewed information</button>}
            </details>}
            <details className="rb-source" open={!saved}><summary>Source text and AI extraction</summary><label>Original career information<textarea rows={7} value={draft.profile.sourceText} onChange={event => changeProfile({ ...draft.profile, sourceText: event.target.value })}/></label><p>Parsing sends your source text to your configured AI provider and uses your credits and budget. It replaces the structured fields below with a draft for your review. Importing text itself does not use AI.</p><button disabled={!draft.profile.sourceText.trim()} onClick={() => { if ((draft.profile.name || draft.profile.sections.length > 0) && !window.confirm('Replace the structured fields with a new AI extraction? Your source text will remain.'))
                return; void run('Parsing information', async () => { const profile = unwrap(await actions.parseBuilderProfile(draft.profile.sourceText)); changeProfile(profile); setNotice('Review every field against your source. Add missing details before saving.'); }); }}>Parse with AI</button></details>
            <ProfileEditor profile={draft.profile} onChange={changeProfile}/>
            {!saved && <label className="rb-check"><input type="checkbox" checked={reviewed} onChange={event => setReviewed(event.target.checked)}/>I reviewed these details and confirm they are accurate.</label>}
          </>}
          {panel === 'design' && <div className="rb-fields"><h2>Choose your layout</h2><p>Every design uses the same content. Longer drafts stay editable; export checks the page limit without shrinking text.</p><div className="rb-template-options">{(['classic', 'editorial', 'sidebar'] as const).map(template => <button key={template} aria-pressed={draft.design.template === template} onClick={() => setDraft({ ...draft, design: { ...draft.design, template } })}><span className={`rb-template-icon rb-template-${template}`} aria-hidden="true"><i /><i /><i /><i /></span><strong>{template.charAt(0).toUpperCase() + template.slice(1)}</strong><small>{template === 'classic' ? 'Compact single column' : template === 'editorial' ? 'Prominent name and headings' : 'Contact and summary column'}</small></button>)}</div>{(['font', 'accent', 'pageSize', 'pageLimit'] as const).map(key => <label key={key}>{({ font: 'Typeface', accent: 'Accent color', pageSize: 'Paper size', pageLimit: 'Maximum pages' })[key]}<select value={draft.design[key]} onChange={event => setDraft({ ...draft, design: { ...draft.design, [key]: key === 'pageLimit' ? Number(event.target.value) : event.target.value } })}>{({ font: [['sans', 'Sans serif'], ['serif', 'Serif']], accent: [['slate', 'Slate'], ['blue', 'Blue'], ['green', 'Green']], pageSize: [['letter', 'US Letter'], ['a4', 'A4']], pageLimit: [['1', 'One page'], ['2', 'Two pages']] })[key].map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>)}</div>}
          {panel === 'suggestions' && <div className="rb-fields"><h2>Improve wording, one change at a time</h2><p>Requesting suggestions sends your resume and linked job details to your configured AI provider and uses your credits and budget. Each change is proposed separately. Verify facts before accepting.</p>{!ready && <p className="rb-hint">Save your draft before requesting or accepting suggestions.</p>}<label>What would you like to improve?<textarea rows={4} value={instruction} onChange={event => setInstruction(event.target.value)}/></label><button disabled={!ready || !instruction.trim()} onClick={() => run('Generating suggestions', async () => { setProposals(unwrap(await actions.suggestBuilderChanges(saved!.id, saved!.revision, instruction))); setNotice('Suggestions are ready for individual review. Nothing has been changed.'); })}>Suggest changes</button>{proposals.length === 0 && <p>No suggestions yet. Describe a goal, such as making a selected accomplishment clearer.</p>}{proposals.map(proposal => <article key={proposal.id} className="rb-proposal"><h3>{proposal.target.startsWith('bullet:') ? 'Accomplishment' : proposal.target.startsWith('entry:') ? 'Entry wording' : proposal.target}</h3><p className="rb-hint">{proposal.status}{proposal.revision !== saved?.revision ? ' · From an earlier revision' : ''}</p><h4>Current</h4><p>{proposal.before || '(Empty)'}</p><h4>Suggested</h4><p>{proposal.after}</p><p className="rb-hint">{proposal.reason}</p>{(proposal.status === 'pending' || proposal.status === 'blocked') && <div className="rb-row"><button disabled={!ready || proposal.revision !== saved?.revision} onClick={() => run('Accepting suggestion', async () => { adopt(unwrap(await actions.acceptBuilderProposal(proposal.id, saved!.revision))); await refreshDetails(saved!.id); setNotice('Exact suggested wording accepted. Other suggestions may need refreshing.'); })}>Accept</button><button disabled={!ready} onClick={() => run('Rejecting suggestion', async () => { unwrap(await actions.rejectBuilderProposal(proposal.id)); await refreshDetails(saved!.id); })}>Reject</button><button disabled={!ready} onClick={() => { setInstruction(`Revise only the proposal for ${proposal.target}. Current wording: ${proposal.before}\nPrevious suggestion: ${proposal.after}\nRequested improvement: `); setNotice('Describe the improvement in the instruction field, then select Suggest changes. This requests new proposals and incurs AI usage.'); }}>Request revision</button></div>}</article>)}</div>}
          {panel === 'versions' && <div className="rb-fields"><h2>Saved versions</h2><p>Versions preserve a snapshot for 60 days. Restoring replaces the working draft and invalidates old suggestions.</p><button disabled={!ready} onClick={() => run('Saving version', async () => { const version = unwrap(await actions.saveBuilderVersion(saved!.id, saved!.revision)); setVersions(current => [version, ...current]); setNotice('Version saved.'); })}>Save version</button>{versions.length === 0 && <p>No saved versions yet.</p>}{versions.map(version => <article className="rb-version" key={version.id}><strong>{version.title}</strong><p>Saved {new Date(version.createdAt).toLocaleString()}<br />Expires {new Date(version.expiresAt).toLocaleDateString()}</p><button disabled={!ready} onClick={() => { if (!window.confirm('Restore this version as the working draft? Current suggestions will become stale.'))
            return; void run('Restoring version', async () => { adopt(unwrap(await actions.restoreBuilderVersion(saved!.id, saved!.revision, version.id))); await refreshDetails(saved!.id); setNotice('Version restored as a new working revision.'); }); }}>Restore version</button> <button disabled={!!busy} onClick={() => download(version.id)}>Download version PDF</button></article>)}{saved && <div className="rb-danger"><h3>Delete resume</h3><p>Deletes this document, all saved versions and suggestions. This cannot be undone.</p><button disabled={!ready} onClick={() => { if (!window.confirm('Permanently delete this resume, all saved versions and suggestions? This cannot be undone.'))
            return; void run('Deleting resume', async () => { unwrap(await actions.deleteBuilderDocument(saved.id, saved.revision)); setLibrary(current => ({ ...current, documents: current.documents.filter(item => item.id !== saved.id) })); setSaved(null); setEditing(false); setNotice('Resume deleted.'); }); }}>Delete resume</button></div>}</div>}
        </fieldset>
        {saved && <button className="rb-reload" disabled={!!busy} onClick={() => { if (dirty && !window.confirm('Discard unsaved edits and reload the latest saved draft?'))
            return; void run('Reloading saved draft', async () => { adopt(await refreshDetails(saved.id)); setNotice('Latest saved draft loaded.'); }); }}>Reload latest saved draft</button>}
      </section><aside className="rb-preview"><div className="rb-preview-heading"><h2>Preview</h2><span>{draft.design.pageSize === 'letter' ? 'US Letter' : 'A4'} · {draft.design.pageLimit}-page maximum</span></div><p>Preview is provisional. PDF export verifies fonts, pagination and fit. Content is never silently removed.</p><ResumePreview html={preview} pageSize={draft.design.pageSize}/></aside></div>
    </>}
  </main>;
}
