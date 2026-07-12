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

The funnel is deliberately narrow — it pursues only roles that can
plausibly clear the hard gates, so the tracker stays a candidate list, not
a market dump. Two collection lanes:

- **Titles / seniority — top-seat lane (all companies)**: collect ONLY the
  top product seat and legitimate exec peers:
  - VP of Product, CPO, CPTO, EVP Product, Chief Product Officer, SVP
    Product, product-owning GM (incl. "GM & VP"), Head of Product,
    Founding Product Director / Founding Product Lead.
  - **Do NOT collect** Staff / Sr. Staff / Principal / Group / Lead Product
    Manager, plain Product Manager, or Director / Sr. Director of a single
    sub-area — these fail the level gate and are just noise. ("Head of
    Product" is borderline but IN; the analyzer resolves whether it's the
    top seat.) Exclude PMM and engineering-management roles entirely.
- **Titles / seniority — rocket-ship lane (named + watchlist companies
  only)**: at any company on the rocket-ship named list
  (`../job-fit-analyzer/references/target_profile.md`) or the watchlist
  (`../job-fit-analyzer/references/rocket_ship_watchlist.md`), collect ALL
  senior product roles — Staff+, Principal, Lead, and up through CPO. IC
  seats at these companies are legitimately interesting via the level-gate
  override, so the wide net applies only here.
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
of these companies for new openings. **These companies are all on the
rocket-ship named list or watchlist → use the rocket-ship lane: collect
ALL senior product roles (Staff+ through CPO), not just top seats.**

Anthropic, OpenAI, Stripe, Databricks, Weights & Biases, CoreWeave,
Crusoe, Lambda, Nebius, Supabase, GitLab, Harvey, Deel, Revolut,
Shield AI, ByteDance

(If any company here is NOT actually on the named/watchlist files, apply
the top-seat lane to it instead — the files are authoritative.)

Canonical company names for tracker rows: use exactly the names above
("Weights & Biases", not "Weights & Biases (CoreWeave)"; "Crusoe", not
"Crusoe Energy").

## Source 2 — Big Tech Scan

Large-cap tech (prioritize AI/platform/payments orgs within each). These
are NOT rocket-ship companies → **top-seat lane only**: collect just VP
Product / CPO / CPTO / EVP / Head of Product / product-owning GM roles.
Skip their Staff/Principal/Group/Director-of-a-sub-area postings.

Google, Adobe, NVIDIA, Netflix, Intuit, PayPal, Affirm, Pinterest,
Reddit, Snap, Dropbox, GitHub, MongoDB, Workday, Figma, Airbnb, Uber,
Salesforce, Microsoft, Amazon, Apple, Meta, ServiceNow

## Source 3 — Broad Web Search

Web-search for **top-seat** postings from ANY company using queries shaped
like:

- "VP of Product" OR "Chief Product Officer" OR "Head of Product" (AI OR agentic OR "B2B SaaS" OR developer OR platform) ("San Francisco" OR remote) posted this week
- "EVP Product" OR "CPTO" OR "GM & VP" product (AI OR infrastructure OR payments) ("Bay Area" OR remote) job
- "Founding Product Director" OR "Founding Head of Product" (AI OR agentic) (San Francisco OR remote)
- site:job-boards.greenhouse.io OR site:jobs.ashbyhq.com ("VP Product" OR "Head of Product" OR "Chief Product Officer") AI

Do NOT search for Staff/Principal/Group/Lead PM titles here — that lane is
reserved for the rocket-ship companies in Source 1. Vary phrasing across
runs; prefer direct posting links (Greenhouse, Lever, Ashby, Workday,
company careers pages, LinkedIn job pages) over aggregator search pages.

## Source 4 — Adzuna Daily

Search Adzuna (adzuna.com) for **top-seat** product roles posted in the
last day: VP of Product / CPO / CPTO / EVP / Head of Product / GM, location
San Francisco, California. Do not include Staff/Principal/Director-of-a-
sub-area PM titles. Follow through to the underlying posting URL when
Adzuna links out; otherwise use the adzuna.com listing URL.

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

The funnel is now narrow (top-seat lane everywhere + all-roles only at
rocket-ship companies), so most collected roles reach Tier 2 and
TRIAGE_SKIP is rare — it now mainly catches mislabeled roles that slip
through collection (e.g. "VP, Product **PR**", a "VP" that is a finance
mid-level title, or a discipline-wall infra role).

Do not write roles that fail the shared filters at all (wrong seniority
lane, wrong discipline, excluded location) — filtering happens before
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
