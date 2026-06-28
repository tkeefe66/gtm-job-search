"use server";

import { anthropic, MODEL, parseJson } from "@/lib/anthropic";

export interface ParsedRole {
  company: string;
  role_title: string;
  location: string;
  salary_range: string;
  department: string;
  job_url: string;
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
    const message = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 1000,
      system:
        "You are a recruiting assistant. Extract structured job details from recruiter messages, job descriptions, or any pasted text about a role. Return ONLY valid JSON, no markdown, no preamble.",
      messages: [
        {
          role: "user",
          content: `Extract all details from this recruiter message or job description. Return a JSON object with these exact fields:
- company (string, the hiring company name or empty)
- role_title (string, job title or empty)
- location (string, city/remote/hybrid or empty)
- salary_range (string, any salary or compensation info mentioned or empty)
- department (string, team or department or empty)
- job_url (string, any job listing URL found or empty)
- fit_summary (string, 1-2 sentences on what makes this role interesting)
- key_skills (string, comma-separated list of skills mentioned)
- recruiter_name (string, the name of the recruiter or person who sent this message or empty)
- recruiter_email (string, any email address belonging to the recruiter or empty)
- recruiter_company (string, the recruiter's agency or staffing firm name — NOT the hiring company — or empty)

If a field is not present, use an empty string. Return ONLY the JSON object.

Text to parse:
${text}`,
        },
      ],
    });

    const raw = message.content
      .filter((b) => b.type === "text")
      .map((b) => (b as { type: "text"; text: string }).text)
      .join("");

    const role = parseJson<ParsedRole>(raw);
    return { role };
  } catch (err) {
    console.error("parseRecruiterText error:", err);
    return {
      error: err instanceof Error ? err.message : "Failed to parse role details.",
    };
  }
}
