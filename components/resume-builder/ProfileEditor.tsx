"use client";
import type { BuilderProfile, BuilderSection } from '@/lib/resume-builder-model';
import { moveItem } from './editor-state';
const id = () => crypto.randomUUID();
export const emptyProfile = (): BuilderProfile => ({ name: '', headline: '', contact: '', summary: '', sections: [], sourceText: '' });
export default function ProfileEditor({ profile, onChange }: {
    profile: BuilderProfile;
    onChange: (profile: BuilderProfile) => void;
}) {
    function section(index: number, value: BuilderSection) {
        onChange({ ...profile, sections: profile.sections.map((current, i) => i === index ? value : current) });
    }
    return <div className="rb-fields">
    {(['name', 'headline', 'contact', 'summary'] as const).map(key => <label key={key}>{({ name: 'Full name', headline: 'Professional headline (optional)', contact: 'Contact information', summary: 'Summary (optional)' })[key]}
      {key === 'summary' || key === 'contact' ? <textarea rows={key === 'summary' ? 4 : 2} value={profile[key]} onChange={event => onChange({ ...profile, [key]: event.target.value })}/> : <input value={profile[key]} onChange={event => onChange({ ...profile, [key]: event.target.value })}/>}
    </label>)}
    {!profile.name.trim() && <p className="rb-hint">Add your name before creating a resume. Leave unknown details blank and verify dates and accomplishments against your source.</p>}
    {profile.sections.map((item, i) => <fieldset className="rb-section" key={item.id}>
      <legend>{item.title || `Section ${i + 1}`}</legend>
      <div className="rb-row"><button type="button" disabled={i === 0} onClick={() => onChange({ ...profile, sections: moveItem(profile.sections, i, -1) })} aria-label={`Move section ${i + 1} up`}>Move up</button><button type="button" disabled={i === profile.sections.length - 1} onClick={() => onChange({ ...profile, sections: moveItem(profile.sections, i, 1) })} aria-label={`Move section ${i + 1} down`}>Move down</button><button type="button" onClick={() => { if (window.confirm(`Remove ${item.title || 'this section'} and its content from this draft?`))
            onChange({ ...profile, sections: profile.sections.filter((_, n) => n !== i) }); }}>Remove section</button></div>
      <label>Section title<input value={item.title} onChange={event => section(i, { ...item, title: event.target.value })}/></label>
      {item.entries.map((entry, j) => {
                const update = (value: typeof entry) => section(i, { ...item, entries: item.entries.map((current, n) => n === j ? value : current) });
                return <div className="rb-entry" key={entry.id}>
          <div className="rb-row"><strong>Entry {j + 1}</strong><button type="button" disabled={j === 0} aria-label={`Move entry ${j + 1} up in ${item.title}`} onClick={() => section(i, { ...item, entries: moveItem(item.entries, j, -1) })}>Up</button><button type="button" disabled={j === item.entries.length - 1} aria-label={`Move entry ${j + 1} down in ${item.title}`} onClick={() => section(i, { ...item, entries: moveItem(item.entries, j, 1) })}>Down</button><button type="button" onClick={() => { if (window.confirm('Remove this entry and its bullets from this draft?'))
                    section(i, { ...item, entries: item.entries.filter((_, n) => n !== j) }); }}>Remove entry</button></div>
          <label>Heading<input value={entry.heading} onChange={event => update({ ...entry, heading: event.target.value })}/></label>
          <label>Organization, qualification or detail<input value={entry.subheading} onChange={event => update({ ...entry, subheading: event.target.value })}/></label>
          <label>Dates (optional)<input value={entry.dates} onChange={event => update({ ...entry, dates: event.target.value })}/></label>
          {entry.bullets.map((bullet, k) => <div key={bullet.id}><label>Bullet {k + 1}<textarea rows={3} value={bullet.text} onChange={event => update({ ...entry, bullets: entry.bullets.map((current, n) => n === k ? { ...current, text: event.target.value } : current) })}/></label><div className="rb-row"><button type="button" disabled={k === 0} aria-label={`Move bullet ${k + 1} up`} onClick={() => update({ ...entry, bullets: moveItem(entry.bullets, k, -1) })}>Up</button><button type="button" disabled={k === entry.bullets.length - 1} aria-label={`Move bullet ${k + 1} down`} onClick={() => update({ ...entry, bullets: moveItem(entry.bullets, k, 1) })}>Down</button><button type="button" onClick={() => { if (window.confirm('Remove this bullet from this draft?'))
                    update({ ...entry, bullets: entry.bullets.filter((_, n) => n !== k) }); }}>Remove bullet</button></div></div>)}
          <button type="button" onClick={() => update({ ...entry, bullets: [...entry.bullets, { id: id(), text: '' }] })}>Add bullet</button>
        </div>;
            })}
      <button type="button" onClick={() => section(i, { ...item, entries: [...item.entries, { id: id(), heading: '', subheading: '', dates: '', bullets: [] }] })}>Add entry</button>
    </fieldset>)}
    <div className="rb-row">{['Experience', 'Education', 'Skills', 'Projects', 'Certifications', 'Volunteering', 'Other'].map(title => <button type="button" key={title} onClick={() => onChange({ ...profile, sections: [...profile.sections, { id: id(), title, entries: [{ id: id(), heading: '', subheading: '', dates: '', bullets: [] }] }] })}>Add {title.toLowerCase()}</button>)}</div>
  </div>;
}
