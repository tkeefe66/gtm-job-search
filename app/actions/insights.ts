"use server";

import { callWithWebSearch, parseJson } from "@/lib/anthropic";
import { supabase } from "@/lib/supabase";
import type { Insights } from "@/lib/types";

const SYSTEM =
  "You are a product leadership career coach. Analyze this person's tracked job pipeline and the current market for product roles at AI startups. Return ONLY valid JSON, no markdown.";

export async function analyzePipeline(): Promise<{
  insights?: Insights;
  error?: string;
}> {
  try {
    const { data, error } = await supabase
      .from("jobs")
      .select(
        "company, role_title, seniority, category, traction, fit_summary, notes"
      );

    if (error) throw new Error(error.message);

    const pipeline = data ?? [];
    if (pipeline.length === 0) {
      return {
        error:
          "No jobs in your pipeline yet. Add some roles from Discover or Tracker first.",
      };
    }

    const prompt = `Here is my tracked job pipeline as JSON:\n${JSON.stringify(
      pipeline,
      null,
      2
    )}\n\nAlso research what product skills are most in demand at AI-first companies right now. Then analyze my pipeline against the current market. Return a JSON object with these exact fields: top_skills_in_demand (array of strings), common_themes (array of strings), gap_analysis (string, 2-3 sentences on what the market wants vs what a B2B SaaS AI product VP typically brings), positioning_advice (string, 2-3 sentences on how to position for these roles), company_archetypes (array of objects with archetype, description, example_companies array), recommended_next_searches (array of strings — company names or categories to search next). Return ONLY the JSON object.`;

    const raw = await callWithWebSearch({
      system: SYSTEM,
      prompt,
      maxTokens: 2500,
    });

    const insights = parseJson<Insights>(raw);
    return { insights };
  } catch (err) {
    console.error("analyzePipeline error:", err);
    return {
      error:
        err instanceof Error
          ? err.message
          : "Failed to analyze pipeline.",
    };
  }
}
