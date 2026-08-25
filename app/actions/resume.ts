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

async function loadJobForTenant(tenantId: string, jobId: string): Promise<JobRow | null> {
  const { data, error } = await supabase
    .forTenant(tenantId)
    .from("jobs")
    .select("role_title, company, key_skills, fit_summary, seniority, department, salary_range, company_description")
    .eq("id", jobId)
    .maybeSingle();
  if (error) {
    console.error("loadJobForTenant error:", error);
    return null;
  }
  return (data as JobRow | null) ?? null;
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

async function deriveThemes(job: JobSummaryFields): Promise<string[]> {
  const { system, prompt } = buildThemePrompt(job, themeVocabulary as ThemeVocabulary);
  const raw = await complete({ system, prompt, maxTokens: 500 });
  const parsed = parseJson<ThemeResponse>(raw);
  const validIds = new Set((themeVocabulary as ThemeVocabulary).themes.map((t) => t.id));
  return Array.isArray(parsed.themes) ? parsed.themes.filter((id) => validIds.has(id)) : [];
}

export async function tailorResumeForJob(
  jobId: string
): Promise<{ themes: string[]; selection: ResumeSelection | null; error?: string }> {
  const actor = await requireResumeAdmin();

  const job = await loadJobForTenant(actor.tenantId, jobId);
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
    return { themes: [], selection: null, error: error.message };
  }
  if (!data) return { themes: [], selection: null };

  const content = (data as { content: { themes: string[]; selection: ResumeSelection } }).content;
  return { themes: content.themes, selection: content.selection };
}

/**
 * Just enough of a tracked job to show as context on /resume?jobId=... —
 * the base spec requires the target job's title and company be shown there.
 * Reuses loadJobForTenant rather than a second query shape.
 */
export async function getJobContext(
  jobId: string
): Promise<{ roleTitle: string; company: string } | null> {
  const actor = await requireResumeAdmin();
  const job = await loadJobForTenant(actor.tenantId, jobId);
  if (!job) return null;
  return { roleTitle: job.role_title, company: job.company };
}
