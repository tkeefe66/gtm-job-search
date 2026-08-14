"use server";

import { callWithWebSearch, anthropic, MODEL, parseJson } from "@/lib/anthropic";
import type { FitInputs } from "@/lib/fit-inputs";
import { buildFitPrompt, type FitPromptRole } from "@/lib/fit-prompt";
import { loadScoringInputs } from "@/lib/search-criteria";
import { report } from "@/lib/usage.js";

export interface ParsedRole {
  company: string;
  role_title: string;
  location: string;
  salary_range: string;
  department: string;
  job_url: string;
  company_url: string;
  company_description: string;
  stage: string;
  category: string;
  arr: string;
  exit_signal: string;
  backer: string;
  ic_flag: boolean;
  fit_summary: string;
  key_skills: string;
  recruiter_name: string;
  recruiter_email: string;
  recruiter_company: string;
}

export async function parseRecruiterText(
  text: string
): Promise<{ role?: ParsedRole; error?: string }> {
  try {
    const raw = await callWithWebSearch({
      system:
        "You are a recruiting assistant with web search access. Extract structured job and recruiter details from pasted text, then search the web to find the hiring company's website and a short description of what they do. Return ONLY valid JSON, no markdown, no preamble.",
      prompt: `Extract all details from this recruiter message or job description, then search the web for the hiring company to find their website URL and a short description.

Return a JSON object with these exact fields:
- company (string, the hiring company name or empty)
- role_title (string, job title or empty)
- location (string, city/remote/hybrid or empty)
- salary_range (string, any salary or compensation info mentioned or empty)
- department (string, team or department or empty)
- job_url (string, any job listing URL found in the text or empty)
- company_url (string, the hiring company's main website URL found via web search or empty)
- company_description (string, 1-2 sentence description of what the hiring company does, from their website or web search)
- stage (string, funding stage or ownership type: e.g. "Series B", "PE-backed", "Public" — or empty if unknown)
- category (string, industry or sector: e.g. "AI Infra", "FinTech", "Vertical SaaS" — or empty if unknown)
- arr (string, annual recurring revenue if mentioned or found via web search: e.g. "$380M+ ARR" — or empty)
- exit_signal (string, any mention of exit plans, IPO path, acquisition interest, or liquidity event: e.g. "PE exit planned", "IPO path", "M&A target" — or empty)
- backer (string, key investor or PE firm backing the company: e.g. "Centerbridge Partners", "a16z", "Sequoia" — or empty)
- ic_flag (boolean — true when the role is an IC / hands-on practitioner role (e.g. GTM Engineer, RevOps or Marketing Ops IC, AI-Ops / automation engineer) that is still worth applying to because it centers on building GTM systems and agentic AI workflows, OR because the function is early/nascent and you'd define it from scratch — i.e. a builder role worth applying to regardless of the IC title. Set to false for standard leadership roles and for narrow IC roles at mature orgs with no systems/AI-building upside)
- fit_summary (string, 1-2 sentences on what makes this role interesting for a GTM Systems / RevOps / Marketing Ops leader and AI practitioner-builder)
- key_skills (string, comma-separated list of skills mentioned)
- recruiter_name (string, the name of the recruiter or person who sent this message or empty)
- recruiter_email (string, any email address belonging to the recruiter or empty)
- recruiter_company (string, the recruiter's agency or staffing firm — NOT the hiring company — or empty)

If a field is not present or not found, use an empty string. Return ONLY the JSON object.

Text to parse:
${text}`,
      maxTokens: 1500,
    });

    const role = parseJson<ParsedRole>(raw);
    return { role };
  } catch (err) {
    console.error("parseRecruiterText error:", err);
    return {
      // `|| `, not a bare `err.message` — the same empty-message case as
      // parseJobUrl below, read by components/RecruiterPanel.tsx.
      error:
        (err instanceof Error ? err.message : "") ||
        "Failed to parse role details.",
    };
  }
}

export async function parseJobUrl(
  url: string
): Promise<{ role?: ParsedRole; error?: string }> {
  try {
    const raw = await callWithWebSearch({
      system:
        "You are a recruiting assistant with web search access. Fetch the job posting at the given URL, extract all structured details, then search the web for additional company information. Return ONLY valid JSON, no markdown, no preamble.",
      prompt: `Fetch and parse this job posting URL: ${url}

Extract all details from the page, then search the web for the hiring company to find their website, funding stage, ARR, and backers.

Return a JSON object with these exact fields:
- company (string, the hiring company name)
- role_title (string, job title)
- location (string, city/remote/hybrid or empty)
- salary_range (string, any salary or compensation info on the page or empty)
- department (string, team or department or empty)
- job_url (string, use the URL provided: ${url})
- company_url (string, the hiring company's main website URL)
- company_description (string, 1-2 sentence description of what the hiring company does)
- stage (string, funding stage or ownership type: e.g. "Series B", "PE-backed", "Public" — or empty)
- category (string, industry or sector: e.g. "AI Infra", "FinTech", "Vertical SaaS" — or empty)
- arr (string, annual recurring revenue if found: e.g. "$380M+ ARR" — or empty)
- exit_signal (string, any exit plans, IPO path, or liquidity event — or empty)
- backer (string, key investor or PE firm — or empty)
- ic_flag (boolean — true when the role is an IC / hands-on practitioner role (e.g. GTM Engineer, RevOps or Marketing Ops IC, AI-Ops / automation engineer) worth applying to because it centers on building GTM systems and agentic AI workflows, or because the function is early/nascent and you'd define it from scratch. False for standard leadership roles and narrow IC roles at mature orgs with no systems/AI-building upside)
- fit_summary (string, 1-2 sentences on what makes this role interesting for a GTM Systems / RevOps / Marketing Ops leader and AI practitioner-builder)
- key_skills (string, comma-separated skills from the job posting)
- recruiter_name (string, empty)
- recruiter_email (string, empty)
- recruiter_company (string, empty)

Return ONLY the JSON object.`,
      maxTokens: 1500,
    });

    const role = parseJson<ParsedRole>(raw);
    return { role };
  } catch (err) {
    console.error("parseJobUrl error:", err);
    // `|| `, not a bare `err.message`: an Error can carry an empty message
    // (Node's AggregateError always does — see lib/write-failure.ts), and the
    // caller in components/RolesTable.tsx branches on `if (res.error)`. An
    // empty string there reads as a successful parse and advances the form to
    // an empty review step with nothing shown to explain it. The substitution
    // belongs here rather than at the call site because this is where the
    // failure is already being turned into user-facing text.
    return {
      error:
        (err instanceof Error ? err.message : "") || "Failed to parse job URL.",
    };
  }
}

/**
 * Scores a role against the candidate's background, 1-5, ruthlessly.
 *
 * `fitInputs` is a REQUIRED key whose value may be null. Omission would be
 * indistinguishable from "I meant the default", and the companion
 * compensation plan adds a money value to this same object where that
 * ambiguity becomes a real bug. Requiring the key forces every call site to
 * state its intent — omitting it is a compile error.
 *
 * `null` does NOT mean "use the shipped default": it means "load the user's
 * actual stored settings now", so a manually-added role is scored against the
 * edited fit brain. It exists for the two `"use client"` call sites
 * (components/RolesTable.tsx, components/RecruiterPanel.tsx) which cannot call
 * loadScoringInputs themselves — it transitively imports `pg`.
 *
 * Batch paths must always pass an explicit value. Letting the null fallback
 * fire inside a loop costs one settings read per scored row.
 *
 * The role half of `opts` is `FitPromptRole` (lib/fit-prompt.ts), which is
 * also where the prompt itself lives — pure, and therefore testable, which
 * nothing in this `"use server"` module can be. Spelling the parameter as that
 * interface rather than as a second inline copy is what keeps `ScoringArgs` in
 * lib/rescore-scope.ts (`Omit<Parameters<typeof scoreFit>[0], "fitInputs">`)
 * exact: a field added to the prompt shape breaks `scoringArgsFor` at compile
 * time instead of silently scoring rescored rows blind.
 */
export async function scoreFit(
  opts: FitPromptRole & { fitInputs: FitInputs | null }
): Promise<{ score: number; rationale: string; error?: string }> {
  try {
    const fitInputs = opts.fitInputs ?? (await loadScoringInputs());
    const message = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 500,
      system:
        "You are a ruthless career coach scoring job fit for a specific candidate. Be honest and harsh — most roles should score 2-3. Only give 4-5 for genuinely strong matches. A 5 is rare. Return ONLY valid JSON.",
      messages: [
        {
          role: "user",
          content: buildFitPrompt(opts, fitInputs),
        },
      ],
    });

    report("gtm-job-search", MODEL, message.usage);

    const raw = message.content
      .filter((b) => b.type === "text")
      .map((b) => (b as { type: "text"; text: string }).text)
      .join("");

    const result = parseJson<{ score: number; rationale: string }>(raw);
    return { score: Math.min(5, Math.max(1, Math.round(result.score))), rationale: result.rationale };
  } catch (err) {
    console.error("scoreFit error:", err);
    return { score: 0, rationale: "", error: err instanceof Error ? err.message : "Failed to score fit." };
  }
}
