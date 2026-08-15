# Role-First Discovery — Live Verification

Branch `worktree-role-first`, 11 commits off `56a7c3c`. Build clean, 136/136 tests.

**Nothing on this branch has been executed against a real database, the Anthropic
API, a browser, or Railway.** No subagent had credentials, so every live check was
reported SKIPPED rather than faked. The pure logic underneath has 136 passing
tests; the wiring between it and Postgres has none.

Never executed even once: all of `app/actions/role-search.ts`, all of
`components/RoleSearchPanel.tsx`, the `server_tool_use` logging block and the new
`max_uses` parameter in `lib/anthropic.ts`, the `6-18m` prompt path in
`discoverStartups`, the `role_searches` DDL and both its reads and its write, and
the rewritten `resolveExistingCompany` in `app/actions/watchlist.ts` — which now
runs on *every* watchlist write, including the crawler's.

Run these in order. The ordering is by which failures are silent, not by convenience.

## Before the browser

**1. Apply the schema.**

```bash
DATABASE_URL=<public proxy URL> node db/apply-schema.mjs
```

Confirm `role_searches` appears in the printed table list. The internal Railway
URL will not resolve from a laptop — use the public proxy URL. Everything below
depends on this, and skipping it produces a loud banner on page load but a
*silent* failure on the search itself.

**2. Check for pre-existing identity collisions** before the new normalizer starts
resolving against them:

```sql
select lower(regexp_replace(company,'\s+',' ','g')) k, count(*), array_agg(company)
from watchlist group by 1 having count(*) > 1;
```

Run the same over `jobs`. Any row returned means duplicate company identities are
already in your data — the new normalization will start merging them, which is the
intent, but you should know what it is merging.

## In the browser (`npm run dev`)

**3. ~~Company mode still works, and still defaults to `7d`.~~ SUPERSEDED 2026-08-14 —
this check can no longer be run as written.**
The plan text says the default becomes `6–18 mo`; that is stale — you chose to keep
`7d`. ~~Run a `6–18 mo` search against a cold cache and confirm the window-filter chip
row appears with two or more real ranges.~~

There is no longer a default at all, and `6–18 mo` is no longer fetchable. Company mode
now shows two fixed buttons — `Discover 7 days` and `Discover 30 days` — and the chip row
is purely a filter over already-loaded results (`FETCHABLE_RANGES` vs `PINNED_CHIPS` in
`lib/discovery-windows.ts`, whose invariants are pinned by tests). `6m` and `6-18m` are
legacy: their cached results stay visible and filterable, but no control can fetch them.

The equivalent check, verified live at `dcc8fbe`: both buttons render, and selecting a
chip filters the list without changing either button's label.

**4. Role mode → `Titles` → Search roles — and watch the server log, not the screen.**
Two lines matter:

```
findRolesByCriteria(title): sending 15 of 39 queries — …
callWithWebSearch: issued N searches — …
```

`max_uses` is now set to 15, so `N` should not exceed it. **If it does, the cap is
not being enforced by the API and you are paying for searches nothing bounds.**
This is the single highest-value observation of the pass, and it exists nowhere in
the UI.

**5. Reload the page.** Results reappear with a "Last searched …" timestamp and
**no** new `issued N searches` line. A new line means the cache write failed.
*Silent — this is the check that catches it.*

**6. Toggle to `GTM stack`, then back to `Titles`.** Different result set, zero
billing on either toggle.

**7. Click Track on a company.** Expect ~9s–2min; the button says so. Confirm the
row lands on `/watchlist`. A badge reading "Tracking ✓ — needs attention: …" is
correct behavior, not a bug: the row exists but the crawl found no careers URL.
Set one on the Watchlist page.

**8. `/roles`** — roles from step 4 present, `source = Role Search`, with fit scores.
Then **re-run the same role search and confirm no duplicate rows appear.** This
exercises the `ingestRoles` dedupe path, including the new SQL normalizer.

**9. Un-watch round-trip.** In company mode, un-watch a company, then reload. If it
comes back starred, the write no-opped and the UI lied — the error path now exists
and is surfaced, so this should be visible rather than silent.

## Deploy last

```bash
railway up --service web --detach
```

Re-run steps 4-5 against the deployed service. The schema must be applied to the
**Railway** Postgres, not just whatever you pointed step 1 at. Confirm
`DATABASE_URL` and `ANTHROPIC_API_KEY` are set on the `web` service.

## Known-and-accepted, carried into merge

- `app/actions/discover.ts`'s cross-window dedupe key uses `toLowerCase().trim()`
  without whitespace collapse — a fourth normalization path in spirit. Cosmetic:
  worst case one company lists twice across windows.
- Three of the 13 `TARGET_TITLES` are not realistically phrase-searchable
  (`"AI-Ops / automation practitioner-builder"`, `"Director of GTM/AI Operations"`).
  Roughly 2-3 of the 15 capped queries are spent on them. Revisit once the
  `issued N searches` log shows real yield per query.
- `getWatchedCompanyKeys` discards its own query error and returns an empty set, so
  a DB read failure renders every company as untracked. Pre-existing; now also on
  the role-search path.
- Switching family while a cache read is erroring leaves the previous family's roles
  on screen under the new label, with the error banner above them.
- The `NORMALIZED_COMPANY_SQL` tests are string-content guards. They cannot catch a
  semantically wrong but plausible expression — only a DB harness closes that.
- Discover's toggles lack `aria-pressed`/`role="tab"`, matching the pre-existing
  date-range buttons. Worth one a11y pass over all of them together.
- `getDiscoveredStartups()` has had zero callers since `f008815`.
