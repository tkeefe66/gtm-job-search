"use client";

import Script from "next/script";
import { Fragment } from "react";

// `<doc-page>` is a custom element defined by /public/resume-design/doc-page.js
// at runtime — not a React component. This augments JSX so TypeScript accepts
// it as an intrinsic element (attributes we actually use: margin).
declare global {
  namespace JSX {
    interface IntrinsicElements {
      "doc-page": React.DetailedHTMLProps<
        React.HTMLAttributes<HTMLElement> & { margin?: string },
        HTMLElement
      >;
    }
  }
}

export interface ResumeLink {
  label: string;
  href: string;
}

export interface ResumeContact {
  name: string;
  tagline: string;
  location: string;
  phone: string;
  email: string;
  links: ResumeLink[];
}

/**
 * One Professional Experience entry. An entry with an EMPTY `bullets` array
 * renders as a single compressed row (title/org/dates only) instead of a
 * full role block with bullets — that's the design system's own rule
 * (USAGE.md §6: "Anything from 2018 and earlier is a single row, never a
 * role entry"), not a separate flag this component invents.
 */
export interface WorkHistoryEntry {
  id: string;
  title: string;
  org: string;
  /** e.g. "Remote — San Francisco, CA" or "Onsite — San Mateo, CA" */
  locationLine: string;
  /** e.g. "(acquired by Demandbase)" — omitted when empty. */
  acquisitionNote?: string;
  dates: string;
  /** Each bullet may wrap at most one figure in `**...**` for the single
   *  permitted bold span per bullet (USAGE.md's own bolding rule). */
  bullets: string[];
}

export interface ResumeRow {
  id: string;
  title: string;
  org: string;
  dates: string;
}

export interface ResumeData {
  contact: ResumeContact;
  summary: string;
  workHistory: WorkHistoryEntry[];
  advisory: ResumeRow[];
  education: ResumeRow[];
}

/** Renders `**bold**` spans as `<strong>`, everything else as plain text —
 *  a tiny parser instead of dangerouslySetInnerHTML, since bullet text may
 *  eventually come from user edits or model output. */
function BulletText({ text }: { text: string }) {
  const parts = text.split(/(\*\*[^*]+\*\*)/g).filter((p) => p.length > 0);
  return (
    <>
      {parts.map((part, i) => {
        if (part.startsWith("**") && part.endsWith("**")) {
          return <strong key={i}>{part.slice(2, -2)}</strong>;
        }
        return <Fragment key={i}>{part}</Fragment>;
      })}
    </>
  );
}

function RoleEntry({ entry }: { entry: WorkHistoryEntry }) {
  return (
    <div className="rsm-role">
      <div className="rsm-role-head">
        <h3 className="rsm-role-title">{entry.title}</h3>
        <div className="rsm-role-dates">{entry.dates}</div>
      </div>
      <p className="rsm-role-org">
        <b>{entry.org}</b> · {entry.locationLine}
        {entry.acquisitionNote ? <em> {entry.acquisitionNote}</em> : null}
      </p>
      <ul className="rsm-bullets">
        {entry.bullets.map((b, i) => (
          <li key={i}>
            <BulletText text={b} />
          </li>
        ))}
      </ul>
    </div>
  );
}

function CompressedRoles({ entries }: { entries: WorkHistoryEntry[] }) {
  if (entries.length === 0) return null;
  return (
    <dl className="rsm-compressed">
      {entries.map((entry) => (
        <Fragment key={entry.id}>
          <dt>
            <b>{entry.title}</b> <span>· {entry.org}</span>
          </dt>
          <dd>{entry.dates}</dd>
        </Fragment>
      ))}
    </dl>
  );
}

function Rows({ rows }: { rows: ResumeRow[] }) {
  return (
    <div className="rsm-rows">
      {rows.map((row) => (
        <div className="rsm-row" key={row.id}>
          <div className="rsm-row-main">
            <b>{row.title}</b> <span>· {row.org}</span>
          </div>
          <div className="rsm-row-dates">{row.dates}</div>
        </div>
      ))}
    </div>
  );
}

/**
 * Renders a résumé document inside the `<doc-page>` print/pagination shell
 * from the "My Resume Design System" Claude Design project — a real,
 * external custom element (public/resume-design/doc-page.js), not
 * reimplemented here. This component reproduces `ui_kits/resume/index.html`'s
 * structure as JSX; every ⚠️ in USAGE.md is a silent-breakage trap the
 * markup below deliberately follows:
 *   - name + tagline share ONE wrapping <div> inside .rsm-header
 *   - .rsm-section-title is a DIRECT child of .rsm-section
 *   - .rsm-row always sits inside a .rsm-rows wrapper
 */
export default function ResumeDocument({ resume }: { resume: ResumeData }) {
  const fullRoles = resume.workHistory.filter((e) => e.bullets.length > 0);
  const compressedRoles = resume.workHistory.filter((e) => e.bullets.length === 0);

  return (
    <>
      <Script src="/resume-design/doc-page.js" strategy="afterInteractive" />
      <Script src="/resume-design/page-guides.js" strategy="afterInteractive" />
      <style>{`doc-page:not(:defined) { visibility: hidden; }`}</style>
      <doc-page margin="0.68in">
        <div className="rsm">
          <header className="rsm-header">
            <div>
              <h1 className="rsm-name">{resume.contact.name}</h1>
              <p className="rsm-tagline">{resume.contact.tagline}</p>
            </div>
            <div className="rsm-contact">
              <span>{resume.contact.location}</span>
              <span>{resume.contact.phone}</span>
              <a href={`mailto:${resume.contact.email}`}>{resume.contact.email}</a>
              {resume.contact.links.map((link) => (
                <a href={link.href} key={link.href}>
                  {link.label}
                </a>
              ))}
            </div>
          </header>
          <p className="rsm-summary">{resume.summary}</p>
          <section className="rsm-section">
            <h2 className="rsm-section-title">Professional Experience</h2>
            {fullRoles.map((entry) => (
              <RoleEntry entry={entry} key={entry.id} />
            ))}
            <CompressedRoles entries={compressedRoles} />
          </section>
          {resume.advisory.length > 0 && (
            <section className="rsm-section">
              <h2 className="rsm-section-title">Advisory</h2>
              <Rows rows={resume.advisory} />
            </section>
          )}
          <section className="rsm-section" style={{ marginBottom: 0 }}>
            <h2 className="rsm-section-title">Education</h2>
            <div className="rsm-rows">
              {resume.education.map((row, i) => (
                <div
                  className="rsm-row"
                  key={row.id}
                  style={i === resume.education.length - 1 ? { marginBottom: 0 } : undefined}
                >
                  <div className="rsm-row-main">
                    <b>{row.title}</b> <span>· {row.org}</span>
                  </div>
                  <div className="rsm-row-dates">{row.dates}</div>
                </div>
              ))}
            </div>
          </section>
        </div>
      </doc-page>
    </>
  );
}
