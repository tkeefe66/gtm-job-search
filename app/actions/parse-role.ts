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
          content: `Extract job details from this recruiter message or job description. Return a JSON object with these exact fields: company (string, company name or empty), role_title (string, job title or empty), location (string, city/remote/hybrid or empty), salary_range (string, any salary info mentioned or empty), department (string, team or department or empty), job_url (string, any URL found or empty), fit_summary (string, 1-2 sentences on what makes this role interesting based on the description), key_skills (string, comma-separated list of skills mentioned). If a field is not mentioned, use an empty string.

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
