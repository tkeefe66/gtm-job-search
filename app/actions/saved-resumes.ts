// app/actions/saved-resumes.ts
"use server";

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { requireResumeAdmin } from "@/lib/require-resume-admin";
import { supabase, rawQuery } from "@/lib/supabase";
import { describeWriteFailure } from "@/lib/write-failure";
import { EXPIRED_PREDICATE, LIVE_PREDICATE, RETENTION_DAYS } from "@/lib/resume-retention";
import { TOKEN_CSS_FILES } from "@/lib/resume-download";
import { insertSavedRow } from "@/lib/saved-resume-insert";
import { savedRowToSummary, type SavedSummaryRow } from "@/lib/saved-resume-shape";
import type { SavedResume, SavedResumeSummary } from "@/lib/types";

interface SavedRow extends SavedSummaryRow {
  html?: string;
  design_version?: string;
  content?: unknown;
}

/**
 * Reads the draft's `content` server-side and writes a "save" row. `content`
 * is never accepted from the caller: the tailor screen holds the EFFECTIVE
 * selection (app/resume/page.tsx passes it to TailorPanel and discards
 * baseSelection), and storing that would double-apply every override on the
 * next effectiveDocument pass. tailored_resumes holds the BASE selection this
 * needs instead.
 */
export async function saveResumeFromDraft(input: {
  jobId: string;
  html: string;
  roleTitle: string;
  company: string;
  label?: string | null;
  allowDuplicate?: boolean;
  pageMargin?: string | null;
}): Promise<{ id?: string; duplicateOf?: string; error?: string }> {
  // FIRST statement, never inside a try — auth-required.test.ts asserts this
  // THROWS, and a top-level catch would turn it into a returned {error}.
  const actor = await requireResumeAdmin();

  const { data, error } = await rawQuery<{ content: unknown }>(
    "select content from tailored_resumes where tenant_id = $1 and job_id = $2",
    [actor.tenantId, input.jobId],
    actor.tenantId
  );
  const described = describeWriteFailure(
    error ? error.message : undefined,
    "read the draft for this résumé"
  );
  if (described !== undefined) return { error: described };

  return insertSavedRow(actor.tenantId, {
    ...input,
    content: data.length > 0 ? data[0].content : null,
    kind: "save",
    retentionDays: RETENTION_DAYS,
  });
}

/**
 * Copies a SOURCE saved row forward as a new row — never the working draft,
 * because this button captures a frozen row's DOM and attaching the draft's
 * selection would produce a row whose `html` and `content` describe different
 * documents.
 */
export async function saveResumeAsNewVersion(input: {
  fromSavedId: string;
  html: string;
  label?: string | null;
  allowDuplicate?: boolean;
  pageMargin?: string | null;
}): Promise<{ id?: string; duplicateOf?: string; error?: string }> {
  const actor = await requireResumeAdmin();

  const { data, error } = await rawQuery<{
    job_id: string | null;
    role_title: string;
    company: string;
    content: unknown;
  }>(
    "select job_id, role_title, company, content from saved_resumes where tenant_id = $1 and id = $2",
    [actor.tenantId, input.fromSavedId],
    actor.tenantId
  );
  const described = describeWriteFailure(
    error ? error.message : undefined,
    "read the résumé you are saving a new version of"
  );
  if (described !== undefined) return { error: described };
  if (data.length === 0) return { error: "Could not find that saved résumé." };
  const src = data[0];
  if (src.job_id === null) {
    // The row outlived its job (016's ON DELETE SET NULL). job_id is NOT NULL
    // on insert, and the duplicate check's `job_id = $2` matches nothing under
    // SQL null semantics anyway — so this refuses rather than writing a row
    // whose dedupe is silently inert.
    return {
      error: "The tracked role this résumé came from was deleted, so it cannot be versioned.",
    };
  }

  return insertSavedRow(actor.tenantId, {
    jobId: src.job_id,
    html: input.html,
    roleTitle: src.role_title,
    company: src.company,
    label: input.label,
    allowDuplicate: input.allowDuplicate,
    pageMargin: input.pageMargin,
    content: src.content ?? null,
    kind: "save",
    retentionDays: RETENTION_DAYS,
  });
}

export async function listSavedResumes(): Promise<{
  resumes: SavedResumeSummary[];
  error?: string;
}> {
  const actor = await requireResumeAdmin();

  // Opportunistic purge. The promise the user was given is about STORAGE, and
  // CLAUDE.md records this repo's cron route 404-ing nightly for days with
  // nothing surfacing it — so an active user's own retention must not depend on
  // cron uptime. One indexed statement against an index that already exists.
  const purge = await rawQuery(
    "delete from saved_resumes where tenant_id = $1 and " + EXPIRED_PREDICATE,
    [actor.tenantId],
    actor.tenantId
  );
  if (purge.error) console.error("listSavedResumes opportunistic purge failed:", purge.error);

  const { data, error } = await rawQuery<SavedRow>(
    "select id, job_id, role_title, company, label, created_at, expires_at, page_margin, kind, " +
      "(content is not null) as has_content " +
      "from saved_resumes where tenant_id = $1 and " +
      LIVE_PREDICATE +
      " order by created_at desc",
    [actor.tenantId],
    actor.tenantId
  );
  if (error) {
    console.error("listSavedResumes error:", error);
    return { resumes: [], error: describeWriteFailure(error.message, "load your saved résumés") };
  }
  return { resumes: data.map(savedRowToSummary) };
}

export async function getSavedResume(
  id: string
): Promise<{ resume: SavedResume | null; error?: string }> {
  const actor = await requireResumeAdmin();

  const { data, error } = await rawQuery<SavedRow>(
    "select id, job_id, role_title, company, label, created_at, expires_at, html, design_version, " +
      "page_margin, content, kind, (content is not null) as has_content " +
      "from saved_resumes where tenant_id = $1 and id = $2 and " +
      LIVE_PREDICATE,
    [actor.tenantId, id],
    actor.tenantId
  );
  if (error) {
    console.error("getSavedResume error:", error);
    return { resume: null, error: describeWriteFailure(error.message, "load that saved résumé") };
  }
  // null is a genuine "not here" — either never existed or expired. The caller
  // renders a not-found state naming expiry as the likely cause.
  if (data.length === 0) return { resume: null };
  const r = data[0];
  return {
    resume: {
      ...savedRowToSummary(r),
      html: r.html as string,
      designVersion: r.design_version as string,
      content: r.content ?? null,
    },
  };
}

export async function deleteSavedResume(id: string): Promise<{ error?: string }> {
  const actor = await requireResumeAdmin();
  // Single id and equality only, so the builder can express it.
  const { error } = await supabase
    .forTenant(actor.tenantId)
    .from("saved_resumes")
    .delete()
    .eq("id", id);
  const described = describeWriteFailure(
    error ? error.message : undefined,
    "delete that saved résumé"
  );
  // Deleting a row that is already gone is the outcome the user wanted: no error.
  if (described !== undefined) return { error: described };
  return {};
}

export async function deleteSavedResumes(
  ids: string[]
): Promise<{ deleted: number; error?: string }> {
  const actor = await requireResumeAdmin();
  if (ids.length === 0) return { deleted: 0 };
  // IN lists are not expressible in the builder — rawQuery, tenant id passed.
  const { data, error } = await rawQuery<{ id: string }>(
    "delete from saved_resumes where tenant_id = $1 and id = any($2::uuid[]) returning id",
    [actor.tenantId, ids],
    actor.tenantId
  );
  const described = describeWriteFailure(
    error ? error.message : undefined,
    "delete those saved résumés"
  );
  if (described !== undefined) return { deleted: 0, error: described };
  return { deleted: data.length };
}

/**
 * The design assets a downloaded file must carry, read from public/ on the
 * server and cached for the process. doc-page.js is NOT optional: its own
 * source says "never write your own @page rule" (:30) and there are no @page
 * rules anywhere in the token CSS — all print geometry lives in the component.
 */
let assetCache: { css: string; docPageJs: string } | null = null;

export async function getDownloadAssets(): Promise<{
  css: string;
  docPageJs: string;
  error?: string;
}> {
  await requireResumeAdmin();
  if (assetCache) return assetCache;
  try {
    const base = join(process.cwd(), "public", "resume-design");
    const css = TOKEN_CSS_FILES.map((f) =>
      readFileSync(join(base, "tokens", f), "utf8")
    ).join("\n");
    const docPageJs = readFileSync(join(base, "doc-page.js"), "utf8");
    assetCache = { css, docPageJs };
    return assetCache;
  } catch (err) {
    // Not a database failure, so UNDESCRIBED_DB_ERROR would name the wrong
    // thing — this substitutes its own fallback at the catch, as the actions
    // whose failure is not the database do.
    console.error("getDownloadAssets error:", err);
    return { css: "", docPageJs: "", error: "Could not assemble the download." };
  }
}
