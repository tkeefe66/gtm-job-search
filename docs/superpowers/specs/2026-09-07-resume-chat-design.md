# Résumé chat, coverage, and the anchor fix

**Implemented 2026-09-08, see `docs/superpowers/plans/2026-09-07-resume-chat.md`.**

2026-09-07. Covers three changes to `/resume?jobId=…`: the bullet-selection
ordering rule, a coverage panel, and a conversational agent that can change the
document by selection, by text, and by design.

**Revision 2.** Revision 1 was reviewed against the code and was wrong in four
ways that mattered: it left model-authored text unescaped into an unescaped
renderer, it specified a migration with no RLS, it named the wrong model-call
entry point, and it invented a sanitizer workaround for a limitation
`sanitize-html` does not have. It also proposed an ordering rule that, run
against the real career record, promotes award bullets to the top of a role.
Each is corrected below and marked **[r1 defect]** so the reasoning is not
re-derived later.

## Why these are one spec

The ordering fix and the coverage panel are each small. They are here because
the chat needs both: the agent cannot usefully discuss what to change without
`coverage()`'s answer in front of it, and the first thing anyone will ask is why
the `$13M influenced revenue` line leads a GTM Engineer résumé — which is the
ordering rule.

---

## 0. One concept that removes most of the complexity: the effective record

Revision 1 stored three override layers and left "how the render path consults
them" unspecified in two places, which was its worst structural problem —
because the render path is `renderBody` in a VENDORED file running on the
CLIENT, against a career record `app/resume/page.tsx:10` imports statically from
`content/resume.json`. **[r1 defect]** Any override the server knew about and
the client's record did not would silently not render: `render.js:145` resolves
bullet ids against that record and `.filter(Boolean)` drops what it cannot find,
and `render.js:146` drops the entire role if nothing survives.

So there are no override layers threaded through the renderer. There is one
function:

```
effectiveCareer(shipped, overlay, textOverrides) -> CareerRecord
```

It returns a fresh record with overlay bullets merged into their roles and text
overrides applied to bullet/summary/positioning text. It runs SERVER-SIDE, and
`app/resume/page.tsx` passes its result to `TailorPanel` in place of the static
import. `selectBullets`, `renderBody` and `coverage` all then operate on one
record that already reflects every change, and `render.js` needs no knowledge of
overrides at all.

Consequences that fall out of this and are not separately designed:
- An overlay bullet participates in theme scoring like any other, because by the
  time `selectBullets` sees it there is nothing distinguishing it.
- A text override cannot reference a bullet that does not exist, because it is
  applied by id against the record and a miss is a rejected operation.
- The client renders exactly what the server scored.

`origin: "overlay"` and `edited: true` are carried as fields on the merged
bullets for the coverage panel to count. They are metadata; `renderBody` ignores
unknown fields.

---

## 1. Ordering within a role

`selectBullets` (`lib/resume-render/render.js:31-74`) takes each role's
priority-1 bullet as an ANCHOR: pulled out of the pool at :48-50, guaranteed to
survive, then re-sorted back by priority at :55-56 — which puts it first,
because priority 1 sorts ahead of everything.

**The defect is at :55-56, not :48-50.** Surviving and leading are two different
guarantees and only survival was intended; the comment at :45-47 says so.
Measured on the Together AI "GTM Engineer" tailoring (job `3de70299`), the
Principal role leads with "$13M in influenced won revenue across Palo Alto
Networks, T-Mobile, Verizon" on a posting about building systems.

**Revision 1's fix was wrong. [r1 defect]** It ranked the whole list by theme
weight, priority second. Simulated against the real record with
`themes: ['systems','data','ops']`, the `principal` role then leads with p6 —
`"2024 A.I. Revenue Summit A.I. Strategist Award; Demandbase Quarterly Value
Award."` — because that bullet is tagged `systems,evangelism` and outweighs
everything. `sr-director` p9 (`ops,evangelism`) does the same. Awards bullets
carry themes and would win a weight sort in most roles.

**What that reveals: the record under-specifies bullet KIND.** Priority is doing
two jobs — editorial rank and "awards go last" — and only one of them should
survive a re-rank. So the fix is a data field plus a rule.

**Data.** `bullets[].tail?: boolean`, default false. Set true on the bullets that
are recognition rather than accomplishment: `principal` p6 and `sr-director` p9
today. Adding a field to `content/resume.json` is a repo change with a diff, not
something the agent does.

**Rule.** Within a role:
1. `tail` bullets always sort after non-tail bullets, ordered among themselves by
   priority.
2. Non-tail bullets sort by theme weight descending, priority ascending as the
   tie-break.
3. The anchor's guaranteed INCLUSION at :48-50 is untouched. It loses only its
   forced first position.
4. `opts.lead` continues to override everything on the first role.

Checked against the record: with `themes: ['systems','product','data']` the
`principal` role leads with p3/p5 (product) and the $13M advisor bullet drops to
mid-list; `gtm-experts` leads with a `systems` bullet (p7/p8/p14) while its
anchor p1 still appears. That is the intended outcome.

**This edits a vendored file.** `render.d.ts:1-3` and `ResumeDocument.tsx:36-39`
record that `render.js` is ported from the TK Resume Design System, and
CLAUDE.md documents the re-sync hazard for `tokens/*.css` at length. A divergence
note goes IN `render.js` at the changed lines, naming what changed, why, and the
date — same treatment the three token divergences got. **[r1 defect: omitted]**

**Existing drafts are not migrated and not invalidated.** The row holds a
`selection`; the screen renders it; Regenerate is one click. Nothing silently
rewrites a document that may already have been exported.

**Test (mutation-first).** A fixture role whose priority-1 bullet has no themes,
whose priority-3 bullet carries the top theme, and whose priority-6 bullet is
`tail: true` and also carries the top theme. Assert: p3 at index 0, p1 present,
p6 last. The old priority-only sort must fail it, and so must revision 1's
weight-first sort.

---

## 2. The coverage panel

`coverage(career, requestedThemes, selection, vocabulary)`
(`lib/resume-render/render.js:225-258`) computes per requested theme a `pool`
count, a `selected` count, supporting `roles`, and a `support` verdict of
`absent` / `thin` (< 3) / `strong`; plus `gaps`, `unknown`, and `strength` (the
fraction of selected bullets that are on-theme). Nothing in the app calls it.

**It cannot be used as-is. [r1 defect]** `selectBullets` fills `bullets` for all
12 roles (`render.js:41`) but `renderBody` renders only
`roles.slice(0, compressAfter)` — 5 (`render.js:117-119`). Measured on the
shipped record with `themes: ['systems','data','ops']`: 23 bullets selected, 16
rendered, `strength` 0.870 against 0.813 for what is actually on the page, and
six of the ten roles it lists for `systems` are compressed one-line rows
carrying no bullets. A panel justified as "the only place you can see the input
that produced the document" must not describe a different document.

**Fix, without touching the vendored file.** A new pure module
`lib/resume-coverage.ts` calls `coverage()` TWICE against the effective record:

- **rendered** — with the record narrowed to `roles.slice(0, compressAfter)`.
  These are the numbers shown, and the numbers the agent is given.
- **full** — the whole record. Used only to say "you have 4 more bullets for
  `data`, all in compressed roles" — which is actionable, since raising
  `compressAfter` is an operation the agent can perform.

**Surface.** A `print:hidden` block on the tailor screen between the button row
and the document, always rendered when a selection exists. One line per
requested theme in the model's ranked order:
`systems — strong · 7 on the page, 4 used · 4 more in compressed roles`.
Absent themes are called out separately in the warning colour already used on
this screen (`#92400E`, `TailorPanel.tsx:114,128`) — those are the posting asking
for something the record cannot answer, and they are the panel's reason to
exist. `strength` renders as one percentage with a plain-language label. Two
counts are appended when non-zero: bullets from the overlay, and bullets whose
text has been edited.

**Computed server-side, recomputed every time, never stored. [r1 defect]**
Revision 1 said coverage was computed at write time and returned by
`getTailoredResume`, but put no field for it in the stored `content` and did not
say what happens when a chat operation changes the selection. Storing it creates
a staleness question with no upside: it is a pure function of (effective record,
themes, selection, vocabulary), all of which the server already holds on every
path that returns a selection. So `tailorResumeForJob`, `getTailoredResume` and
every chat turn each return a freshly computed `CoverageReport`.

**Test.** Against a fixture: an absent theme appears in `gaps`; a two-bullet
theme reads `thin`; `strength` is the on-theme ratio and is not 1.0 for a mixed
selection; and a bullet in a compressed role counts toward `full` but not
`rendered` — the mutation that collapses the two must fail.

---

## 3. The chat

### What it is

A `print:hidden` panel on the tailor screen. The user types; the agent replies in
prose and, when a change is asked for, emits STRUCTURED OPERATIONS that the
server validates and applies. The agent never emits résumé markup and never
emits a document.

### The invariant, and where it bends

`render.js:11` states the contract: the application decides which bullets
survive, the renderer decides the markup, nothing hand-builds `.rsm`. Every
operation is applied by re-running `selectBullets` and `renderBody` over a
different effective record. The document is always a render.

Text editing and overlay bullets bend "selected, never authored". That is
deliberate and approved. It is contained two ways: authored text is escaped and
tag-limited (below), and every authored line is counted in the coverage panel,
so the user always knows which lines are the record speaking.

### Operations

```
set_themes(themes[])            set_lead(roleId, bulletId)
set_positioning(positioningId)  set_taper(number[])
set_compress_after(n)           add_bullet(roleId, bulletId)
drop_bullet(roleId, bulletId)   swap_bullet(roleId, outId, inId)
set_text(target, text)          propose_career_bullet(roleId, text, themes[])
set_design_token(name, value)   reset_design()
request_rule_change(description)
```

**A turn is atomic. [r1 defect: unspecified]** If any operation in a turn fails
validation, NONE are applied and the whole turn is reported as rejected with the
reason. Partial application would leave the document, the coverage panel and the
persisted thread all describing a state nobody asked for.

**An operation is never trusted because the model emitted it.** Ids are checked
against the effective record, themes against the vocabulary, tokens against the
allowlist, values against the parser, text through the sanitizer below.

`request_rule_change` is the escape hatch: the agent's declared way of saying a
change needs a CSS RULE, not a token value. It has no effect on the document. It
is recorded in the thread so it can become a real repo change with a build, a
fixture diff and a `DESIGN_VERSION` bump. It exists so the answer to "make the
header two columns" is a specific, actionable refusal rather than a plausible
token edit that does nothing.

### Authored text: the injection vector revision 1 missed

**[r1 defect — the most serious one.]** `render.js:155` emits
`'<li>' + b.text + '</li>'` with NO escaping — `resume-sanitize.ts:5-8` documents
this deliberately, because `content/resume.json` carries 22 `<strong>` tags that
must survive. `renderBody`'s output reaches the DOM through
`dangerouslySetInnerHTML` (`ResumeDocument.tsx:80`) on the CLIENT, where
`sanitizeResumeHtml` — which runs server-side on Save only — has never run.
`role.title` (:149) is equally unescaped.

Revision 1 listed its validation as "ids, tokens, values" and put model-authored
strings straight into that slot.

**`lib/resume-text.ts`, one function, applied at every boundary:**

```
sanitizeBulletText(input) -> { text?: string; error?: string }
```

- `sanitize-html` with `allowedTags: ["strong", "b", "em", "i"]`,
  `allowedAttributes: {}`, `allowedSchemes: []`. Everything else is escaped, not
  merely stripped, so `<img onerror=…>` becomes visible text rather than a
  silent deletion the user cannot see happened.
- Length cap (600 chars), rejecting rather than truncating.
- Applied at THREE boundaries, because each alone has a way to be bypassed:
  when a `set_text` or `propose_career_bullet` operation is validated; again in
  `effectiveCareer()` when the stored value is merged, so a row written by an
  earlier build cannot render unsafe; and it remains subject to
  `sanitizeResumeHtml` on Save.
- `role.title` is never a `set_text` target. Titles come from the record only.

**Test.** `<img src=x onerror=alert(1)>`, `<script>`, an `<a href="javascript:">`,
a bare `&`, and a legitimate `<strong>$50M+</strong>` — the last must survive
byte-identically, the rest must be inert AND visible.

### The career overlay

The agent cannot edit `lib/resume-render/content/resume.json`: it is checked in
and bundled, a runtime write on Railway does not survive a deploy, and it is the
git history that makes the career record auditable.

`propose_career_bullet` writes, ON EXPLICIT USER APPROVAL IN THE CHAT, to a
per-tenant overlay stored in `app_settings` under a standalone
`CAREER_OVERLAY_KEY` — the `PROFILE_KEY` precedent exactly (`lib/settings-store.ts`):
a whole object, deliberately NOT a `SETTING_KEYS` member, so `mergeSettings`'
shape groups for list/text/number `Criteria` fields are untouched. Overlay
bullets get generated ids namespaced `ov-*` so they can never collide with a
record id, and `themes[]` is validated against the vocabulary.

An overlay entry for a role id the record does not have is dropped by
`effectiveCareer()` with a warning surfaced in the panel — not silently, since
after a record change that is the user's own text disappearing.

### Design tokens

**Five of revision 1's nineteen tokens are inert. [r1 defect]** Verified by
grepping `var(--…)` across `public/resume-design/`: `--page-margin`,
`--stack-entry`, `--col-side`, `--measure-prose` and `--text-accent` are defined
(`tokens/spacing.css:8,15,16,20`; `tokens/colors.css:17`) and consumed by
nothing. Setting them changes nothing on screen or in print while the agent
reports success.

`--page-margin` is the worst, because "tighten the margins" is a likely first
request. The real lever is the `margin="0.68in"` ATTRIBUTE on `<doc-page>`
(`ResumeDocument.tsx:76`), which `doc-page.js:193,206` maps to its own
`--doc-page-margin` on an ANCESTOR of `.rsm` — unreachable from an inline
override there under any spelling. It is therefore a separate operation,
`set_page_margin(value)`, applied as a React prop on `ResumeDocument`, with the
same parser and an `in|mm|px` unit set.

**Corrected allowlist — every entry verified to have consumers:**

- Spacing: `--rail`, `--gap-bullet`
- Type: `--type-body`, `--type-meta`, `--type-name`, `--type-org`, `--type-role`,
  `--type-section`, `--leading-tight`, `--tracking-tight`
- Colour: `--ink-900`, `--text-primary`, `--rule-100`, `--rule-200`, `--link`

`--rule-200` is added because `--rule-100` alone reaches only `.rsm-role`'s
bottom hairline (`tokens/document.css:37`); the section rules go through
`--border-rule` → `--rule-200` (`tokens/document.css:22`, `colors.css:21`), so
without it "change the rule colour" changes half the rules.

Excluded: `--page-width`/`--page-height` (a document that is not US Letter
prints wrong with no on-screen symptom), font families (an unloaded face falls
back silently), everything in `elevation.css` (screen-only shadows).

**Values are parsed, not pattern-matched.** Lengths: a number plus
`px|pt|rem|em|%|ch`, within per-token bounds. Colours: `oklch(...)` — the shipped
palette is entirely oklch (`tokens/colors.css:7-23`), so hex-only acceptance
would guarantee an override can never round-trip to the original and would sit
inconsistently beside the untouched half of the palette — plus hex and a fixed
set of names. **No `/u` flag and no `\p{…}` in these regexes**: `tsconfig.json`
declares no `target`, so `npm run build` typechecks at ES5 and either passes
vitest then fails the build. `lib/resume-sanitize.ts:27` carries the same
warning inline.

**Where the override is emitted.** As an inline `style` on the `.rsm` root div,
via a new `rootStyle` option on `renderBody` — a second, recorded divergence in
the vendored file. **[r1 defect: unspecified]** Revision 1 required the attribute
without saying how; the alternative, string-splicing it into `renderBody`'s
output, is literally hand-building `.rsm` markup, which is the invariant this
spec quotes.

`.rsm` is a CHILD of `docPageEl`, and `useResumeCapture` captures
`docPageEl.innerHTML` — so the attribute is inside the capture and travels into
`saved_resumes` for free. Putting it on `docPageEl` itself, or in a `<style>` in
the head, looks identical on screen and silently loses every design change on
Save. Same trap family as the two `useResumeCapture.ts:5-19` already documents.
`set_page_margin` is the exception and is NOT captured — it is an attribute on
`docPageEl`, outside `innerHTML` — so it must be re-applied on the saved screen
from a field on the saved row. `saved_resumes` has no such column
(`db/migrations/016_saved_resumes.sql:20-32`), so this needs
`020_saved_resume_page_margin.sql`: `alter table saved_resumes add column if not
exists page_margin text`. An ALTER on an existing table inherits its RLS and its
`app_rw` grant — migration 009's column-list revoke is `users`-only and a
table-level grant covers columns added later, as `012_watchlist_signal.sql`
records — so no new policy. A row with `page_margin` null renders at the
`0.68in` default, which is every row written before this. That asymmetry is
stated here because it is invisible otherwise: a page margin that looks right in
the draft and silently reverts in the archive would be found only by comparing
two screens.

**Sanitizer change — revision 1 invented the problem. [r1 defect]**
`sanitize-html`'s `allowedStyles` DOES understand custom properties: it parses
declarations with postcss and matches on the declaration `prop`, which for a
custom property is `--rail`. Verified against the installed package —
`--rail:120px` survives, `--rail:1px } .rsm { background:url(…)` is rejected,
`--rail:url(http://evil/x)` is rejected. The bespoke `transformTags` re-parser
revision 1 mandated is unnecessary and strictly riskier.

So the change is additive config:

```
allowedAttributes: { "*": ["class"], a: ["href"], section: ["style"], div: ["style"] }
allowedStyles:     { section: {...unchanged}, div: { "--rail": [...], ... } }
```

**The `allowedStyles.div` entry is not optional and is the whole safety of it.**
`filterCss` does `allowedStyles[selector] || allowedStyles['*']` and, when
neither exists, returns the declarations UNFILTERED — so adding `div` to
`allowedAttributes` without a matching `allowedStyles.div` opens arbitrary
inline CSS on every div the renderer emits plus every div `contentEditable`
produces. A test asserts exactly that pairing, because the failure is silent.
`allowedStyles` is keyed by TAG, not class, so this permits allowlisted custom
properties on any div; that is accepted deliberately — the value allowlist is
what makes it safe, and class-scoped filtering is not expressible in the option
surface.

The value tables are the SAME module the write path uses, so a value the agent
cannot set is a value that cannot be saved.

**Fixture.** `lib/__fixtures__/resume-sanitized.html` pins the shipped record's
render through the sanitizer and is touched by this change. CLAUDE.md's rule
applies: the diff is read in the same commit, and a commit touching only
fixtures is a red flag. **[r1 defect: omitted]**

**`DESIGN_VERSION`.** `lib/resume-download.ts:24` stamps every saved row and is
bumped by hand when `tokens/` changes, because a saved row's appearance comes
from those files at view time. A per-document override is a fourth thing
affecting appearance and is NOT covered by that stamp — but it does not need to
be: the override is frozen INTO the row's HTML, so it is immune to a token-file
change by construction. The saved card labels a row carrying overrides as
"includes document design changes", so a row that looks unlike the current
design is explained rather than mysterious.

### The model call

**`complete({ system, prompt, jsonSchema })`, not `callStructured`. [r1 defect]**
`callStructured` (`lib/model-call.ts:134-139`) forwards to `complete()` WITHOUT a
schema despite its name; the constrained `emit`-tool path is reached only when
`CompleteOpts.jsonSchema` is set (`model-call.ts:143-160` →
`lib/providers/anthropic.ts:82-88`). Following revision 1 literally would have
produced free-form prose through `parseJson` — the unconstrained decoding this
spec spends a paragraph rejecting. `jsonSchema` is already on the provider
interface (`lib/providers/types.ts:57`), so the model-agnostic design is
untouched and no adapter changes.

Response schema:

```
{ reply: string, operations: [ { op: string, ...fields } ] }
```

**A flat object with an `op` discriminator, not a 13-branch `anyOf`.** The
schema is passed straight through as the tool's `input_schema`
(`anthropic.ts:85`); a large nested union there is workable but has real
behavioural cost, and the server validates the union regardless. The schema
constrains shape; the server decides legality.

**`maxTokens` and truncation. [r1 defect: omitted]** The forced-tool path returns
`JSON.stringify(toolBlock.input)` (`anthropic.ts:96-104`), so a response cut off
at `max_tokens` yields a PARTIAL tool input that parses as a valid-looking
object with operations missing. `maxTokens` is set explicitly (2000) and
`Completion.stopReason` (`lib/providers/types.ts:34-43`) is checked: a truncated
turn is REFUSED with a message asking the user to narrow the request, never
partially applied. This is the same hazard `lib/prose-salvage.ts` exists for on
the search path.

**System prompt** carries: the theme vocabulary; the effective record's role and
bullet ids with their themes and one-line text (ids and text, not the full
record); the current selection; the current overrides; the RENDERED coverage
report; the posting's requirements and nice-to-haves; and the operation
catalogue. It states the invariant in this repo's terms — reorder and retune
freely, propose rather than invent a bullet, never write CSS rules.

**Pinned by a fixture**, the way `lib/fit-prompt.ts` and
`lib/hiring-signal-prompt.ts` are, so a change to what the agent is told shows up
as a diff in rendered text rather than only in the builder.

**Billing.** `withBudget({ action: "resume-chat", estimateCents: 3, … })`.
`lib/metered.ts:83-100` reserves ONCE per call and nested calls short-circuit at
:98 — one turn is one call is one reservation, so this is not the per-batch
hazard `app/actions/enrich.ts` documents. `estimateCents` is 3 rather than
`tailor-resume`'s 1 because the turn carries the record index and the transcript.

### Persistence

`db/migrations/019_resume_chats.sql`. **Revision 1 gave the CREATE TABLE and then
prose saying "`force row level security`, same as 015" — which is two of the six
statements 015 actually runs, and omits the two that matter. [r1 defect]**
`force` without `enable` only sets `forcerowsecurity` and is inert until
`rowsecurity` is true, so as written the table would have shipped with NO row
security. Had it included `enable` but still omitted the policy, `force` plus
zero policies denies everything. Both failures are silent. The migration is 015
(`db/migrations/015_tailored_resumes.sql:20-33`) in full:

```sql
create table if not exists resume_chats (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references users(id) on delete cascade,
  job_id     uuid not null references jobs(id) on delete cascade,
  messages   jsonb not null default '[]',
  updated_at timestamptz not null default now(),
  unique (tenant_id, job_id)
);

create index if not exists resume_chats_tenant_idx on resume_chats (tenant_id);
alter table resume_chats enable row level security;
alter table resume_chats force row level security;
drop policy if exists tenant_isolation on resume_chats;
create policy tenant_isolation on resume_chats
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
grant select, insert, update, delete on resume_chats to app_rw;
```

`tenant_id` is declared INLINE, invisible to `lib/supabase.test.ts`'s ALTER TABLE
retrofit regex, so `"resume_chats"` is added to `TENANT_TABLES`
(`lib/supabase.ts:127-151`) by hand — as 015, 016 and 018 each record. Every
access goes through the query builder's `forTenant`; if any raw SQL is added
later it must pass the tenant id as `rawQuery`'s third argument, since
`runAsTenant` sets an AsyncLocalStorage value and `app_rw` is `nobypassrls`.

The thread is per (tenant, job) and survives reload. It is NOT covered by the
60-day résumé retention: that window is for frozen documents in `saved_resumes`,
and this is working state on the draft, which already never expires
(`db/migrations/015`). It dies with the job row via the cascade.

### Server action contract

**[r1 defect: omitted entirely.]** The new action lives in `app/actions/` and
must satisfy the two standing invariants CLAUDE.md names:

- It calls `requireResumeAdmin()` (`lib/require-resume-admin.ts`) first, as
  `app/actions/resume.ts:136,184,220` do. That helper stays in `lib/` — exporting
  it from a `"use server"` file would publish it as an RPC endpoint.
- It refuses a session-less call, and takes its place in
  `app/actions/auth-required.test.ts`, which imports every file in
  `app/actions/` and calls every export.

Errors follow the `{ error?: string }` contract this repo has a dedicated skill
for (`.claude/skills/swallowed-string-errors`): database failures through
`describeWriteFailure`, detection by PRESENCE (`!== undefined`) and never
truthiness, since `pg` rejects with an empty message when every address of a
dual-stack host refuses. A model or parsing failure substitutes its own sentence
at the catch instead, because `UNDESCRIBED_DB_ERROR` names the database and
would be false there. `TailorPanel.tsx:63` and `app/actions/resume.ts:175` are
the worked examples.

### The panel

App chrome under `components/resume/`, not document: Tailwind, the existing
`ink`/`slate`/`canvas` palette, `print:hidden`. It does not use the résumé design
tokens — those are scoped to `.rsm` and describe a printed page, and borrowing
them for a sidebar is how the three deliberate divergences in `tokens/` get
"tidied" back to the vendored source by someone assuming they are shared.
Under `components/` also matters mechanically: `tailwind.config.ts` scans
`./app/**` and `./components/**` only, so an arbitrary-value class defined in
`lib/` is never generated.

Each assistant turn renders its prose and, beneath it, the operations applied as
a plain list — "set themes: systems, data, ops", "swapped a bullet on Principal
GTM Expert" — or, for a rejected turn, the reason nothing was applied.

**A chat turn must not silently discard manual edits. [r1 defect]** Revision 1
claimed `dirty` covered this. It does not: `dirty`'s only consumers are the
`beforeunload` handler and the Regenerate confirm (`TailorPanel.tsx:45-53,104-106`),
neither of which fires for a chat turn — while
`ResumeDocument.tsx:68-73` states that re-setting `dangerouslySetInnerHTML`
discards unsaved edits, which is exactly what applying a turn does. Setting
`dirty = true` after wiping them actively misleads.

So: a turn that would change the document checks `dirty` FIRST and confirms
("You have unsaved edits to this document. Apply this change and discard them?"),
the same shape as the Regenerate confirm. A turn that changes nothing — a
question — never prompts. After applying, `dirty` is set, so Save and
`beforeunload` behave as they do for a manual edit.

**Regenerate discards overrides.** It re-derives themes and writes fresh
`content`, which is what regenerate has always meant. The confirm text must say
so: the current wording (`TailorPanel.tsx:104-106`) is true but will badly
under-state it once a user has spent ten turns tuning a document.

---

## Storage summary

`tailored_resumes.content` — already `jsonb`, already replaced wholesale by
Regenerate, so no migration:

```
{ themes, selection,
  overrides: { selection?: {...}, text?: {...}, design?: {...}, pageMargin?: string } }
```

`getTailoredResume` currently destructures exactly `content.themes` and
`content.selection` (`app/actions/resume.ts:202-203`) and must return
`overrides` too, plus a freshly computed coverage report. A row written before
this change has no `overrides` key; absent reads as empty, never as an error.

Per-tenant career overlay — `app_settings` under `CAREER_OVERLAY_KEY`.
Chat thread — `resume_chats`.

## Testing

Pure logic, per the repo gate (`npm run build && npm test`; model calls verified
by hand):

- **Ordering** — the mutation test in §1, which must fail against both the
  current sort and revision 1's.
- **Coverage** — gaps, thin/strong, strength, and rendered-vs-full divergence.
- **`sanitizeBulletText`** — the hostile table in §3, including that a real
  `<strong>` survives byte-identically.
- **Operation validation** — bullet id outside the role's pool, design token
  outside the allowlist, malformed length, text target not in the current
  selection, theme id outside the vocabulary. Each rejected with a reason, and
  the whole turn atomic: assert nothing was applied.
- **Value parser** — shared by write path and sanitizer; accepted and rejected
  tables including `--rail:1px } .rsm { background:url(…)`.
- **Sanitizer config pairing** — a `style` on a div carrying a non-allowlisted
  property is stripped. This is the test that catches an
  `allowedAttributes.div` added without `allowedStyles.div`.
- **Sanitizer round-trip** — a captured document with custom properties on
  `.rsm` survives; the existing `.rsm`-root check still fires; the
  `resume-sanitized.html` fixture is regenerated with its diff read.
- **`effectiveCareer`** — overlay bullet scores and renders; text override
  applies by id; an overlay for an unknown role id is dropped WITH a warning;
  the returned record is fresh, never a reference into the imported JSON (the
  `resolveProfile` precedent — a caller must not corrupt the module-level record
  for the process's life).
- **Truncation** — a `stopReason` of max-tokens refuses the turn rather than
  applying a partial operation list.
- **Prompt builder** — fixture-pinned rendered system prompt.

Verified by hand on the deployed build: that the model returns usable
operations, and that a design token change survives Save and re-open.

## Out of scope

- Editing `content/resume.json` at runtime. Overlay only; folding back is a repo
  change.
- CSS rules, new selectors, layout restructuring. `request_rule_change` only.
- Chat on the SAVED résumé screen. Saved rows are frozen HTML that is never
  re-rendered; a chat there would have nothing to operate on.
- Streaming responses. One request, one reply, as every other model call here.
