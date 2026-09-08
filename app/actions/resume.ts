// app/actions/resume.ts
"use server";

import { requireResumeAdmin } from "@/lib/require-resume-admin";
import { withBudget } from "@/lib/metered";
import { complete, parseJson } from "@/lib/model-call";
import { supabase } from "@/lib/supabase";
import { hasPostingBeenRead, type PostingDetail } from "@/lib/posting-detail";
import { describeWriteFailure } from "@/lib/write-failure";
import { buildThemePrompt, type JobSummaryFields } from "@/lib/resume-prompt";
import { effectiveCareer } from "@/lib/effective-career";
import { effectiveDocument } from "@/lib/effective-document";
import { coverageReport, type CoverageReport } from "@/lib/resume-coverage";
import { careerOverlayFrom, readAllSettingsResult } from "@/lib/settings-store";
import type { ResumeOverrides } from "@/lib/resume-overrides";
import {
  selectBullets,
  type CareerRecord,
  type ResumeSelection,
  type ThemeVocabulary,
} from "@/lib/resume-render/render";
import career from "@/lib/resume-render/content/resume.json";
import themeVocabulary from "@/lib/resume-render/content/themes.json";

// Re-exported for existing consumers — the type itself lives in
// lib/resume-overrides.ts. See that file's header for why: lib/resume-ops.ts
// (Task 10) must import it too, and a lib module importing a type from a
// "use server" file is fragile — the directive forbids non-async exports, and
// the import direction becomes load-bearing for a type erased at compile time.
export type { ResumeOverrides } from "@/lib/resume-overrides";

interface JobRow {
  role_title: string;
  company: string;
  key_skills: string | null;
  fit_summary: string | null;
  seniority: string | null;
  department: string | null;
  salary_range: string | null;
  company_description: string | null;
  posting: PostingDetail | null;
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
        // `posting` is why this list changed: the JD was stored by migration 017 and
    // read by ingest and the backfill, and this select is where it stopped —
    // every tailored résumé to date was themed without it.
    .select(
      "role_title, company, key_skills, fit_summary, seniority, department, salary_range, company_description, posting"
    )
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
    // `?? null` then default: a row stored before the column exists arrives
    // without the key at all, the same defensive read never_live carries.
    requirements: (job.posting ?? null)?.requirements ?? [],
    niceToHaves: (job.posting ?? null)?.niceToHaves ?? [],
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
 * The return shape distinguishes two cases that used to collapse onto the
 * same `[]`: the model call itself FAILING (auth, network, rate limit, an
 * unparseable response — caught below, `failed` set) versus the model running
 * successfully and legitimately finding no matching themes (a real, if
 * unfocused, `{ themes: [] }` result — `selectBullets()` handles that fine,
 * there is no unsafe state for it to produce, unlike a fit score computed
 * from an empty brain). Only the caller (`tailorResumeForJob`) gets to decide
 * what a failure means for the tailored-resume row; this function's job is
 * only to say, truthfully, whether the call happened.
 */
async function deriveThemes(job: JobSummaryFields): Promise<{ themes: string[]; failed?: string }> {
  try {
    const { system, prompt } = buildThemePrompt(job, themeVocabulary as ThemeVocabulary);
    const raw = await complete({ system, prompt, maxTokens: 500 });
    const parsed = parseJson<ThemeResponse>(raw);
    const validIds = new Set((themeVocabulary as ThemeVocabulary).themes.map((t) => t.id));
    const themes = Array.isArray(parsed.themes) ? parsed.themes.filter((id) => validIds.has(id)) : [];
    return { themes };
  } catch (err) {
    // The real error is logged, and logged is the only place it goes — same
    // closed-set rule as scoreFitInner: SDK error text can embed the request
    // URL and sometimes the key itself, so it may never reach the browser.
    console.error("deriveThemes error:", err);
    return { themes: [], failed: "Failed to tailor resume." };
  }
}

export async function tailorResumeForJob(
  jobId: string
): Promise<{
  career?: CareerRecord;
  themes: string[];
  selection: ResumeSelection | null;
  /**
   * Always `{}`: Regenerate replaces `tailored_resumes.content` with no
   * `overrides` key, discarding whatever design/text/selection retuning the
   * chat agent (Task 10) had written for the previous version. Returned (not
   * omitted) so the caller can reset its own state to match what was saved.
   */
  overrides: ResumeOverrides;
  coverage: CoverageReport | null;
  warnings: string[];
  /**
   * Nobody has read this posting, so the themes came from the title, the
   * seniority and the app's own fit summary rather than from what the employer
   * asked for. A WARNING, never a refusal: the user can see the posting in a
   * browser, and withholding the document helps nobody — but a tailored résumé
   * that silently guessed is worse than one that says it guessed.
   */
  unread?: boolean;
  error?: string;
}> {
  const actor = await requireResumeAdmin();

  const { job, error: loadError } = await loadJobForTenant(actor.tenantId, jobId);
  if (loadError) {
    return { themes: [], selection: null, overrides: {}, coverage: null, warnings: [], error: loadError };
  }
  if (!job) {
    return {
      themes: [],
      selection: null,
      overrides: {},
      coverage: null,
      warnings: [],
      error: "Could not find that job",
    };
  }

  // Read before billing: a settings-read failure is a reason to stop, not a
  // reason to spend on a call whose result would render against the wrong
  // record anyway.
  const rowsResult = await readAllSettingsResult();
  if (rowsResult.error !== undefined) {
    return {
      themes: [],
      selection: null,
      overrides: {},
      coverage: null,
      warnings: [],
      error: rowsResult.error,
    };
  }
  const overlay = careerOverlayFrom(rowsResult.rows);

  const budget = await withBudget({
    action: "tailor-resume",
    estimateCents: 1,
    isAdmin: actor.isAdmin,
    fn: () => deriveThemes(toSummaryFields(job)),
  });
  if (budget.capped) {
    return { themes: [], selection: null, overrides: {}, coverage: null, warnings: [], error: budget.capped };
  }
  if (budget.error !== undefined) {
    return { themes: [], selection: null, overrides: {}, coverage: null, warnings: [], error: budget.error };
  }

  // The model call itself failed (auth, network, rate limit, unparseable
  // response) — distinct from a successful call that legitimately found no
  // themes. Tokens were still billed (reconciliation runs regardless of `fn`'s
  // outcome), but nothing may be written to tailored_resumes: doing so would
  // store a row that LOOKS like a completed tailoring with an empty selection,
  // and the "Tailor" button would simply not reappear with no signal to the
  // user that anything went wrong.
  if (budget.result!.failed !== undefined) {
    return {
      themes: [],
      selection: null,
      overrides: {},
      coverage: null,
      warnings: [],
      error: budget.result!.failed,
    };
  }

  const themes = budget.result!.themes;
  // Regenerate is a fresh start: no text overrides (those live only in the
  // per-job overrides this call discards), just the standing overlay bullets.
  const { career: merged, warnings } = effectiveCareer(career as CareerRecord, overlay, {});
  const selection = selectBullets(merged, { themes });
  const coverage = coverageReport(merged, themes, selection, themeVocabulary as ThemeVocabulary);
  const unread = !hasPostingBeenRead(job);

  const { error } = await supabase
    .forTenant(actor.tenantId)
    .from("tailored_resumes")
    .upsert(
      { job_id: jobId, content: { themes, selection }, generated_at: new Date().toISOString() },
      { onConflict: "tenant_id,job_id" }
    );
  const described = describeWriteFailure(error ? error.message : undefined, "save that tailored resume");
  if (described !== undefined) {
    return {
      career: merged,
      themes,
      selection,
      overrides: {},
      coverage,
      warnings,
      unread,
      error: described,
    };
  }

  return { career: merged, themes, selection, overrides: {}, coverage, warnings, unread };
}

export async function getTailoredResume(jobId: string): Promise<{
  themes: string[];
  selection: ResumeSelection | null;
  overrides: ResumeOverrides;
  error?: string;
}> {
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
    return {
      themes: [],
      selection: null,
      overrides: {},
      error: describeWriteFailure(error.message, "load that tailored resume"),
    };
  }
  if (!data) return { themes: [], selection: null, overrides: {} };

  // A row written before `overrides` existed has no such key — normal, never
  // an error, so it defaults to `{}` rather than being flagged.
  const content = (data as {
    content: { themes: string[]; selection: ResumeSelection; overrides?: ResumeOverrides };
  }).content;
  return { themes: content.themes, selection: content.selection, overrides: content.overrides || {} };
}

/**
 * Everything the tailor screen needs, resolved server-side against ONE record.
 *
 * The career record must not be imported statically by the page any more: an
 * overlay bullet or a text override the server scored would not exist in the
 * client's copy, and render.js:145-146 drops unknown ids silently and the whole
 * role when nothing survives.
 */
export async function loadResumeContext(jobId: string): Promise<{
  career?: CareerRecord;
  themes: string[];
  /** The EFFECTIVE selection — the stored base with every override applied. */
  selection: ResumeSelection | null;
  /**
   * The stored, UNMERGED base. Returned because app/actions/resume-chat.ts
   * has to write it back unchanged (or replace it wholesale when a turn
   * changes the themes) — deriving it from `selection` is impossible once
   * overrides have been folded in, and re-reading the row there would be a
   * second query for a value this call already has.
   */
  baseSelection: ResumeSelection | null;
  overrides: ResumeOverrides;
  coverage: CoverageReport | null;
  warnings: string[];
  error?: string;
}> {
  await requireResumeAdmin();
  const rowsResult = await readAllSettingsResult();
  if (rowsResult.error !== undefined) {
    // readAllSettingsResult is a TRANSPORT — it returns the driver's message
    // verbatim, empty string included (an unreachable dual-stack host rejects
    // with an AggregateError whose message is ""). The consumer here is a
    // SERVER COMPONENT (app/resume/page.tsx) that prints this raw with no
    // `|| UNDESCRIBED_DB_ERROR` fallback of its own, so an undescribed error
    // renders as an empty amber paragraph and no document. Presence detection
    // is unaffected: describeWriteFailure returns string | undefined.
    return {
      themes: [],
      selection: null,
      overrides: {},
      coverage: null,
      warnings: [],
      baseSelection: null,
      error: describeWriteFailure(rowsResult.error, "load your settings"),
    };
  }
  const overlay = careerOverlayFrom(rowsResult.rows);

  const stored = await getTailoredResume(jobId);
  if (stored.error !== undefined) {
    return {
      themes: [],
      selection: null,
      baseSelection: null,
      overrides: {},
      coverage: null,
      warnings: [],
      error: stored.error,
    };
  }

  const overrides = stored.overrides;
  const { career: merged, warnings } = effectiveCareer(
    career as CareerRecord,
    overlay,
    overrides.text || {}
  );
  // Base plus every override this job carries — ONE definition, shared with
  // app/actions/resume-chat.ts's sendChatTurn, in lib/effective-document.ts.
  // Without this, a page reload after a chat edit would show the STALE
  // unmerged selection and coverage computed from it — the exact document the
  // chat turn just changed would revert on refresh until the next turn or a
  // Regenerate — and taper/lead/compressAfter would reach no renderer at all.
  const doc = stored.selection
    ? effectiveDocument(merged, stored.selection, stored.themes, overrides)
    : null;
  const coverage = doc
    ? coverageReport(doc.career, stored.themes, doc.selection, themeVocabulary as ThemeVocabulary)
    : null;

  return {
    // doc.career, not `merged`: a set_compress_after override is applied to
    // the RECORD (rules.compressAfter), which is what renderBody and
    // coverageReport's renderedRoles both read. Returning the unshaped record
    // would render a document the coverage panel does not describe.
    career: doc ? doc.career : merged,
    themes: stored.themes,
    selection: doc ? doc.selection : null,
    baseSelection: stored.selection,
    overrides,
    coverage,
    warnings,
  };
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
