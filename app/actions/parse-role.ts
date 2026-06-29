"use server";

import { callWithWebSearch, anthropic, MODEL, parseJson } from "@/lib/anthropic";

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
- ic_flag (boolean — true ONLY when ALL of these are true: (1) the role is IC-level with no people management, meaning a PM or Senior PM title, AND (2) there is a clear signal the product function is early or nascent, such as "founding PM", "first PM", "building the product function", "nascent product team", "you'll define what product looks like here", or very few PMs suggesting a leadership vacuum. The logic: this is an IC role you might apply to as a foot in the door to a future leadership role. Set to false for VP/Director/Head roles and IC roles at mature product orgs with no leadership upside signal)
- fit_summary (string, 1-2 sentences on what makes this role interesting for a VP of Product with B2B SaaS and AI background)
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

// Chad's background used for ruthless fit scoring.
const CHAD_BACKGROUND = `
Chad Holdorf is a VP of Product / CPO-level candidate with this background:
- 10+ years in B2B SaaS product leadership (VP/CPO level)
- Deep experience: Demandbase (AI-powered ABM platform), Salesforce (SDK, Hyperforce, developer platform)
- Expertise: AI/agentic products, developer platforms, enterprise B2B SaaS, multi-agent systems, platform integrations
- Strong: go-to-market, 0-to-1 product builds, technical PM work with engineers and researchers
- Weaker fit: pure consumer products, hardware, non-tech industries, roles that don't need a senior leader
- Looking for: VP of Product, CPO, Head of Product, Director of Product at AI-first or B2B SaaS companies
- Open to IC PM roles at elite AI-first companies (Anthropic, OpenAI, Google DeepMind, Cursor, Mistral, Cohere, etc.) or hyper-growth AI startups where the equity, impact, and learning opportunity outweigh the title — this is the new reality for senior PMs in AI
`.trim();

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
}): Promise<{ score: number; rationale: string; error?: string }> {
  try {
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
${CHAD_BACKGROUND}

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
2 = Weak fit — some domain overlap but significant gaps, or a narrow IC PM role with no strategic scope
3 = Moderate fit — relevant domain and background but a standard PM role without broad ownership or leadership scope
4 = Strong fit — clear domain alignment AND (broad ownership across multiple surfaces, lead/principal/head-level scope, or explicit cross-functional leadership even without a VP title)
5 = Exceptional fit — almost tailor-made: VP/CPO/Head-level title OR a lead role with VP-equivalent scope at a company where the domain is a direct match

TITLE SCOPE SIGNALS (use these to adjust score):
- "Core", "Lead", "Principal", "Head of", "Staff" in the title = broader scope, score higher than a standard PM
- "VP of Product", "CPO", "Director" = leadership level, eligible for 4-5 if domain matches
- IC PM roles at elite AI-first companies (Anthropic, OpenAI, Google DeepMind, Cursor, Cohere, Mistral, etc.) = eligible for 4-5 regardless of title — top execs are taking IC roles at these companies because the equity, learning, and impact outweigh the title. This is the new world of PM. Score these on company tier + domain fit, not title.
- IC PM roles at hyper-growth AI startups (Series B+ with clear AI-first trajectory and strong domain alignment) = eligible for 3-4, not capped at 2
- "Product Manager - [specific feature]" at a generic SaaS company with no AI angle = narrow IC scope, cap at 2-3

FINANCIAL SIGNALS (use these to adjust score up or down):
- High ARR ($100M+) with a clear exit signal (PE exit, IPO path) = strong upward signal — equity likely meaningful, role has real scope
- PE-backed with exit planned = structured liquidity event coming, high upside if the fit is there — bump score +0.5 if other signals are strong
- Top-tier backer (a16z, Sequoia, Benchmark, General Catalyst, etc.) = legitimacy signal, bump slightly
- Unknown backer or pre-revenue = neutral, don't penalize unless other signals are weak
- Very high ARR ($500M+) at a PE-backed company heading to exit = rare opportunity signal, weight positively

PE-BACKED LEGACY AI PIVOT RULE (apply when all three are true):
1. The company is PE-backed or PE-acquired (established, not a startup)
2. The role is explicitly framed as leading an AI transformation, AI initiative, or AI pivot (not just "uses AI")
3. The domain is within 1 degree of Chad's background (enterprise B2B SaaS, GTM tech, developer tools, data platforms, FinTech, or any software vertical where his SaaS leadership transfers)
→ When all three apply: floor score of 4. This is a CPO-equivalent mandate regardless of title — you walk in defining what AI means for the whole product. The PE exit signal means equity upside is structured and coming.
→ If the domain requires deep vertical expertise Chad lacks (pharma, LIMS, clinical, hardware): stay at 3. Real equity upside but execution risk is high — he'd spend year 1 learning the domain rather than building.

Return a JSON object with:
- score (integer 1-5)
- rationale (string, 1-2 blunt sentences explaining the score)

Return ONLY the JSON object.`,
        },
      ],
    });

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
