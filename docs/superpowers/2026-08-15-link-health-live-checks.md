# Link health — live checks and follow-ups

**DEPLOYED 2026-08-15.** `main` at `d4fcd55`, 662 tests / 38 files, build green.
Every claim below was run against production — the live `/roles` page and the
production database — not inferred from a green deploy status. Where something
was NOT verified live, it says so.

No plan or spec document: this started as a bug report ("this brings me to a
dead link on ziprecruiter") and the design was settled in conversation.

## What the report actually was

Two independent defects wearing one coat, and the second one was invisible
until measured.

1. **Links were second-hand.** `roleExtractionSchema()` asked for
   `job_url (string or empty)` with no preference, so the model returned
   whatever the search engine ranked. **29 of 61 rows** pointed at
   ZipRecruiter, Built In, Lensa, Glassdoor, Teal, TheLadders, EdTech or
   Himalayas.
2. **Nothing ever re-checked a link.** `checkJobUrl` ran once at ingest.
   Two rows (AgentSync, Workiva) were returning a hard 404 while displayed as
   open. Aggregator links rot worse: a reseller answers **403** to anything
   that looks like a bot, so an expired copy passes the liveness check as
   "unknown" and lands as `New` forever.

The reported symptom was the link. The cause was that the *job* had closed
weeks earlier — Halcyon's real Greenhouse board carries 10 open roles and not
that one.

## The measurements that changed the design

Recorded because each one killed an approach that sounded right in the abstract.

| Approach | Rows it would fix (of 29) | Outcome |
|---|---|---|
| Fall back to the company's `careers_url` | **1** | Killed. Only one aggregator row had a `careers_url` at all. |
| Scrape the aggregator page for the employer link | 8 | Works for Built In only; ZipRecruiter and 6 other hosts 403. |
| Probe ATS URLs by guessed slug | 4 | Weak, and nearly shipped a false 16/16 — see below. |
| Public ATS board APIs | ~15 | Adopted, as a narrow exception. |

**The careers_url fallback was the first recommendation and it was wrong.**
It was the cheapest option and needed no new data, which is exactly why it
should have been measured before being recommended rather than after.

## The probe that lied

Probing `https://jobs.ashbyhq.com/<slug>` and counting HTTP 200 as "this
company has a board" reported **16/16 companies resolved**. The number was too
good, which was the only reason it got checked:

```
curl -o /dev/null -w "%{http_code}" https://jobs.ashbyhq.com/zzznotarealcompany9142
200
```

Ashby's board is a client-rendered SPA — the server returns 200 for any path.
Greenhouse and Lever return an honest 404 for the same nonsense slug. True rate
after discarding Ashby's HTML: **4/16**. Twelve false positives.

Ashby's *API* is honest, which is why Ashby is in `BOARD_VENDORS` anyway. Two
other vendors failed the same control test and are excluded: SmartRecruiters'
postings endpoint returns 200 with an empty envelope for companies that do not
exist, and Workday needs a per-tenant site name that cannot be derived from a
company name.

**A vendor may not be added to `BOARD_VENDORS` without running that control
test.** The rule is in `CLAUDE.md` and in a comment above the list. The general
lesson became the global skill `verifying-existence-probes`.

### One correction to an earlier claim in this repo

`CLAUDE.md` and two code comments briefly said Lever answers a missing board
with **HTTP 200** and `{"ok":false}`, labelled "verified live". It does not —
it returns **404** with that body, confirmed four times. The original evidence
was a `curl | head -c 300` that printed the error body; curl prints the body
whatever the status, and the status was never read. An inference got written
down as an observation. Corrected in `d4fcd55`. The two-gate design (status
*and* response shape) was never wrong, only its justification: the honest
example is SmartRecruiters.

## The empty-board trap

Found while probing Breezy, and it would have been a data-loss bug.

**Asseti keeps an empty Breezy board while actively hiring eight roles through
Workable.** The rule at the time was "first board found wins" plus "an empty
board means the role is absent" — which would have closed eight live roles on
the strength of an abandoned board.

An empty board is now its own outcome (`empty`): the search continues past it,
and an empty board is reported only if nothing better exists anywhere, degraded
to `ambiguous` so it can never close anything alone. A board with even **one**
posting stays trustworthy — which is what keeps the Invoca case closable, since
its board carried a lone "join our talent community" entry.

## What is allowed to close a role

Three-valued on purpose, and the middle value is the whole safety argument.

- `posting` — one clear title match. Relink to it.
- `absent` — the board has postings and none resembles this title. **The only
  outcome that may close a role.**
- `ambiguous` — several postings could be it, or the board is empty. Reported,
  never acted on.

A board listing both "GTM Engineer" and "GTM Engineering Manager" cannot say
which was meant. Closing a live role over a wording difference would be worse
than the bug being fixed.

## Verified in production

- **Schema applied before deploy.** `jobs.source_url` confirmed present (`text`)
  by querying `information_schema` — the code writes that column, so a deploy
  ahead of the migration would have failed every insert.
- **First repair run:** checked 30 open roles, relinked 2 to the employer's own
  posting, reported 8 no longer listed on their employer's board. Confirmed
  against the database, not the screen: aggregator rows 29 → 27, direct ATS
  25 → 26, company-domain 7 → 8.
- **The 8 were closed** through the bulk control and verified stored as
  `Posting Closed` (Atlan, Candid Health, Halcyon, Instructure, Invoca, Nebius,
  Runway, Verint).
- **Re-run is idempotent** — a second pass relinked nothing and closed nothing.
- **No false positives.** A later run over the remaining 22 open roles closed
  **zero**. Counts held at 22 New / 39 Out.
- **Bulk status control**: exercised with an idempotent write (setting already
  `Posting Closed` rows to `Posting Closed`) so the write path was proven
  without changing pipeline state. Selection-vs-filter intersection verified
  live: 10 ticked, search narrowed to 2, count followed; clearing the search
  restored 10.
- **Age pills and `Found` sort** verified on the live page in both directions.

## NOT verified live

- **The cron path.** `repairJobLinks` is wired into `app/api/cron/crawl` but has
  only ever been run from the button. `?dry=1` deliberately skips it (it
  writes), so exercising it means a real run that also spends Claude credits on
  a crawl. **Check the next daily run's log line** — it now carries
  `links=… relinked=… closed=… unclear=…`.
- **Ingest-time resolution.** The code path that stops a dead role at the door
  is unit-tested and type-checked but has not yet run against a live discovery,
  because no search was run after deploying it. First Discover or crawl will
  exercise it.
- **Workable and Breezy** were validated by direct probe (Asseti's real board
  has 8 roles, none matching; Actionstep's has 7, none matching) but no repair
  pass has run since they were added, so no role has yet been closed through
  them.

## Known unresolvable — 4 roles

Not bugs; each fails for a structural reason worth remembering.

| Role | Why |
|---|---|
| Groq · Head of Product Marketing | Not on Greenhouse, Ashby or Lever under any slug variant tried |
| CrowdStrike × 2 | Workday — per-tenant site name is not derivable from a company name |
| "AI SaaS (via Built In Colorado — company not disclosed in snippet)" | The company name was never captured at discovery, so nothing can look it up |

That last row is a discovery-prompt problem, not a lookup one: a role whose
company field is a placeholder is unlookupable, unverifiable, and probably not
actionable. A guard rejecting them was considered and deliberately deferred
until there is evidence of how often it happens.

## Follow-ups

- 7 open roles still sit on hosts we cannot see past (ZipRecruiter ×2, Built In
  ×2, Built In Colorado, Teal, TheLadders). Nothing short of a per-role Claude
  call reaches them, and most are probably closed anyway — the re-check will
  catch any that start returning 404.
- `repairJobLinks` reads every job row on each run. Fine at 61 rows; it will
  want a `where` clause long before it is a problem.
