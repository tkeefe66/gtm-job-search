# Daily Job Scan — Configuration

Single source of truth for all search criteria. Edit this file to change
what the scan looks for; the pipeline in SKILL.md never changes.

## Candidate profile (for scoring context)

Chad Holdorf — VP Product / CPO profile. Background: Demandbase, Salesforce
(Hyperforce / private-to-public cloud), John Deere; deep in AI/agentic
products, B2B SaaS platforms, developer/infrastructure products, 0-to-1 at
scale. Open to senior IC (Staff+/Principal) roles at elite AI companies.
Comp target: ~$350K+ total.

## Shared filters (apply to every source)

- **Titles / seniority**: Staff PM and above — Staff/Sr. Staff Product
  Manager, Principal PM, Group PM / Sr. Group PM, Lead PM / Product Lead,
  Director / Sr. Director of Product, VP of Product, Head of Product,
  GM (product-owning), CPO. Product management roles only — no PMM-only,
  no engineering management.
- **Location**: SF Bay Area (San Francisco, South SF, Palo Alto, Menlo
  Park, Mountain View, Sunnyvale, Santa Clara, San Jose, Oakland,
  Berkeley, Redwood City, Foster City, San Mateo, Pleasanton, Los Gatos)
  OR Remote-US. Exclude roles that are exclusively in another city
  (NYC-only, Seattle-only, etc.). A multi-city listing qualifies if any
  listed office is Bay Area or it is remote-eligible in the US.
- **Recency**: posted (or first seen) within the last 7 days. The dedup
  step drops anything already in the tracker, so overlap across daily runs
  is expected and harmless.
- **Domain priority**: AI/agentic products, developer platforms,
  infrastructure, B2B SaaS, payments/fintech. Don't hard-exclude other
  domains — score them lower instead.

## Source 1 — Target Company Scan

Check the careers pages / job boards (Greenhouse, Lever, Ashby, or native)
of these companies for new openings matching the shared filters:

Anthropic, OpenAI, Stripe, Databricks, Weights & Biases, CoreWeave,
Crusoe, Lambda, Nebius, Supabase, GitLab, Harvey, Deel, Revolut,
Shield AI, ByteDance

Canonical company names for tracker rows: use exactly the names above
("Weights & Biases", not "Weights & Biases (CoreWeave)"; "Crusoe", not
"Crusoe Energy").

## Source 2 — Big Tech Scan

Same as Source 1, for large-cap tech (prioritize AI/platform/payments
orgs within each):

Google, Adobe, NVIDIA, Netflix, Intuit, PayPal, Affirm, Pinterest,
Reddit, Snap, Dropbox, GitHub, MongoDB, Workday, Figma, Airbnb, Uber,
Salesforce, Microsoft, Amazon, Apple, Meta

## Source 3 — Broad Web Search

Web-search for postings from ANY company (not just the lists above) using
queries shaped like:

- "(Staff OR Principal OR Group) Product Manager" AI OR agentic OR platform (San Francisco OR remote) job posting
- "Director of Product" OR "VP of Product" OR "Head of Product" (AI OR "B2B SaaS" OR developer OR infrastructure) ("San Francisco" OR "remote") posted this week
- site:job-boards.greenhouse.io OR site:jobs.lever.co OR site:jobs.ashbyhq.com senior product manager AI San Francisco

Vary phrasing across runs; prefer direct posting links (Greenhouse, Lever,
Ashby, Workday, company careers pages, LinkedIn job pages) over aggregator
search pages.

## Source 4 — Adzuna Daily

Search Adzuna (adzuna.com) for product-management roles posted in the last
day: seniority Director / VP / Head of Product / GM and Staff+/Principal
PM, location San Francisco, California. Follow through to the underlying
posting URL when Adzuna links out; otherwise use the adzuna.com listing
URL.

## Scoring (two tiers — see SKILL.md step 5)

Scoring is owned by the **job-fit-analyzer** skill
(`.claude/skills/job-fit-analyzer/`). Its
`references/target_profile.md` is the single source of truth for the hard
gates (level, comp floor, location, discipline wall) and the rocket-ship
list — edit THAT file to change the bar; this config only controls what
gets scanned.

- **Tier 1 (triage)**: every new role is gate-checked from scraped data
  alone. Gate failures at non-rocket-ship companies → `Verdict =
  TRIAGE_SKIP`, `Fit Score` 5–30, rationale naming the failed gate(s).
- **Tier 2 (full analysis)**: plausible gate-passers and any role at a
  rocket-ship / watchlist company → the full job-fit-analyzer workflow
  (web research, verdict object, 0–100 fit score, resume diff + why-me on
  every APPLY).

Note the funnel is deliberately wider than the bar: Staff+ IC roles are
still collected (market visibility), but they triage out honestly instead
of getting inflated scores.

Do not write roles that fail the shared filters at all (wrong discipline
per the collection filters, excluded location) — filtering happens before
scoring.

## Write caps and hygiene

- Max 40 new rows per run (highest score first).
- `Source` select values must be exactly: `Target Company Scan`,
  `Big Tech Scan`, `Broad Web Search`, `Adzuna Daily`.
- `Verdict` select values must be exactly: `APPLY`,
  `APPLY_PENDING_DILIGENCE`, `ROCKET_SHIP_EXCEPTION`, `SOFT_SKIP`,
  `HARD_SKIP`, `TRIAGE_SKIP`.
- `Status` is always `New` on insert; never any other value.
- Historical rows (written before 2026-07-08) may carry 1–3 Fit Scores
  from the old rubric; the backfilled `Verdict` is the authoritative
  signal on those.
