---
name: job-fit-analyzer
description: Analyze job postings against Chad's VP Product / CPO target profile, render a structured fit verdict (apply or skip), and auto-generate surgical resume edits plus a "why me" note for every apply. Use this skill ANY time Chad pastes a job posting, a recruiter email, a position description PDF, or a link to a role — or says anything like "should I apply to this", "what do you think of this role", "analyze this job", "tailor my resume for this", "is this worth pursuing", or "here's a role I was sent." Also use it inside routines or scheduled jobs that scan and score job postings in bulk. Always run the FULL workflow in this skill (hard gates, thesis scoring, discipline-wall check, rocket-ship override) — never eyeball a posting and improvise a verdict, and never skip the resume diff on an APPLY.
---

# Job Fit Analyzer

Evaluates job postings against Chad Holdorf's target profile, produces a structured verdict, and for every APPLY generates a surgical resume edit diff and a short "why me" note. Built to run interactively or unattended inside routines.

## Files in this skill

| File | When to read it |
|---|---|
| `references/target_profile.md` | ALWAYS, first. Hard gates, fit thesis, red flags, rocket-ship list. |
| `references/resume_master.md` | Before generating any resume diff or why-me note. |
| `references/verdict_schema.md` | Before emitting output. Exact structured format + prose rendering rules. |
| `references/calibration_examples.md` | When a posting resembles a tricky case (prestige logo, keyword overlap, title ambiguity, domain question). Eight graded examples with the lesson each teaches. |
| `references/rocket_ship_watchlist.md` | In Step 6, whenever the company might be a hot/high-talent-density startup. Reference-tier list (Paraform TDI + Harmonic Hot 25) with discipline + stage tags. Flags only — never waives a gate. |
| `references/demandbase_ai_case_studies.md` | When generating a resume diff or why-me note for a posting that wants real AI-platform depth (agent architecture, RAG, multi-tenant AI trust/governance, "operating rigor") — richer, quotable detail beyond the resume's one-line bullets. Read the role-boundary note at the top before using: Chad directed these, a report built them. |

## Workflow

Run these steps in order for every posting. Never skip a step.

### Step 1 — Ingest and research

- Parse the posting: title, company, location/work model, comp (if listed), reporting line, mandate, required qualifications.
- If the posting is thin (recruiter blurb, missing stage/comp/reporting info), **use web search** to fill gaps: funding stage and trajectory, ARR/growth signals, leadership team (is there already a CPO? who does this role report to?), headcount, whether AI is core or bolted on. Recruiter emails routinely omit the facts that decide the verdict.
- Note anything unresolvable as an open question (do not guess).

### Step 2 — Hard gates

Read `references/target_profile.md` and test each gate. Record pass/fail per gate with one-line evidence.

1. **Level** — Is this the top product seat (VP Product, CPO, CPTO, EVP Product) or a peer C-level carve-out? IC/Staff/GPM/Head-of-a-single-area roles fail. "Head of Product" at a small company is *ambiguous* — flag as diligence question, not auto-fail.
2. **Comp** — $350K+ floor. A base band topping out under $350K priced as an IC/PM band fails. An exec package grazing the floor is a soft signal, not an auto-pass.
3. **Location** — Remote ✓ or SF/Bay Area ✓ (Bay Area in-office/hybrid is acceptable). In-office/hybrid anywhere else fails. A Bay Area office option welded to a role that fails other gates does not rescue the role.
4. **Discipline** — Is the required discipline application/platform-layer B2B product leadership (Chad's), or a different discipline entirely (dev-infra, HPC/GPU infrastructure, build systems, hardware)? See the discipline-wall test in Step 4.

### Step 3 — Fit thesis and upside

Score against the two acceptable archetypes:
- **(a) AI-native and climbing** — AI is the product core, company has real growth trajectory.
- **(b) Established + needs AI** — proven company at an AI-transformation inflection point, hiring someone to lead it.

Then assess **upside** explicitly: funding/valuation trajectory, ARR growth, market momentum, whether the mandate is category-building or defensive. A prestigious, mature, flat platform with a defensive mandate (trust & safety, integrity, maintenance) is **off-thesis regardless of the logo**. Prestige is not a criterion. When upside is weak, still complete the full analysis and say plainly: "low upside, here's why, probably skip."

### Step 4 — Caveat classification

Classify every gap. This is where most reasoning errors happen — read `references/calibration_examples.md` when unsure.

- **Vertical gap (tailorable → can still be APPLY):** same discipline (enterprise/B2B application product), different industry vertical (EdTech, legal, fintech). Address in the why-me note; select resume bullets that bridge.
- **Discipline wall (not tailorable → skip):** the *required discipline* is different — GPU/HPC infrastructure, build systems/CI-CD platform product, frontier-research infra. Chad is an application-layer product exec who ships code daily (Cursor, Claude Code); that is power-user fluency and app-layer building, **never** a claim to infra depth. Keyword overlap ("developer productivity", "AI agents", "Claude") does not cross the wall.
- **Scope stretch up (positive caveat):** broader seat than pure product (e.g., CPTO owning eng). Lean on Salesforce dev-platform/CI-CD ownership, agentic prototyping framework, hands-on building to close it.
- **Title/structure nuance:** an EVP carved out alongside an existing CPO with its own P&L is a legitimate senior mandate — NOT the red-flag pattern. The red flag is a VP *reporting into* another VP/SVP of Product. "Head of Product" → diligence question: top seat or a layer down?

### Step 5 — Verdict

Assign exactly one:

- **APPLY** — passes gates, on-thesis, caveats tailorable.
- **APPLY_PENDING_DILIGENCE** — would be APPLY except for an unresolved question (e.g., "is Head of Product the top seat?"). List the questions.
- **SOFT_SKIP** — near-miss: level close-ish, comp grazes floor, or one fixable gate. Gets a *real* escape hatch ("worth a 20-min recruiter call to test X").
- **HARD_SKIP** — multiple independent misses, or off-thesis mandate, or discipline wall. Escape hatch is honest, often "essentially nothing — pass without a call."
- **ROCKET_SHIP_EXCEPTION** — see Step 6.

Every skip includes a one-line escape hatch: "The one thing that could change my mind: …" calibrated to skip severity.

### Step 6 — Rocket-ship override

Check the named list and definition in `references/target_profile.md`.

- The override **waives the level gate only**. Chad will take an IC seat at a true rocket ship.
- It does **not** waive comp floor, does **not** waive remote/Bay-Area, does **not** waive the discipline wall.
- The override targets the **company, not the seat**. If the specific role is a discipline wall, output: honest scorecard first ("on your five criteria: skip — IC level, discipline gap"), then a labeled **Rocket-ship exception** block that (a) redirects to seats at that company matching Chad's discipline, (b) if he still wants this seat, gives the honest why-me angle and the gap he'd have to sell past, and (c) a gut-check line that he is deliberately overriding his own bar.
- An unlisted company matching the definition → flag "possible rocket-ship — confirm?" rather than silently applying the override.
- **Watchlist check.** Also consult `references/rocket_ship_watchlist.md` (Paraform Talent Density Index + Harmonic Hot 25). If the company is on it: add one line naming the source and rank/score, check its **discipline tag** (a `WALL` company still fails the discipline gate — say so plainly), and otherwise **run every gate straight**. The watchlist is awareness only — it NEVER waives level, comp, location, or discipline. Most watchlist companies are early-stage, so expect level/comp to fail honestly; do not let the badge inflate the verdict. Only Chad promotes a watchlist company to the named list; suggest it if genuinely warranted, never auto-promote.
- **Backer-pedigree signal.** If a company (listed or not) is backed by a cluster of Sequoia, OpenAI, Bezos Expeditions, Khosla, Lux, or Thrive, flag "possible rocket-ship — confirm?" and name the backers. This is a flag, not a pass — never auto-apply the override on funding alone.

### Step 7 — Outputs

Read `references/verdict_schema.md` and emit:

1. The **structured verdict object** (always, every posting — this is what routines consume).
2. **Prose rendering** of the verdict (readable, direct, no hedging).
3. For **APPLY and APPLY_PENDING_DILIGENCE**: a **resume edit diff** and a **why-me note** — generated eagerly, every time, including in bulk/routine runs. Never flag-only.
4. For skips: verdict + reasoning + escape hatch only. No resume artifacts beyond at most one line.

### Resume handling

- `references/resume_master.md` is the source of truth for all diffs.
- If Chad uploads a newer resume PDF in the conversation, extract it and use that content in preference to the bundled master; tell him the master should be updated (re-package the skill or paste the new version).
- In a routine, if no master is readable and no PDF is available: still emit the full verdict and analysis, and flag "resume artifacts pending — point me at the resume PDF." Never lose the fit analysis because the file is missing. Never silently skip resume work when the master exists.

### Resume diff rules

- **Surgical edits only** — never a full rewrite. Format each edit as: location → current text → replacement text → one-line rationale tied to the posting.
- Tailoring is mostly *selection, reordering, and the summary line*: which of the three AI-credibility layers to lead with — (1) shipped AI product at scale (Demandbase AI, Agentbase), (2) AI-transformation of an established org, (3) hands-on builder (Cursor/Claude Code, side projects). Match the layer to the posting's archetype.
- The summary paragraph is always a tailoring target; rewrite it per role.
- Never fabricate experience. Never claim infra/HPC/build-system depth.

### Why-me note rules

- Short. Punchy sentences. No em dashes. No corporate filler. No bullet walls — if listing, use `->` arrows sparingly.
- Name the strongest genuine hook first (e.g., a posting that names Claude Code gets the builder identity in sentence one).
- Address the biggest honest gap in one confident line rather than hiding it.
- Demandbase is the most recent role; Chad is in an active search for his next seat.

## Voice and honesty rules

- Grade the seat, not the brand. Say out loud when a logo or keyword overlap is doing the seductive work.
- Never let a shiny AI mandate override a failed hard gate, and never let a hard gate hide genuine praise for the role's strengths — name both.
- Distinguish hard vs soft skips; calibrate the escape hatch accordingly.
- Park unanswerable questions in `open_questions`; never guess on reporting lines, comp, or work model.
