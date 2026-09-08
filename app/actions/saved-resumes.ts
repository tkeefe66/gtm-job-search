// app/actions/saved-resumes.ts
"use server";

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { requireResumeAdmin } from "@/lib/require-resume-admin";
import { supabase, rawQuery } from "@/lib/supabase";
import { describeWriteFailure } from "@/lib/write-failure";
import { sanitizeResumeHtml } from "@/lib/resume-sanitize";
import { EXPIRED_PREDICATE, LIVE_PREDICATE, expiresAtFrom } from "@/lib/resume-retention";
import { DESIGN_VERSION, TOKEN_CSS_FILES } from "@/lib/resume-download";
import type { SavedResume, SavedResumeSummary, SaveResumeInput } from "@/lib/types";

interface SavedRow {
  id: string;
  job_id: string | null;
  role_title: string;
  company: string;
  label: string | null;
  created_at: string;
  expires_at: string;
  page_margin: string | null;
  html?: string;
  design_version?: string;
}

function toSummary(r: SavedRow): SavedResumeSummary {
  return {
    id: r.id,
    jobId: r.job_id,
    roleTitle: r.role_title,
    company: r.company,
    label: r.label,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
    pageMargin: r.page_margin,
  };
}

export async function saveResume(
  input: SaveResumeInput
): Promise<{ id?: string; duplicateOf?: string; error?: string }> {
  // FIRST statement, never inside a try — auth-required.test.ts asserts this
  // THROWS, and a top-level catch would turn it into a returned {error}.
  const actor = await requireResumeAdmin();

  const clean = sanitizeResumeHtml(input.html);
  if (clean.error !== undefined) return { error: clean.error };
  const html = clean.html as string;
  const contentHash = createHash("sha256").update(html).digest("hex");

  // Duplicate check against this job's newest saved row. Without it, saving the
  // algorithmic render three times leaves three cards differing only by a
  // timestamp, permanently.
  if (!input.allowDuplicate) {
    const { data, error } = await rawQuery<{ id: string }>(
      "select id from saved_resumes where tenant_id = $1 and job_id = $2 and " +
        LIVE_PREDICATE +
        " order by created_at desc limit 1",
      [actor.tenantId, input.jobId],
      actor.tenantId // <- sets app.tenant_id; without it this matches nothing
    );
    const described = describeWriteFailure(
      error ? error.message : undefined,
      "check for an identical saved résumé"
    );
    if (described !== undefined) return { error: described };
    if (data.length > 0) {
      const dup = await rawQuery<{ id: string }>(
        "select id from saved_resumes where tenant_id = $1 and id = $2 and content_hash = $3",
        [actor.tenantId, data[0].id, contentHash],
        actor.tenantId
      );
      if (dup.data.length > 0) return { duplicateOf: dup.data[0].id };
    }
  }

  const now = new Date();
  const { data, error } = await rawQuery<{ id: string }>(
    "insert into saved_resumes " +
      "(tenant_id, job_id, role_title, company, label, html, design_version, content_hash, expires_at, page_margin) " +
      "values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning id",
    [
      actor.tenantId,
      input.jobId,
      input.roleTitle,
      input.company,
      input.label ? input.label : null, // "" is stored as null: one unlabelled state, not two
      html,
      DESIGN_VERSION,
      contentHash,
      expiresAtFrom(now).toISOString(),
      input.pageMargin ? input.pageMargin : null, // omitted/null/"" all store as null -> 0.68in default
    ],
    actor.tenantId
  );
  const described = describeWriteFailure(error ? error.message : undefined, "save that résumé");
  if (described !== undefined) return { error: described };
  return { id: data[0].id };
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
    "select id, job_id, role_title, company, label, created_at, expires_at, page_margin " +
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
  return { resumes: data.map(toSummary) };
}

export async function getSavedResume(
  id: string
): Promise<{ resume: SavedResume | null; error?: string }> {
  const actor = await requireResumeAdmin();

  const { data, error } = await rawQuery<SavedRow>(
    "select id, job_id, role_title, company, label, created_at, expires_at, html, design_version, page_margin " +
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
      ...toSummary(r),
      html: r.html as string,
      designVersion: r.design_version as string,
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
