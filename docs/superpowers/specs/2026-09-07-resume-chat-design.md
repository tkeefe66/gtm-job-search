# Résumé chat, coverage, and the anchor fix

2026-09-07. Covers three changes to `/resume?jobId=…`, in increasing order of
size: the bullet-selection anchor rule, a coverage panel, and a conversational
agent that can change the document.

## Why these three are one spec

The anchor fix and the coverage panel are each a few lines. They are here
because the chat needs both: the agent cannot usefully discuss what to change
without `coverage()`'s answer in front of it, and the first thing anyone will
ask the agent is "why does the $13M revenue line lead a GTM Engineer résumé",
which is the anchor rule. Shipping the chat on top of an unexplained selection
would make the agent's first job to apologise for the algorithm.

---

## 1. The anchor rule

`selectBullets` (`lib/resume-render/render.js:45-50`) takes each role's
priority-1 bullet as an ANCHOR: it is pulled out of the pool, always survives,
and is then re-sorted back into the ranked list by priority — which puts it
first, because priority 1 sorts ahead of everything. The guard exists for a real
reason recorded in that comment: theme scoring on a deep pool could otherwise
drop a role's headline claim entirely.

**The defect is the second half, not the first.** Surviving and leading are two
different guarantees, and only survival was intended. Measured on the Together
AI "GTM Engineer" tailoring (job `3de70299`): the Principal role leads with
"$13M in influenced won revenue across Palo Alto Networks, T-Mobile, Verizon"
ahead of the GTM Playbook architecture bullet, on a posting about building
systems.

**Change.** The anchor keeps its guaranteed slot. Final ordering within a role
ranks by theme weight first, priority second — so a bullet with real signal for
the posting's top theme can lead, and the anchor still cannot be dropped.

```
ranked = (anchor ? [anchor, ...scored] : scored)
           .sort((a, b) => (weight(b) - weight(a)) || (a.priority||99) - (b.priority||99))
```

`opts.lead` continues to override everything on the first role, unchanged.

**What this knowingly accepts.** A role whose anchor scores zero against the
posting now appears mid-list rather than first. That is the intent — the anchor
is a floor on inclusion, not a claim about relevance — but it means a résumé
tailored to an off-theme posting will read differently than it does today. The
change is to the ALGORITHM, so every existing `tailored_resumes` draft is stale
in the same way a criteria change makes fit scores stale. **Drafts are not
migrated and not invalidated**: the row holds a `selection`, the screen renders
it, and Regenerate is one click. Nothing silently rewrites a document the user
may have already exported.

**Test.** A career fixture with a role whose priority-1 bullet carries no themes
and whose priority-3 bullet carries the top theme. Assert the priority-3 bullet
is index 0 AND the priority-1 bullet is still present. The mutation to bite: the
old `.sort` by priority alone must fail it.

---

## 2. The coverage panel

`coverage(career, requestedThemes, selection, vocabulary)`
(`lib/resume-render/render.js:225`) already computes everything needed and is
called by nothing in the app. It returns per requested theme a `pool` count, a
`selected` count, the `roles` that support it, and a `support` verdict of
`absent` / `thin` (< 3 bullets) / `strong`; plus `gaps` (the absent themes),
`unknown` (ids outside the vocabulary), and `strength` (the fraction of selected
bullets that are on-theme).

**Surface.** A `print:hidden` block on the tailor screen between the button row
and the document. Always rendered when a selection exists — not collapsed. It is
the only place the user can see the INPUT that produced the document, and a
collapsed panel would leave the screen exactly as opaque as it is today.

**Content.** One line per requested theme, in the model's ranked order, reading
e.g. `systems — strong · 11 bullets, 4 used`. Absent themes are called out
separately and in the warning colour already used on this screen (`#92400E`):
those are the posting asking for something the career record cannot answer, and
they are the panel's whole reason to exist. `strength` renders as a single
percentage with a plain-language label.

**Why it is computed server-side.** `tailorResumeForJob` already holds
`themes`, `selection`, the career record and the vocabulary at the moment it
writes the row. Computing there means the panel is derived from what was
actually stored, not recomputed in the client from possibly-diverged state, and
`getTailoredResume` can return it for a page load that did not re-tailor.

**Test.** Coverage of a selection with a known fixture: assert an absent theme
appears in `gaps`, a two-bullet theme reads `thin`, and `strength` is the
selected-on-theme ratio and not 1.0 for a mixed selection.

---

## 3. The chat

### What it is

A `print:hidden` panel on the tailor screen. The user types; the agent replies in
prose and, when the user asks for a change, emits STRUCTURED OPERATIONS that the
server validates and applies. The agent never emits résumé markup, and never
emits a whole document.

### The invariant this preserves, and where it bends

`render.js:11` states the contract: the application decides which bullets
survive, the renderer decides the markup, and nothing hand-builds `.rsm`. Every
operation below is applied by re-running `selectBullets` and `renderBody` with
different inputs. The document is always a render, never a paste.

Two of the three layers bend "bullets are selected, never authored", and that is
deliberate and user-approved. The bend is contained by making authored text
VISIBLY authored: any bullet whose text diverges from the career record is
flagged in the coverage panel, so the user always knows which lines are their
record speaking and which are not.

### Three layers, three storages

All three live in `tailored_resumes.content`, which is already `jsonb` and
already replaced wholesale by Regenerate. No migration for these.

```
content = {
  themes:    string[],            // unchanged
  selection: ResumeSelection,     // unchanged
  overrides: {
    selection?: { lead?, positioning?, taper?, compressAfter?,
                  bullets?: { [roleId]: string[] } },
    text?:      { [target: string]: string },
    design?:    { [token: string]: string },
  }
}
```

**Layer 1 — selection.** `set_themes`, `set_lead`, `set_positioning`,
`set_taper`, `set_compress_after`, `add_bullet`, `drop_bullet`, `swap_bullet`.
Every bullet id must exist in that role's pool in the career record; an id that
does not is a rejected operation, not a silently ignored one. Applied by calling
`selectBullets` with the overrides merged into `opts`, so the taper, the anchor
rule and the compression all keep working.

**Layer 2 — text.** `set_text(target, text)` where target is
`bullet:<roleId>:<bulletId>`, `summary`, or `positioning`. Stored as an override
map consulted by the render path; the career record is never mutated. A target
naming a bullet not in the current selection is rejected — the user cannot edit
a line that is not on the page.

**Layer 3 — design.** `set_design_token(name, value)` and `reset_design()`.
See "Design tokens" below.

**Escape hatch.** `request_rule_change(description)` — the agent's declared way
of saying a change needs a CSS RULE, not a token value. It has no effect on the
document. It renders as a note in the chat and is appended to the persisted
thread, so it can be brought to a development session and become a real repo
change with a build, a fixture diff and a `DESIGN_VERSION` bump. This exists so
the agent's answer to "make the header a two-column layout" is a specific,
actionable refusal rather than a plausible token edit that does not work.

### Career-record additions: an overlay, not a file write

The user asked for the agent to be able to propose new career bullets, reusable
across jobs. **It cannot do that by editing
`lib/resume-render/content/resume.json`.** That file is checked in and bundled;
a runtime write on Railway does not survive a deploy and is not visible to the
git history that makes the career record auditable.

So: `propose_career_bullet(roleId, text, themes[])` writes, ON THE USER'S
EXPLICIT APPROVAL, to a per-tenant CAREER OVERLAY — an `app_settings` row under
a standalone `CAREER_OVERLAY_KEY`, following the `PROFILE_KEY` precedent
exactly: a whole object, not a `SETTING_KEYS` member, so `mergeSettings`' shape
groups are untouched. The overlay is merged over the shipped record by a
`careerWithOverlay()` loader before every `selectBullets` call, so an added
bullet is available to every future job's tailoring and participates in theme
scoring like any other.

Overlay bullets are marked `origin: "overlay"` in the merged record and render
identically, but the coverage panel counts them separately: "3 of the 11 bullets
supporting `systems` are yours, not the checked-in record's." Folding an overlay
bullet back into `content/resume.json` is a repo change, deliberately — same
category as the escape hatch.

### Design tokens

The whole design system is custom properties, which is what makes a bounded
override layer possible. The allowlist is the properties that retune the
existing design without restructuring it:

- Spacing: `--rail`, `--page-margin`, `--gap-bullet`, `--stack-entry`, `--col-side`
- Type: `--type-body`, `--type-meta`, `--type-name`, `--type-org`, `--type-role`,
  `--type-section`, `--leading-tight`, `--tracking-tight`, `--measure-prose`
- Colour: `--ink-900`, `--text-primary`, `--text-accent`, `--rule-100`, `--link`

Deliberately EXCLUDED: `--page-width` / `--page-height` (a document that is not
US Letter prints wrong with no on-screen symptom), the font families (a face the
print pipeline has not loaded falls back silently), and everything under
`elevation.css` (screen-only shadows that mean nothing in an export).

**Values are parsed, not pattern-matched.** A length token accepts a number plus
one of `px|pt|rem|em|%|ch`, within per-token bounds; a colour token accepts a
hex triplet or a named colour from a fixed set. Anything else is a rejected
operation with a reason shown in the chat. A regex over "looks like CSS" is not
sufficient here: this value is written into a `style` attribute that is later
persisted and re-served.

**Where the override lives in the DOM, and why it matters.** It is emitted as an
inline `style` on the `.rsm` root div. `useResumeCapture` captures
`docPageEl.innerHTML`, and `.rsm` is a CHILD of `docPageEl` — so its attributes
are inside the capture and travel into `saved_resumes` for free. Putting the
overrides on `docPageEl` itself, or in a `<style>` in the head, would look
identical on screen and silently lose every design change on Save. This is the
same class of trap as the two `useResumeCapture` already documents.

**Sanitizer change, and its risk.** `lib/resume-sanitize.ts` currently allows
`style` on `section` with a single literal value (`margin-bottom: 0`). It must
grow to allow `style` on the `.rsm` div carrying CUSTOM PROPERTIES only.
`sanitize-html`'s `allowedStyles` does not understand custom properties, so this
is a `transformTags` on the root div that re-parses the declaration list and
rebuilds it from the same allowlist and value parser used on the write path —
one parser, two call sites, so a value that could not be set cannot be saved
either. **Test the sanitizer against a hostile value directly**
(`--rail: 1px; } .rsm { background: url(…)`), not only against values the app
produced.

### The model call

One `callStructured` per user turn. No new provider capability: the transcript
is rendered into the prompt, and the response comes back through the existing
single-`emit`-tool JSON path, so `lib/providers/types.ts`'s interface is
untouched and the model-agnostic design holds.

The response schema:

```
{ reply: string, operations: Operation[] }
```

`reply` is prose shown in the thread. `operations` is validated
server-side against the discriminated union above — the schema constrains
decoding, the server enforces. **An operation is never trusted because the model
emitted it**: ids are checked against the career record, tokens against the
allowlist, values against the parser. Anything rejected is reported in the
thread with the reason rather than dropped.

The system prompt carries: the theme vocabulary, the career record's role and
bullet ids with their themes (ids and one-line text, not the full record), the
current selection, the current overrides, the coverage result, the posting's
requirements and nice-to-haves, and the operation catalogue. It states the
invariant in the terms this repo uses — you may reorder and retune, you may not
invent a bullet without proposing it, you may not write CSS rules.

**Billing.** Every turn goes through `withBudget` with
`action: "resume-chat"`, matching `tailor-resume`'s pattern. The panel shows
nothing about cost per turn, but the existing metering surfaces it like any
other action. A capped budget refuses the turn with the standard message.

### Persistence

New table, migration `019_resume_chats.sql`:

```sql
create table if not exists resume_chats (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references users(id) on delete cascade,
  job_id     uuid not null references jobs(id) on delete cascade,
  messages   jsonb not null default '[]',
  updated_at timestamptz not null default now(),
  unique (tenant_id, job_id)
);
```

`tenant_id` is declared INLINE, which is invisible to `lib/supabase.test.ts`'s
ALTER TABLE retrofit regex — so `"resume_chats"` must be added to
`TENANT_TABLES` by hand, exactly as 015, 016 and 018 record. Explicit grant to
`app_rw`, `force row level security`, same as 015.

The thread is per (tenant, job) and survives reload. It is NOT covered by the
60-day résumé retention: that window exists for frozen documents in
`saved_resumes`, and the chat is working state on the draft, which already never
expires. It dies with the job row via the cascade.

### The panel

App chrome, not document: Tailwind, the existing `ink`/`slate`/`canvas`
palette, `print:hidden`. It does not use the résumé design tokens — those are
scoped to `.rsm` and describe a printed page, and borrowing them for a chat
sidebar is how the three deliberate divergences in `tokens/` get "tidied" back
to the vendored source by someone who assumes they are shared.

Each assistant turn renders its prose plus, beneath it, the operations it
applied as a plain list — "set themes: systems, data, ops", "swapped a bullet on
Principal GTM Expert" — and any it could not, with the reason. A turn that
changed the document re-renders it immediately; there is no separate apply step.
`dirty` is set exactly as a manual edit sets it, so the existing unsaved-edits
warning and the Regenerate confirm both cover chat changes with no new
machinery.

**Regenerate discards overrides.** It re-derives themes from the posting and
writes a fresh `content`, which is what "regenerate" has always meant. The
confirm text must say so — the current wording ("the current version will be
replaced") is true but will read as under-stating it once a user has spent ten
turns tuning a document.

---

## Testing

Pure logic, per this repo's gate (`npm run build && npm test`; Claude calls are
verified by hand):

- **Anchor ordering** — the mutation test above.
- **Coverage** — gaps, thin/strong verdicts, strength ratio.
- **Operation validation** — a bullet id outside the role's pool, a design token
  outside the allowlist, a malformed length, a text target not in the current
  selection. Each rejected with a reason, none applied.
- **Value parser** — shared by the write path and the sanitizer; a table of
  accepted and rejected values, including the injection attempt above.
- **Sanitizer round-trip** — a captured document carrying custom properties on
  `.rsm` survives; a `background:url(...)` on the same element does not; the
  existing `.rsm`-root check still fires.
- **Overlay merge** — an overlay bullet participates in theme scoring, is marked
  `origin: "overlay"`, and an overlay for a role id the record does not have is
  ignored rather than throwing.
- **Prompt builder** — a fixture pinning the rendered chat system prompt, the
  same way `lib/hiring-signal-prompt.ts` and `lib/fit-prompt.ts` are pinned, so
  a change to what the agent is told shows up as a diff.

Not covered by tests, verified by hand on the deployed build: that the model
returns usable operations, and that a design token change survives Save and
re-open.

## Out of scope

- Editing `content/resume.json` at runtime. Overlay only; folding back is a repo
  change.
- CSS rules, new selectors, layout restructuring. Escape hatch only.
- Chat on the SAVED résumé screen. Saved rows are frozen HTML that is never
  re-rendered; a chat there would have nothing to operate on.
- Streaming responses. One request, one reply, matching every other model call
  in this app.
