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
 *
 * The band-top bullet exists so this clause agrees with `salaryBucketFor` in
 * lib/salary-filter.ts, which buckets on `base > floor`. A band topping out AT
 * the minimum is not "clearly below" it and would read as "at or above", so
 * without the bullet the model scores it 4-5 while the table files it under
 * "below" and the "Meets minimum" toggle hides it — the table and the score
 * saying different things about the same role.
 */
export function compScoringClause(compFloor: number | null): string {
  if (!compFloor || compFloor <= 0) return "";
  return `

COMPENSATION (the candidate stated a minimum base above — apply it):
- Posted base clearly below that minimum = cap the score at 3 no matter how strong the rest of the fit is, and say so in the rationale. Do not drop it below what the rest of the fit earns; a below-floor role is a real role the candidate may still want to see.
- Posted base range whose TOP only reaches that minimum = treat it as below too, and cap at 3 the same way. Reaching the number would take negotiating to the absolute ceiling of the band, which is not meeting a minimum.
- Posted base above the minimum, meaning the top of the range clears it outright = no adjustment. Do not reward pay above the floor.
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
 *
 * Carries the band-top rule too, spelled out rather than referenced. This line
 * is read where it sits — inside the rule whose "floor score of 4" it has to
 * beat — and "below the minimum" read narrowly there floors a band-topping-out
 * role at 4, which is the same table-versus-score split the clause above
 * closes, reopened by the one rule that outranks it.
 */
export function aiGtmCompCarveOut(compFloor: number | null): string {
  if (!compFloor || compFloor <= 0) return "";
  return `\n→ If the posted base is below the candidate's stated minimum, or is a range whose top only reaches it, cap at 3 regardless of this rule. The compensation floor overrides this one.`;
}

/**
 * The TITLE SCOPE SIGNALS block, heading included.
 *
 * The heading lives HERE and not in the template literal, because a heading in
 * the literal renders whether or not there are bullets under it — and an empty
 * `titleScope` would then produce a bare heading over a blank line. That is the
 * same seam defect aiGtmCompCarveOut had, and the same shape compScoringClause
 * already solves by owning its own leading newlines.
 *
 * The bullets carry no leading or trailing newline. This wrapper owns only the
 * blank line BEFORE the block; the blank line after it stays in the template
 * literal, so the empty case still separates the surrounding sections.
 */
export function titleScopeBlock(titleScope: string): string {
  if (!titleScope) return "";
  return `\n\nTITLE SCOPE SIGNALS (use these to adjust score):\n${titleScope}`;
}

/**
 * The domain-bonus block, with the compensation carve-out that belongs to it.
 *
 * The carve-out renders ONLY when there is a rule for it to override. Its text
 * says the floor "overrides this one" — with no rule, "this one" has no
 * referent, and every tenant with a comp floor and no domain bonus would get a
 * dangling pronoun in the prompt that scores their every role.
 *
 * Behaviour is unchanged today, when the bonus is always present.
 */
export function domainBonusBlock(domainBonus: string, compFloor: number | null): string {
  if (!domainBonus) return "";
  return `\n\n${domainBonus}${aiGtmCompCarveOut(compFloor)}`;
}

/**
 * The default tails of the 2/3/4 scoring-guide clauses — see the field doc on
 * `FitInputs.weakFitTail` in lib/fit-inputs.ts for why there are three and why
 * the 1 and 5 clauses aren't here. This is today's one career hardcoded as the
 * fallback; `scoringInputsFrom` is what will source these per-user later.
 */
export const DEFAULT_WEAK_FIT_TAIL =
  "some domain overlap but significant gaps, or a narrow ops/IC role with no systems-building or strategic scope";
export const DEFAULT_MODERATE_TAIL =
  "relevant domain and background but a standard ops/manager role without broad ownership, systems architecture, or AI/building upside";
export const DEFAULT_STRONG_TAIL =
  "clear domain alignment AND scope at or near the level the candidate says they are targeting (broad ownership of their stated stack, hands-on systems + AI/agentic building, or explicit cross-functional leadership even without the matching title)";

/**
 * The default TITLE SCOPE SIGNALS bullets — the heading is owned by
 * titleScopeBlock, not this constant. See the field doc on
 * FitInputs.titleScope in lib/fit-inputs.ts for why this is a block rather
 * than a clause tail like the three above.
 */
export const DEFAULT_TITLE_SCOPE = "- \"Head of\", \"VP\", \"Director\" of RevOps / Revenue Operations / GTM Systems / Marketing Operations / GTM Strategy = leadership level, eligible for 4-5 if domain matches\n- \"GTM Engineer\", \"GTM Systems\", \"AI Operations\", \"AI Ops\", \"Revenue Systems\", \"Marketing Ops Architect\", \"Agentic / Automation\" in the title = a direct match IF that is the positioning the candidate describes; score on company tier + scope + AI/building mandate, eligible for 4-5 even as an IC when systems/agentic work and broad ownership are the point\n- IC / practitioner builder roles at elite AI-first companies (Anthropic, OpenAI, Google DeepMind, Cursor, Cohere, Mistral, etc.) or hyper-growth B2B SaaS (Series B+) where hands-on GTM systems + agentic AI is the mandate = eligible for 4-5 regardless of title — the building, equity, learning, and impact outweigh the title\n- A narrowly-scoped role at a generic small company with no building mandate = cap at 2-3, UNLESS narrow-and-hands-on is what the candidate says they want\n- Pure people-management or pure process-admin roles with no systems architecture or AI/building component = lower";

/**
 * The default AI-DRIVEN GTM TRANSFORMATION RULE block, heading included, up
 * to but excluding the aiGtmCompCarveOut() interpolation — domainBonusBlock
 * appends that separately so the carve-out still gates on compFloor even
 * when a tenant's domain bonus text is a full replacement of this one.
 */
export const DEFAULT_DOMAIN_BONUS = "AI-DRIVEN GTM TRANSFORMATION RULE (apply when all three are true):\n1. The company is an established B2B SaaS / RevTech / MarTech company (PE-backed, growth-stage, or public — not just a tiny startup)\n2. The role is explicitly framed as leading an AI transformation of GTM, RevOps, or Marketing Operations — building AI/agentic workflows into the revenue engine, not just \"uses AI\"\n3. The domain is within 1 degree of THE CANDIDATE's background as stated above (adjacent industry, adjacent function, or any vertical where the experience they describe transfers)\n→ When all three apply: floor score of 4. This is a mandate to define what AI means for the entire GTM/revenue motion — exactly the kind of mandate the candidate describes wanting.\n→ If the domain requires deep vertical expertise the candidate does not claim (pharma, clinical, hardware, heavy regulatory): stay at 3. Real upside but execution risk is high — they would spend year 1 learning the domain rather than building.";

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
2 = Weak fit — ${inputs.weakFitTail}
3 = Moderate fit — ${inputs.moderateTail}
4 = Strong fit — ${inputs.strongTail}
5 = Exceptional fit — almost tailor-made: the function, the level, and the company type the candidate states they are targeting, all at once${compScoringClause(inputs.compFloor)}

SENIORITY IS RELATIVE TO THE CANDIDATE, NEVER ABSOLUTE: judge level against what
the candidate says they want, not against a fixed ladder. A hands-on IC role is a
5 for someone who states they want to stay hands-on, and a 2 for someone
targeting a VP seat. Do NOT deduct for a role being "only" IC or manager level
unless the candidate asked for something more senior.${titleScopeBlock(inputs.titleScope)}

FINANCIAL SIGNALS — UPWARD ONLY, and only if the candidate cares:
These describe company stage, equity and liquidity. Apply them ONLY to the extent
the candidate's own words reference caring about company stage, equity, growth or
exit. If the candidate never mentions those things, treat company financials as
NEUTRAL and score on function, level and domain alone.
- High ARR ($100M+) with a clear exit signal (PE exit, IPO path) = strong upward signal — equity likely meaningful, role has real scope
- PE-backed with exit planned = structured liquidity event coming, high upside if the fit is there — bump score +0.5 if other signals are strong
- Top-tier backer (a16z, Sequoia, Benchmark, General Catalyst, etc.) = legitimacy signal, bump slightly
- Very high ARR ($500M+) at a PE-backed company heading to exit = rare opportunity signal, weight positively
- ABSENCE OF THIS DATA IS NOT A DEDUCTION. Unknown backer, unknown ARR, unlisted
  stage, or no AI/transformation mandate must NEVER lower a score or cap it below
  what the function, level and domain fit earn on their own. Most postings do not
  publish financials; treating silence as a negative would cap every role at a
  company that simply did not say. Say nothing about it in the rationale rather
  than citing it as a reason.${domainBonusBlock(inputs.domainBonus, inputs.compFloor)}

Return a JSON object with:
- score (integer 1-5)
- rationale (string, 1-2 blunt sentences explaining the score)

Return ONLY the JSON object.`;
}
