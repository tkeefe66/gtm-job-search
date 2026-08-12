"use server";

import { callWithWebSearch, parseJson } from "@/lib/anthropic";
import { supabase } from "@/lib/supabase";
import type { Insights } from "@/lib/types";

const SYSTEM =
  "You are a go-to-market and revenue operations career coach. Analyze this person's tracked job pipeline and the current market for GTM Systems, RevOps, Marketing Operations, and GTM/AI Operations roles at B2B SaaS and AI companies. Return ONLY valid JSON, no markdown.";

export async function getCachedInsights(): Promise<{
  insights?: Insights;
  fetchedAt?: string;
  error?: string;
}> {
  const { data, error } = await supabase
    .from("insights_cache")
    .select("insights, fetched_at")
    .order("fetched_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) return { error: error.message };
  if (!data) return {};
  return { insights: data.insights as Insights, fetchedAt: data.fetched_at };
}

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
          "No jobs in your pipeline yet. Add some roles from Discover first.",
      };
    }

    const prompt = `Here is my tracked job pipeline as JSON:\n${JSON.stringify(
      pipeline,
      null,
      2
    )}\n\nAlso research what GTM systems, revenue operations, marketing operations, and GTM/AI operations skills are most in demand at B2B SaaS and AI-first companies right now. Then analyze my pipeline against the current market. Return a JSON object with these exact fields: top_skills_in_demand (array of strings), common_themes (array of strings), gap_analysis (string, 2-3 sentences on what the market wants vs what a senior GTM Systems / RevOps / Marketing Ops leader and AI practitioner-builder typically brings), positioning_advice (string, 2-3 sentences on how to position for these roles), company_archetypes (array of objects with archetype, description, example_companies array), recommended_next_searches (array of strings — company names or categories to search next). Return ONLY the JSON object.`;

    const raw = await callWithWebSearch({
      system: SYSTEM,
      prompt,
      maxTokens: 2500,
    });

    const insights = parseJson<Insights>(raw);

    // Persist to cache — delete old, insert new.
    await supabase.from("insights_cache").delete().neq("id", "00000000-0000-0000-0000-000000000000");
    await supabase.from("insights_cache").insert({
      insights,
      fetched_at: new Date().toISOString(),
    });

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
