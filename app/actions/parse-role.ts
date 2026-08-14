"use server";

import { callWithWebSearch, anthropic, MODEL, parseJson } from "@/lib/anthropic";
import type { FitInputs } from "@/lib/fit-inputs";
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
      error: err instanceof Error ? err.message : "Failed to parse role details.",
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
    return {
      error: err instanceof Error ? err.message : "Failed to parse job URL.",
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
 */
export async function scoreFit(opts: {
  company: string;
  role_title: string;
  company_description: string;
  key_skills: string;
  fit_summary: string;
  department: string;
  location: string;
  arr?: string;
  exit_signal?: string;
  backer?: string;
  fitInputs: FitInputs | null;
}): Promise<{ score: number; rationale: string; error?: string }> {
  try {
    const { fitBrain } = opts.fitInputs ?? (await loadScoringInputs());
    const message = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 500,
      system:
        "You are a ruthless career coach scoring job fit for a specific candidate. Be honest and harsh — most roles should score 2-3. Only give 4-5 for genuinely strong matches. A 5 is rare. Return ONLY valid JSON.",
      messages: [
        {
          role: "user",
          content: `Score how well this role fits this candidate on a scale of 1-5. Be ruthless.

CANDIDATE:
${fitBrain}

ROLE:
Company: ${opts.company}
Company description: ${opts.company_description}
Title: ${opts.role_title}
Department: ${opts.department}
Location: ${opts.location}
ARR: ${opts.arr || "unknown"}
Backer / investor: ${opts.backer || "unknown"}
Exit signal: ${opts.exit_signal || "none mentioned"}
Key skills required: ${opts.key_skills}
Summary: ${opts.fit_summary}

SCORING GUIDE:
1 = Poor fit — wrong industry, no relevant overlap, or clearly too junior/unrelated
2 = Weak fit — some domain overlap but significant gaps, or a narrow ops/IC role with no systems-building or strategic scope
3 = Moderate fit — relevant domain and background but a standard ops/manager role without broad ownership, systems architecture, or AI/building upside
4 = Strong fit — clear domain alignment AND (broad ownership across the GTM/RevOps stack, lead/principal/head-level scope, hands-on GTM systems + AI/agentic building, or explicit cross-functional leadership even without a VP title)
5 = Exceptional fit — almost tailor-made: Head/VP/Director-level GTM Systems / RevOps / Marketing Ops / GTM-AI title at a B2B SaaS company where the domain is a direct match, OR a GTM Engineer / AI-Ops builder role with broad mandate at a strong company

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
→ If the domain requires deep vertical expertise Tom lacks (pharma, clinical, hardware, heavy regulatory): stay at 3. Real upside but execution risk is high — he'd spend year 1 learning the domain rather than building.

Return a JSON object with:
- score (integer 1-5)
- rationale (string, 1-2 blunt sentences explaining the score)

Return ONLY the JSON object.`,
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
