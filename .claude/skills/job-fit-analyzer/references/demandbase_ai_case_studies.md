# Demandbase AI — Deep-Dive Case Studies (interview & why-me source material)

Detailed narrative material Chad wrote himself, beyond what fits on the
resume. Use this when a posting or interviewer wants real AI-platform
architecture depth — not just "shipped AI features." `resume_master.md`
stays the lean bullet source; this file is where `interview-prep` and
deep why-me notes go for substance, direct quotes, and interview-ready
framing.

**Role boundary — read before using any of this.** Across every initiative
below: Chad set product direction, problem framing, architecture, and
strategy. A PM or direct report on his team owned engineering delivery
(building the agent service, writing the streaming integration, shipping
the code). Never claim Chad personally built/coded these systems — use
"directed," "set the architecture for," "led the product strategy for,"
never "built" or "engineered." This distinction is explicit in Chad's own
source material and must be preserved in any resume diff or why-me note
drawn from this file.

---

## 1. Pipeline Intelligence — GTM Research Agent (Journey + Opportunity Insights)

**One-liner:** Replaced static insight paragraphs with a plan-first,
tool-grounded research agent embedded in journey and opportunity
analytics — so revenue teams go from "what does the dashboard show?" to
"here are the accounts to act on," without leaving the workflow they
already use.

**Customer problem:** B2B revenue teams had rich analytics (journey
funnels, buying group coverage, intent signals, opportunity velocity) but
no fast path from "accounts are stalling" to "here's who to call and why."
The legacy experience was a static insights sidebar — click a preset chip,
wait, read a block of markdown. No context from what the user was looking
at, no follow-up conversation, no action.

**Before → after (the migration Chad drove):**
- Interaction: fixed sidebar with suggestion chips → conversational,
  multi-turn ChatShell.
- Delivery: non-streaming, full-response spinner → SSE streaming with
  visible plan/step progress.
- Backend: template insights (Opportunity) / early sync LangChain agent
  (Journey) → unified plan-first LangGraph pipeline (Planner → deterministic
  Executor → Response Generator → optional Visualizer).
- Context: account list + date range only → full live dashboard state
  (filters, journey, IBG, comparison mode) plus click-through intent
  (stage badge, stalled cohort, account/opportunity row).
- Output: plain markdown narrative → streaming markdown interleaved with
  inline charts and recommendation tables that resolve to filtered,
  clickable account/opportunity lists.
- Trust model: black box (loading → prose) → visible agent cognition
  (status → plan → step progress → narrative).

**Scale:** 17 research scenarios routing to 13+ grounded analytics tools
across journey and opportunity domains, backed by Performance Intelligence
API, Cube (semantic layer), and SyncDAP (query execution).

**Key product decisions Chad owned:**
1. Analytics + copilot, not chat bolted on — AI lives inside the workflow
   customers already trust (contextual entry points: stage cards, stalled
   badges, sparkles on accounts/opportunities auto-pass intent into the
   agent).
2. One agent platform, two domains (journey vs. opportunity) — same
   streaming infra, different dashboard scoping keys.
3. Plan-first, tool-grounded: LLM plans and narrates, tools fetch ground
   truth. No improvised data paths.
4. Proactive landing (explore cards) instead of a blank chat box — lowers
   the cold-start problem.
5. Structured output (charts, recommendation tables) shipped behind flags
   so streaming narrative could land first without blocking GA.

**Tradeoffs Chad would name unprompted (shows honest product judgment):**
- Reliability vs. flexibility: scenario routing + deterministic execution
  trades some conversational freedom for grounded answers.
- Latency vs. trust: visible plan/step streaming adds perceived wait but
  builds the trust RevOps leaders need to act on output.
- Coverage vs. speed: a scenario library can't answer everything day one;
  explore cards steer toward high-confidence paths while coverage expands.
- Actionability vs. complexity: recommendation tables/charts needed
  structured SSE + entity resolution — narrative shipped first, executable
  artifacts layered on after.

**60-second pitch (Chad's own words, verbatim):** "Revenue teams had
dashboards full of pipeline and journey data but no fast path from
'accounts are stalling' to 'here's who to call and why.' We had a legacy
insights sidebar — click a preset chip, wait, read markdown. Useful but
static, disconnected from what you clicked on, and unable to carry a
conversation. I led the product shift to an embedded GTM research agent:
streaming, multi-turn, context-aware. Click a stalled stage or an
opportunity row and the agent already knows your scope. It plans a
research path, calls grounded analytics tools on real data, streams the
answer, and can return actionable account lists inside the chat. My direct
report owned delivery of the agent platform and UI integration. I owned
the customer problem, the before/after migration, scenario prioritization,
and the product architecture — analytics plus copilot, not a bolt-on
chatbot."

---

## 2. Demandbase AI — Governed Conversational Data Intelligence (Chat)

**One-liner:** Demandbase AI turns governed GTM analytics into a
conversational colleague — so revenue teams get trustworthy numbers in
Chat, without becoming data engineers.

**Customer problem:** GTM users think in accounts, pipeline, and
engagement — not warehouses and joins. A generic LLM without grounding
invents metrics and erodes trust; for revenue teams, a wrong pipeline
number is a credibility and commercial risk, not just a UX bug.

**Trust architecture (four layers) — this is the deepest, most
enterprise-credible material in the whole set, worth quoting directly in
interviews:**
1. **Semantic layer (Cube.dev):** tenant-scoped metadata, dimensions,
   joins, business-friendly titles. Answers anchor to governed
   definitions, not model-invented schema.
2. **Controlled execution:** read-only SQL via a Data Access Proxy on
   tenant-scoped analytics. Numbers are auditable.
3. **Hard multitenancy:** tenant scope bound at tool construction — the
   model never supplies tenant ID as an argument. Scope is not optional;
   one cross-tenant mistake is existential for an enterprise vendor.
4. **Authorization gate:** capability checks before agent work runs,
   fail-closed on authz transport errors. No silent policy bypass.

**Agent loop:** classify → clarify → load relevant definitions → present
a plan in business language and confirm → query → interpret. This is both
copilot UX (catch wrong assumptions before execution) and platform safety.

**Production UX details worth naming:** SSE streaming with a fixed event
model (session, thinking, tool, message, done, error); a smaller/faster
"thinking translator" model that turns raw reasoning into short status
lines (fail-open — translation failure never blocks the answer); multi-turn
memory for natural follow-ups ("now only Qualified stage").

**Economics and quality as product requirements (not backend
afterthoughts) — directly answers any JD asking about "operating rigor" or
"AI governance":**
- Prompt caching and disciplined proxy routing for agent-loop unit
  economics; per-request cost/compliance attribution by tenant/user/
  conversation.
- System prompts and tool descriptions treated as code under test; offline
  eval and regression harnesses gate every behavior change — "production
  hope is not a release strategy" (Chad's phrase).
- Explicit resilience polarity: fail-closed where policy matters
  (permissions), fail-open where ancillary perfection shouldn't block
  revenue work (memory persistence, feature flags, translator).

**Differentiation vs. "wrap GPT around SQL" (Chad's framing, useful
verbatim in an interview):** multitenancy by closure, not prompt pleading;
permissions before work; offline evals; cost-aware architecture; a stable
client contract teams can rely on.

**North star metric Chad set:** a revenue marketer gets a defensible
answer in one Chat thread without filing a data ticket.

---

## 3. Demandbase AI — Full Platform Arc (Chat → Personalization → Measurement)

**One-liner:** Demandbase AI is the full loop — ask (Chat), act (governed
website personalization / form enrichment), measure (account-level ROI) —
not chat alone.

**The insight that shaped the roadmap:** AI value in B2B is the full loop.
Chat without governed execution is a parlor trick. The company built:

1. **Conversational intelligence** — AI Chat + Data Explorer Agent +
   memory service, shipped as an independently-releasable micro-frontend
   embedded in the main app shell. Answers are tenant-scoped and
   permission-aware — the agent inherits the user's actual data access,
   never a god-mode service account.
2. **Governed execution (personalization platform)** — Site Customization
   and Form Enrichment. Dual targeting model (real-time selector rules vs.
   pre-computed audience-list index) as a deliberate tradeoff between
   campaign-speed and always-on ABM use cases. Self-service publish
   collapsed time-to-live from days to minutes. Every modification is
   tagged `user` / `ai_agent` / `ai_content` — provenance and governance
   built in from day one, before AI-generated content shipped broadly.
3. **Measurement / learning loop** — Experience Dashboard (targeted /
   visited / clicked, drill-down by account), per-tenant adoption
   analytics, a dependency graph so downstream experiences know when
   upstream audience/selector data goes stale.

**Sequencing (a genuinely useful "how do you sequence an AI platform bet"
answer):** foundation (multi-tenant data + tag delivery) → self-service
publish (remove the support bottleneck) → AI-native metadata/provenance
laid down *before* AI generation shipped → conversational layer → full
integration (Chat insights flow directly into experience creation on a
shared tenant identity).

**Principles Chad states he'd repeat on any AI platform:**
- Grounding beats fluency.
- Execution is the moat — invest as much in the governed action layer as
  the chat layer.
- Provenance by default (human vs. agent vs. AI-assisted, tracked
  everywhere).
- Flag-gated rollout — enterprise buyers expect per-tenant/per-user
  control.
- Measure in the customer's unit of value (accounts targeted, experiences
  fired, clicks) — not tokens consumed.

---

## When to reach for this file

- A posting emphasizes **agent architecture, RAG, multi-tenant AI trust,
  AI governance, or "operating rigor"** (e.g. Ecosystems' "agentic
  experiences, RAG architecture," STARLIMS's "sophisticated AI/ML
  strategy," any enterprise-AI-platform mandate) — pull specific,
  quotable detail from here rather than the resume's one-line bullets.
- An interviewer asks "walk me through the AI architecture" or "how do you
  think about AI product economics/trust" — the trust-architecture layers
  (Case 2) and the resilience/eval-gating detail are the strongest,
  most differentiated material Chad has.
- A caveat in a fit analysis says something like "power-user fluency, not
  platform architecture depth" — this file is the honest rebuttal:
  real plan-first agent design, real multi-tenant enterprise AI trust
  architecture, real offline eval discipline. Still application-layer
  product work, never an infra/HPC claim — this closes the "shallow AI
  feature-shipper" gap without crossing the discipline wall into
  dev-infra territory.
