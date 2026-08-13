# Search Settings — Design

**Status:** approved in brainstorming, 2026-08-13. Not yet planned or built.

## Problem

The app lets you change *who* it looks at — companies are addable from three
places — but not *what it looks for* or *how it judges what it finds*. Target
titles, search locations, GTM stack terms, the location rule, and the
fit-scoring brain are all hardcoded module constants in `lib/search-criteria.ts`
and `app/actions/parse-role.ts`. Changing any of them means editing code and
redeploying.

Compensation is a related gap: `salary_range` is already extracted and stored
for every role, and used for nothing. It is displayed but never filtered on, and
`scoreFit` never receives it — so every fit score in the table today was
computed with zero compensation input.

## Scope

Six things become editable through a new `/settings` page:

| Setting | Type | Today's home |
|---|---|---|
| Target titles | list (13) | `TARGET_TITLES` |
| Locations | list (3) | `LOCATION_TERMS` |
| GTM stack terms | list (8) | `GTM_STACK_TERMS` |
| Location rule | prose | `LOCATION_RULE` |
| Fit brain | prose | `CANDIDATE_BACKGROUND` in `app/actions/parse-role.ts` |
| Minimum base compensation | number, optional | does not exist |

Plus a per-run search ceiling (optional, default off) and a live cost estimate.

**Out of scope**, decided during brainstorming: per-title feature toggles;
separate title lists per feature; a rubric version column on `jobs`; scheduled
re-scoring; settings import/export; changing the shipped default locations.

## Decisions and their reasons

### One shared title list

`TARGET_TITLES` drives three things at once — By Role query construction, the
weekly crawler's extraction prompt (`lib/crawler.ts`), and the per-company Find
roles button (`app/actions/roles.ts`). They stay yoked together: one list, one
edit, all three change.

The consequence to state plainly in the UI: **editing titles changes what the
crawler hunts for on every tracked company at the next cron run.** That is not
obvious from a page that looks like it configures search.

### Pure functions take criteria as an argument

The central architectural decision. Today's constants are imported at module
load by four files (`app/actions/discover.ts`, `app/actions/role-search.ts`,
`app/actions/roles.ts`, `lib/crawler.ts`) and asserted against directly by 18
tests.

- Constants stay in `lib/search-criteria.ts`, renamed `DEFAULT_TARGET_TITLES`,
  `DEFAULT_LOCATION_TERMS`, `DEFAULT_GTM_STACK_TERMS`, `DEFAULT_LOCATION_RULE`,
  `DEFAULT_CANDIDATE_BACKGROUND`. They serve as both the seed for a fresh
  install and the runtime fallback.
- `titleQueries`, `stackQueries`, and `titleListForPrompt` take a criteria
  object as a parameter instead of reading module state. They stay pure; their
  tests stay pure and need no database.
- One new async `loadCriteria()` reads `app_settings`, merges over the defaults,
  and returns a criteria object.

The alternative — reading the database from inside `lib/search-criteria.ts` —
is faster to write and worse to live with: it makes the pure query layer async,
untestable without a database, and impossible to reason about in isolation.

**The fallback is load-bearing.** If the settings read fails and the crawler
receives an empty title list, it finds nothing on every tracked company and
reports "no roles" forever — a silent failure of exactly the kind this repo has
been bitten by twice. Falling back to shipped defaults degrades to *last known
good behavior* instead.

### Storage

```sql
create table if not exists app_settings (
  key        text primary key,
  value      jsonb not null,
  updated_at timestamptz default now()
);
```

One row per setting. A seventh editable setting later needs no migration.
"Reset to defaults" is `delete from app_settings where key = $1` — the fallback
architecture makes it nearly free, so it ships.

### Cost visibility

A live estimate under the title and location lists, updating as you edit:

> 13 titles × 3 locations = 39 queries · ~$1.13 per By Role run

Presented as approximate. It is built from ~$0.01 per web search, search results
entering context at $3/MTok, and up to 25 fit-scoring calls. Its real job is
making the `Denver` / `Colorado` overlap visible — those two terms cover nearly
the same ground and account for a third of the query grid — without this design
pre-emptively deciding to collapse them.

**The ceiling is expressed in searches, not dollars**, because searches are what
`max_uses` actually enforces; a dollar budget would be that same number with a
lossy conversion in front of it. Default off.

**This changes what `MAX_QUERIES_PER_SEARCH` means.** Today it is 15 and does
double duty as a runaway guard and a coverage ration. Measured cost of an
uncapped title run is ~$1.13 against ~$0.55 capped — the cap rations coverage on
the user's most central titles to save about sixty cents, which is the wrong
trade for a job search. New behavior:

- Ceiling **off** (default): send every query; set `max_uses` to 2× the query
  count as a pure runaway rail that never binds in normal use.
- Ceiling **on**: `pickQueries` down to the ceiling; `max_uses` equals it.

The existing test pinning the constant at 15 changes meaning and must be
rewritten, not deleted.

### Compensation

`salary_range` is already captured. What is missing is parsing it and using it.

**Parse at read time, not at ingest.** `lib/salary.ts` exports
`parseSalaryRange(raw)`. No new columns, no migration, no backfill: the 44
existing rows already carry raw strings, so a floor applies retroactively the
moment it is set, and improving the parser later fixes historical rows for free
rather than leaving stale derived numbers behind. Filtering happens in
TypeScript; that stops being viable somewhere north of a few thousand rows, and
that is the point to revisit it.

**Parsing rules, derived from the real data.** 21 of 44 rows have a range; 5 of
those 21 are not the simple `$X - $Y` shape:

```
$280,000 - $325,000 (base); $305,000 - $365,000 OTE
$138,945 - $165,000 (Denver); $168,420 - $200,000 (SF/NYC)
$165,000 - $175,000 base + annual bonus
$300,000 - $340,000 OTE
$150,000
```

- **Prefer an explicitly-labeled base range.** A naive "highest max" rule picks
  $365k OTE over $325k base on the first row. In GTM roles OTE bundles
  commission and overstates base by 20–40%, so a minimum-*base* floor built on
  that rule silently passes roles whose base is well under it.
- **Fall back to the first range** when nothing is labeled (covers the
  multi-location row, where the first range is the Denver one).
- **Handle a bare single value** (`$150,000`). Treating it as unparseable would
  tag a good role as "no range listed".
- **An OTE-only figure is not base.** Surface it as OTE; do not compare it to a
  base floor.
- Return enough structure to distinguish *empty input* from *text we could not
  parse*. Those look identical downstream today, and the second is a parser bug
  that would otherwise never surface. Log the unparseable case.

**Test fixtures are the five real strings above plus the simple shape.** A
parser tested only against `$150,000 - $200,000` passes while failing a quarter
of the actual data.

**Two independent controls on `/roles`:**

- **Meets floor** — hides roles whose parsed base max is below the floor
- **No range listed** — a tag, with its own toggle to hide

Separate because "pays too little" and "didn't tell me" are different facts, and
48% of the table is the second one. Collapsing them would hide half the roles
behind one click.

**Never filter at ingest.** A blank range does not reliably mean "undisclosed" —
Colorado's pay-transparency law requires ranges on CO-eligible postings, so a
blank often means the model did not find one. Dropping on a blank means dropping
on extraction failure, invisibly and irreversibly.

**`scoreFit` gains compensation.** It starts receiving `salary_range` (it
currently does not), and the floor becomes a line in the fit brain. A below-floor
role then scores low rather than disappearing — the behavior wanted for a role
that is otherwise perfect.

### Re-scoring

Editing the fit brain or the floor makes existing scores stale. Re-scoring all
44 rows costs about $0.33, so cost is not the constraint; surprise is.

On save, a dismissible prompt:

> Saved. 41 roles carry scores from before this edit. Rescore them for about
> $0.33? [Rescore] [Not now]

Re-offered whenever Settings is opened while stale scores exist, so declining
once does not bury it. No version column: the count of scored jobs is enough to
produce the message, and a version column would only be needed to *filter*
`/roles` by rubric, which was explicitly out of scope.

**Shipping this feature makes all existing scores stale on day one**, because
`scoreFit` gains salary as an input — not on the first edit. The same prompt
fires once after deploy.

### Cache handling on save

Roles live in `jobs` and are never touched by this feature. `role_searches` and
`discovered_roles` hold cached *API responses*; every role in them was already
written to `jobs` by `ingestRoles` at search time, so clearing them discards no
found role.

| Edited | Clears | Why |
|---|---|---|
| Titles, locations | `role_searches`, `discovered_roles` | Feed query construction and the Find-roles prompt |
| GTM stack terms | `role_searches` (stack family) | Stack queries only |
| Location rule | `role_searches`, `discovered_roles` | Shared by both search prompts |
| Fit brain, pay floor | nothing | Triggers the rescore prompt instead |

`discovered_startups` is deliberately left alone: funding results barely depend
on criteria (the location rule is only a soft ranking hint there) and they are
the most expensive cache to regenerate.

The crawler needs no cache handling — it reads criteria at crawl time, so the
next cron cycle picks up new titles automatically.

### Removing a title must not auto-close live roles

**The one place a settings edit can change existing job rows.** Found during
design review; not obvious from the settings surface.

`closeStalePostings` (`lib/crawler.ts`) marks a role `Posting Closed` when it is
absent from two consecutive trustworthy crawl runs. The crawler only extracts
roles matching the current title list. So removing a title means the crawler
stops looking for it, it is absent from the next two runs, and it closes — as
though the company took the posting down, when in fact it is still listed and we
stopped looking.

Scope: `source = 'Crawl'` and `status = 'New'` only. Roles from Role Search and
Discover are unaffected, as is anything the user has actioned. One row qualifies
today across 5 tracked companies; the exposure grows directly with tracking.
Reversible — it is a status flip — but silent, with nothing attributing the
close to a settings edit.

**Fix: a criteria change resets the closure debounce.** The first crawl after an
edit counts as a first crawl, so closure requires two clean runs *under the
current criteria* before absence is trusted again. This reuses the existing
`runs.length < 2 → close nothing` guard rather than adding a second mechanism,
and it follows the principle already encoded in `titlesToClose`: an `error` or
`needs_url` run never closes a live job because a failure is not evidence the
job is gone. Removing a title is the same class of non-evidence.

**Rejected alternative:** filtering closure candidates to titles still matching
the criteria. Real titles are chaotic ("Head of Revenue Operations, Americas"),
the crawler prompt explicitly accepts "close variants", and exact matching would
under-protect precisely the roles most worth protecting.

**Also warn at save time**, naming the count: "N tracked roles match titles you
are removing. They stay on /roles, and the crawler will stop monitoring them."

## Validation

- **Empty title list or empty location list is blocked at save**, with an
  explanation. An empty list makes the crawler silently find nothing on every
  tracked company — a save that produces silence rather than an error.
- **A double-quote character in a title is rejected.** `titleQueries` builds
  `"${title}" ${place} job opening`; an embedded quote produces a malformed
  search that fails invisibly.
- Whitespace-only and duplicate entries are trimmed and de-duplicated on save.
- The fit brain is sent on every `scoreFit` call, so its length multiplies
  across a re-score. A soft warning above 4,000 characters (today's is ~1,800),
  not a hard block.

## UI

New `/settings` route, linked from `Nav.tsx`. Five sections plus compensation,
**each saving independently** — a typo fix in the location rule should not
re-save the fit brain, and independent saves are what let the rescore prompt
fire only when a scoring input actually changed.

## Error handling

Per this project's explicit-over-silent standard:

- A failed settings read falls back to defaults and logs loudly. It does not
  throw — the crawler must keep working.
- A failed save surfaces the error and leaves the form populated.
- An unparseable salary string is logged, not silently treated as absent.
- Criteria load **once per cron batch**, not once per company, so a mid-batch
  save cannot split one run across two title lists.

## Testing

- `lib/salary.test.ts` — the five real awkward strings plus the simple shape,
  the empty case, and the unparseable case. Every test must fail against a
  broken parser.
- `lib/search-criteria.test.ts` — all 18 existing tests need rewriting to pass
  criteria explicitly rather than assert against module constants. The test
  pinning `MAX_QUERIES_PER_SEARCH` changes meaning, per the ceiling decision.
- Settings validation logic (empty, quotes, duplicates) as pure functions in
  `lib/`, tested there. Server actions and React components are not unit-tested
  in this repo.
- Estimate arithmetic as a pure function.

## Known limitations

- The cost estimate is approximate; tokens per search result vary.
- Read-time salary parsing does not scale past a few thousand rows.
- No audit trail of settings changes.
- `insights.ts` does not consume criteria and is unaffected — confirmed.
