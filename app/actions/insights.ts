"use server";

import { requireActor } from "@/lib/require-actor";

import { callWithWebSearch, parseJson } from "@/lib/anthropic";
import { cacheWriteWarning } from "@/lib/cache-write-warning";
import { UNDESCRIBED_DB_ERROR } from "@/lib/write-failure";
import { supabase } from "@/lib/supabase";
import type { Insights } from "@/lib/types";

const SYSTEM =
  "You are a go-to-market and revenue operations career coach. Analyze this person's tracked job pipeline and the current market for GTM Systems, RevOps, Marketing Operations, and GTM/AI Operations roles at B2B SaaS and AI companies. Return ONLY valid JSON, no markdown.";

export async function getCachedInsights(): Promise<{
  insights?: Insights;
  fetchedAt?: string;
  error?: string;
}> {
  // Session required. Server Actions are RPC endpoints addressed by an ID that
  // ships in the client bundle, so a page-level check does not cover them.
  await requireActor();
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
  // Session required. Server Actions are RPC endpoints addressed by an ID that
  // ships in the client bundle, so a page-level check does not cover them.
  await requireActor();
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
    //
    // Both results were discarded. This is the priciest single call in the app
    // (a web search plus the entire pipeline as prompt input), and a failed
    // cache write meant the next visit re-ran all of it silently.
    //
    // The delete's failure is reported too, not just the insert's — but with
    // its OWN message, since the consequences differ entirely (see below).
    // `.neq("id", <sentinel>)` is sound here: insights_cache.id is a non-null
    // uuid primary key, so `id <> '000…'` matches every real row. It is NOT
    // the `<> NULL` bug.
    const { error: deleteError } = await supabase
      .from("insights_cache")
      .delete()
      .neq("id", "00000000-0000-0000-0000-000000000000");
    const { error: insertError } = await supabase.from("insights_cache").insert({
      insights,
      fetched_at: new Date().toISOString(),
    });

    // The two failures have DIFFERENT consequences and must not share a
    // message. Reporting a delete-only failure with the re-bill warning was
    // simply untrue: the insert landed, so the next visit is served from cache
    // and nothing is re-billed. The real damage is the row that did not get
    // cleared.
    if (insertError) {
      // Nothing was cached, so the next visit re-runs all of it — this is the
      // case the re-bill warning describes.
      const warning = cacheWriteWarning({
        produced: "The pipeline analysis finished",
        table: "insights_cache",
        error: insertError.message,
      });
      console.error(`analyzePipeline: ${warning}`);
      // On `error`, alongside the insights: Insights' run() sets the banner and
      // still renders `res.insights`, so the analysis the user paid for stays
      // on screen.
      return { insights, error: warning };
    }

    if (deleteError) {
      // The new row IS cached and will be served — `order by fetched_at desc
      // limit 1` picks it. But the old rows survived, so insights_cache now
      // grows by one row per analysis, invisibly, until something counts them.
      const warning =
        `The analysis was saved, but clearing the previous insights_cache rows failed — ` +
        `${deleteError.message || UNDESCRIBED_DB_ERROR}. Nothing is lost and nothing will be ` +
        `re-billed: the newest row is the one served. The stale rows just accumulate, one ` +
        `per analysis, until they are cleared by hand.`;
      console.error(`analyzePipeline: ${warning}`);
      return { insights, error: warning };
    }

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
