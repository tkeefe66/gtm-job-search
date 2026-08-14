// The 1-5 fit-scoring prompt: the rubric, the signal blocks, and the two
// places compensation enters it.
//
// Lives in lib/ rather than inline in app/actions/parse-role.ts for the same
// reason buildExtractionPrompt lives in lib/crawler.ts: parse-role.ts is a
// `"use server"` module, so nothing pure can be exported from it (every export
// would become a server action) and nothing in it can be reached from a test —
// scoreFit reads settings and calls Claude. Out here, the decisions below are
// pinned by lib/fit-prompt.test.ts.
//
// scoreFit remains the only caller. It supplies the model, the system prompt,
// and the JSON parsing; this file decides only what the model is told.

import type { FitInputs } from "@/lib/fit-inputs";

/**
 * Everything the prompt says about one role.
 *
 * `salary_range` is REQUIRED, unlike arr / exit_signal / backer. Those three
 * have an authoritative fallback the model can reason about ("unknown" means
 * the company's financials were not researched); a posting's pay does not —
 * omitting it would be indistinguishable from an employer publishing nothing,
 * and would score the role as if it had. Both client call sites already hold
 * `form.salary_range`, so required costs them a line, not a lookup.
 *
 * This interface IS scoreFit's parameter shape minus `fitInputs`, which is
 * what makes `ScoringArgs` in lib/rescore-scope.ts derive correctly: a new
 * required field here breaks `scoringArgsFor` at compile time.
 */
export interface FitPromptRole {
  company: string;
  role_title: string;
  company_description: string;
  key_skills: string;
  fit_summary: string;
  department: string;
  location: string;
  /** The posting's stated compensation, verbatim. "" when it published none. */
  salary_range: string;
  arr?: string;
  exit_signal?: string;
  backer?: string;
}

/**
 * A whole-dollar figure with thousands separators, for the prompt.
 *
 * Deliberately NOT `toLocaleString()`. That call's output depends on the
 * host's default locale and on whether the Node build ships full ICU: the same
 * floor renders "$180,000" here and "$180 000" or "$180000" on a server
 * configured differently, and nothing in the app would report the difference —
 * the prompt would just quietly state a stranger number to the model. Pinning
 * `"en-US"` fixes that but leaves a live mutation target (drop the argument
 * and every test still passes on an en-US machine), so the formatting is done
 * here instead, where it is deterministic by construction and pinned by test.
 *
 * Rounded because the grouping regex assumes an integer run of digits.
 * `saveCompFloor` already rejects non-integers; a hand-edited row could still
 * carry one, and "$180,000.5" is not a number anyone should read.
 */
export function formatDollars(n: number): string {
  return `$${Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",")}`;
}

/**
 * The candidate-block line stating the compensation floor, or "" when no floor
 * is set.
 *
 * APPENDED to the fit brain rather than merged into it. The floor is its own
 * setting with its own editor and its own reset; folding it into the stored
 * brain text would make a floor change look like a fit-brain edit and would
 * survive a "reset fit brain to default".
 *
 * `0` reads as "no floor", matching every other truthiness check on this value
 * (the /roles filter, saveCompFloor's validation, which rejects 0 outright).
 * A literal $0 floor is not a thing anyone means; `null` is how "off" is spelled.
 *
 * The figure is formatted by `formatDollars` above, never by the host locale.
 */
export function compFloorLine(compFloor: number | null): string {
  if (!compFloor || compFloor <= 0) return "";
  return (
    `\n- Targets roles paying at least ${formatDollars(compFloor)} base. ` +
    `Below that is a weaker fit unless the equity or building opportunity is exceptional.`
  );
}

/**
 * The SCORING GUIDE clause that tells the model what to DO with the floor.
 *
 * Empty when no floor is set: with no stated minimum, "below the candidate's
 * minimum" names nothing, and an instruction that references a value the
 * prompt never supplies invites the model to invent one.
 *
 * "Cap at 3", not "score 1-2". The spec's promise is that a below-floor role
 * scores LOW rather than disappearing — it stays visible, sorted down, with a
 * rationale that says why.
 */
export function compScoringClause(compFloor: number | null): string {
  if (!compFloor || compFloor <= 0) return "";
  return `

COMPENSATION (the candidate stated a minimum base above — apply it):
- Posted base clearly below that minimum = cap the score at 3 no matter how strong the rest of the fit is, and say so in the rationale. Do not drop it below what the rest of the fit earns; a below-floor role is a real role the candidate may still want to see.
- Posted base at or above the minimum = no adjustment. Do not reward pay above the floor.
- No base published, or an OTE / on-target figure only = no adjustment either way. OTE bundles commission and is not a base figure — never treat it as one, and never guess a base from it.`;
}

/**
 * The carve-out that keeps the AI-GTM rule's unconditional floor of 4 from
 * overriding the compensation floor.
 *
 * Without it the rule wins: none of its three conditions mention pay, so a
 * below-floor role at an established B2B SaaS company with an AI-GTM mandate
 * floors at 4 and the compensation clause above is dead text. This is the one
 * place in the prompt where two floors collide, and the money one has to win —
 * otherwise the guide says "cap at 3" and the rule says "at least 4" in the
 * same prompt.
 */
export function aiGtmCompCarveOut(compFloor: number | null): string {
  if (!compFloor || compFloor <= 0) return "";
  return `\n→ If the posted base is below the candidate's stated minimum, cap at 3 regardless of this rule. The compensation floor overrides this one.`;
}

/**
 * The full user-turn prompt for one fit score.
 *
 * Renders the criteria it is HANDED — the fit brain and floor come in through
 * `inputs`, never off a module constant — so an edited fit brain and an edited
 * floor both reach the model without touching this file.
 */
export function buildFitPrompt(role: FitPromptRole, inputs: FitInputs): string {
  return `Score how well this role fits this candidate on a scale of 1-5. Be ruthless.

CANDIDATE:
${inputs.fitBrain}${compFloorLine(inputs.compFloor)}

ROLE:
Company: ${role.company}
Company description: ${role.company_description}
Title: ${role.role_title}
Department: ${role.department}
Location: ${role.location}
Posted compensation: ${role.salary_range || "not listed"}
ARR: ${role.arr || "unknown"}
Backer / investor: ${role.backer || "unknown"}
Exit signal: ${role.exit_signal || "none mentioned"}
Key skills required: ${role.key_skills}
Summary: ${role.fit_summary}

SCORING GUIDE:
1 = Poor fit — wrong industry, no relevant overlap, or clearly too junior/unrelated
2 = Weak fit — some domain overlap but significant gaps, or a narrow ops/IC role with no systems-building or strategic scope
3 = Moderate fit — relevant domain and background but a standard ops/manager role without broad ownership, systems architecture, or AI/building upside
4 = Strong fit — clear domain alignment AND (broad ownership across the GTM/RevOps stack, lead/principal/head-level scope, hands-on GTM systems + AI/agentic building, or explicit cross-functional leadership even without a VP title)
5 = Exceptional fit — almost tailor-made: Head/VP/Director-level GTM Systems / RevOps / Marketing Ops / GTM-AI title at a B2B SaaS company where the domain is a direct match, OR a GTM Engineer / AI-Ops builder role with broad mandate at a strong company${compScoringClause(inputs.compFloor)}

TITLE SCOPE SIGNALS (use these to adjust score):
- "Head of", "VP", "Director" of RevOps / Revenue Operations / GTM Systems / Marketing Operations / GTM Strategy = leadership level, eligible for 4-5 if domain matches
- "GTM Engineer", "GTM Systems", "AI Operations", "AI Ops", "Revenue Systems", "Marketing Ops Architect", "Agentic / Automation" in the title = direct match to Tom's practitioner-builder positioning; score on company tier + scope + AI/building mandate, eligible for 4-5 even as an IC when systems/agentic work and broad ownership are the point
- IC / practitioner builder roles at elite AI-first companies (Anthropic, OpenAI, Google DeepMind, Cursor, Cohere, Mistral, etc.) or hyper-growth B2B SaaS (Series B+) where hands-on GTM systems + agentic AI is the mandate = eligible for 4-5 regardless of title — the building, equity, learning, and impact outweigh the title
- "Marketing Operations Manager" / "RevOps Analyst" at a generic small company with no AI angle and narrow scope = cap at 2-3
- Pure people-management or pure process-admin roles with no systems architecture or AI/building component = lower

FINANCIAL SIGNALS (use these to adjust score up or down):
- High ARR ($100M+) with a clear exit signal (PE exit, IPO path) = strong upward signal — equity likely meaningful, role has real scope
- PE-backed with exit planned = structured liquidity event coming, high upside if the fit is there — bump score +0.5 if other signals are strong
- Top-tier backer (a16z, Sequoia, Benchmark, General Catalyst, etc.) = legitimacy signal, bump slightly
- Unknown backer or pre-revenue = neutral, don't penalize unless other signals are weak
- Very high ARR ($500M+) at a PE-backed company heading to exit = rare opportunity signal, weight positively

AI-DRIVEN GTM TRANSFORMATION RULE (apply when all three are true):
1. The company is an established B2B SaaS / RevTech / MarTech company (PE-backed, growth-stage, or public — not just a tiny startup)
2. The role is explicitly framed as leading an AI transformation of GTM, RevOps, or Marketing Operations — building AI/agentic workflows into the revenue engine, not just "uses AI"
3. The domain is within 1 degree of Tom's background (B2B SaaS, ABM/ABX, RevTech/MarTech, GTM tooling, data platforms, or any software vertical where his GTM-systems leadership transfers)
→ When all three apply: floor score of 4. This is a mandate to define what AI means for the entire GTM/revenue motion — exactly the practitioner-builder + systems-architect role Tom is targeting.
→ If the domain requires deep vertical expertise Tom lacks (pharma, clinical, hardware, heavy regulatory): stay at 3. Real upside but execution risk is high — he'd spend year 1 learning the domain rather than building.${aiGtmCompCarveOut(inputs.compFloor)}

Return a JSON object with:
- score (integer 1-5)
- rationale (string, 1-2 blunt sentences explaining the score)

Return ONLY the JSON object.`;
}
