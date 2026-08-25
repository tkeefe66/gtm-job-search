// app/actions/resume.ts
"use server";

import { requireActor } from "@/lib/require-actor";
import { withBudget } from "@/lib/metered";
import { complete, parseJson } from "@/lib/model-call";
import { supabase } from "@/lib/supabase";
import { describeWriteFailure } from "@/lib/write-failure";
import { buildThemePrompt, type JobSummaryFields } from "@/lib/resume-prompt";
import {
  selectBullets,
  type CareerRecord,
  type ResumeSelection,
  type ThemeVocabulary,
} from "@/lib/resume-render/render";
import career from "@/lib/resume-render/content/resume.json";
import themeVocabulary from "@/lib/resume-render/content/themes.json";

/**
 * Admin-only, checked SERVER-SIDE on every action — one shared function
 * rather than a hand-copy in each export, the exact failure mode
 * app/actions/auth-required.test.ts's own doc comment warns about ("a
 * hand-written check is one someone forgets when adding the 37th").
 * Mirrors app/actions/admin.ts's requireAdmin() exactly.
 */
async function requireResumeAdmin() {
  const actor = await requireActor();
  if (!actor.isAdmin) throw new Error("Not authorized");
  return actor;
}

interface JobRow {
  role_title: string;
  company: string;
  key_skills: string | null;
  fit_summary: string | null;
  seniority: string | null;
  department: string | null;
  salary_range: string | null;
  company_description: string | null;
}

/**
 * `error` is distinct from "no such row" — a DB failure and a genuine 404
 * used to collapse onto the same `null`, which made every caller report the
 * generic "Could not find that job" even when the real cause was a transient
 * DB outage. `describeWriteFailure` handles the empty-message AggregateError
 * case (an entirely unreachable database), same as every other write/read
 * path in this app.
 */
async function loadJobForTenant(
  tenantId: string,
  jobId: string
): Promise<{ job: JobRow | null; error?: string }> {
  const { data, error } = await supabase
    .forTenant(tenantId)
    .from("jobs")
    .select("role_title, company, key_skills, fit_summary, seniority, department, salary_range, company_description")
    .eq("id", jobId)
    .maybeSingle();
  if (error) {
    console.error("loadJobForTenant error:", error);
    return { job: null, error: describeWriteFailure(error.message, "load that job") };
  }
  return { job: (data as JobRow | null) ?? null };
}

function toSummaryFields(job: JobRow): JobSummaryFields {
  return {
    roleTitle: job.role_title,
    company: job.company,
    keySkills: job.key_skills,
    fitSummary: job.fit_summary,
    seniority: job.seniority,
    department: job.department,
    salaryRange: job.salary_range,
    companyDescription: job.company_description,
  };
}

interface ThemeResponse {
  themes: string[];
}

/**
 * Never throws. `deriveThemes` runs as `withBudget`'s `fn`, and `withBudget`
 * only catches its own `SearchUnavailableError` — anything else a `fn` throws
 * propagates straight out of `tailorResumeForJob` uncaught. `parseJson` throws
 * a raw `SyntaxError` (not a sentinel return) on unparseable model output, so
 * without this catch a malformed response would crash the action instead of
 * producing the `{error}` shape every caller expects — mirrors the catch in
 * `scoreFitInner` (app/actions/parse-role.ts), which the real SDK/parse error
 * is logged to and never returned from, since SDK error text can embed the
 * request URL and sometimes the key itself.
 *
 * Degrading to an empty theme list on failure, rather than surfacing an
 * `{error}`, is safe specifically here: `selectBullets()` still returns a
 * valid, if unfocused, selection from `{ themes: [] }` — there is no unsafe
 * state for an empty list to produce, unlike a fit score computed from an
 * empty brain.
 */
async function deriveThemes(job: JobSummaryFields): Promise<string[]> {
  try {
    const { system, prompt } = buildThemePrompt(job, themeVocabulary as ThemeVocabulary);
    const raw = await complete({ system, prompt, maxTokens: 500 });
    const parsed = parseJson<ThemeResponse>(raw);
    const validIds = new Set((themeVocabulary as ThemeVocabulary).themes.map((t) => t.id));
    return Array.isArray(parsed.themes) ? parsed.themes.filter((id) => validIds.has(id)) : [];
  } catch (err) {
    console.error("deriveThemes error:", err);
    return [];
  }
}

export async function tailorResumeForJob(
  jobId: string
): Promise<{ themes: string[]; selection: ResumeSelection | null; error?: string }> {
  const actor = await requireResumeAdmin();

  const { job, error: loadError } = await loadJobForTenant(actor.tenantId, jobId);
  if (loadError) return { themes: [], selection: null, error: loadError };
  if (!job) {
    return { themes: [], selection: null, error: "Could not find that job" };
  }

  const budget = await withBudget({
    action: "tailor-resume",
    estimateCents: 1,
    isAdmin: actor.isAdmin,
    fn: () => deriveThemes(toSummaryFields(job)),
  });
  if (budget.capped) return { themes: [], selection: null, error: budget.capped };
  if (budget.error !== undefined) return { themes: [], selection: null, error: budget.error };

  const themes = budget.result!;
  const selection = selectBullets(career as CareerRecord, { themes });

  const { error } = await supabase
    .forTenant(actor.tenantId)
    .from("tailored_resumes")
    .upsert({ tenant_id: actor.tenantId, job_id: jobId, content: { themes, selection } }, { onConflict: "tenant_id,job_id" });
  const described = describeWriteFailure(error ? error.message : undefined, "save that tailored resume");
  if (described !== undefined) return { themes, selection, error: described };

  return { themes, selection };
}

export async function getTailoredResume(
  jobId: string
): Promise<{ themes: string[]; selection: ResumeSelection | null; error?: string }> {
  const actor = await requireResumeAdmin();

  const { data, error } = await supabase
    .forTenant(actor.tenantId)
    .from("tailored_resumes")
    .select("content")
    .eq("job_id", jobId)
    .maybeSingle();
  if (error) {
    console.error("getTailoredResume error:", error);
    // Presence, not truthiness: an unreachable database's AggregateError has
    // message === "", which `describeWriteFailure` substitutes text for — a
    // bare `error.message` here would return `{error: ""}`, which every
    // caller's `if (result.error)` check reads as falsy, i.e. success.
    return { themes: [], selection: null, error: describeWriteFailure(error.message, "load that tailored resume") };
  }
  if (!data) return { themes: [], selection: null };

  const content = (data as { content: { themes: string[]; selection: ResumeSelection } }).content;
  return { themes: content.themes, selection: content.selection };
}

/**
 * Just enough of a tracked job to show as context on /resume?jobId=... —
 * the base spec requires the target job's title and company be shown there.
 * Reuses loadJobForTenant rather than a second query shape.
 *
 * `null` means "no such job" — a genuine 404, the caller's cue to render a
 * not-found state. A DB failure is NOT the same thing and must not render as
 * one: it comes back as `{ roleTitle: "", company: "", error }` instead, so a
 * caller that checks `.error` before treating an empty title as real can tell
 * "the database is down" from "this job doesn't exist."
 */
export async function getJobContext(
  jobId: string
): Promise<{ roleTitle: string; company: string; error?: string } | null> {
  const actor = await requireResumeAdmin();
  const { job, error } = await loadJobForTenant(actor.tenantId, jobId);
  if (error) return { roleTitle: "", company: "", error };
  if (!job) return null;
  return { roleTitle: job.role_title, company: job.company };
}
