// lib/saved-resume-insert.ts
//
// The one INSERT into saved_resumes. Deliberately NOT in
// app/actions/saved-resumes.ts: that file carries "use server", so every
// export becomes a client-callable RPC endpoint, and app/actions/auth-required
// .test.ts requires every such export to refuse a session-less call on its
// own. This function takes tenantId explicitly instead — it is not itself a
// Server Action, so it carries no such guarantee, and every caller (both
// exported actions in saved-resumes.ts, and a later restoreSavedVersion in a
// different file) must call requireResumeAdmin() itself before reaching here.
//
// Callers differ in where `content` comes from, and getting that wrong is the
// difference between a reproducible row and a corrupt one — see the two
// exported actions in app/actions/saved-resumes.ts.
import { createHash } from "node:crypto";
import { rawQuery } from "@/lib/supabase";
import { describeWriteFailure } from "@/lib/write-failure";
import { sanitizeResumeHtml } from "@/lib/resume-sanitize";
import { LIVE_PREDICATE, expiresAtFrom } from "@/lib/resume-retention";
import { DESIGN_VERSION } from "@/lib/resume-download";

export interface InsertInput {
  jobId: string;
  html: string;
  roleTitle: string;
  company: string;
  label?: string | null;
  allowDuplicate?: boolean;
  pageMargin?: string | null;
  content: unknown | null;
  kind: "save" | "checkpoint";
  retentionDays: number;
}

export async function insertSavedRow(
  tenantId: string,
  input: InsertInput
): Promise<{ id?: string; duplicateOf?: string; error?: string }> {
  const clean = sanitizeResumeHtml(input.html);
  if (clean.error !== undefined) return { error: clean.error };
  const html = clean.html as string;
  const contentHash = createHash("sha256").update(html).digest("hex");

  if (!input.allowDuplicate) {
    const { data, error } = await rawQuery<{ id: string }>(
      // kind = 'save' is load-bearing. The newest live row is now often an
      // app-written CHECKPOINT (restoreSavedVersion), and deduping against one
      // makes a deliberate Save report duplicateOf a checkpoint — TailorPanel
      // then says "This is identical to the version you already saved", and
      // declining leaves the user with only a 3/30-day auto row instead of the
      // 60-day save they asked for.
      "select id from saved_resumes where tenant_id = $1 and job_id = $2 and kind = 'save' and " +
        LIVE_PREDICATE +
        " order by created_at desc limit 1",
      [tenantId, input.jobId],
      tenantId
    );
    const described = describeWriteFailure(
      error ? error.message : undefined,
      "check for an identical saved résumé"
    );
    if (described !== undefined) return { error: described };
    if (data.length > 0) {
      const dup = await rawQuery<{ id: string }>(
        "select id from saved_resumes where tenant_id = $1 and id = $2 and content_hash = $3",
        [tenantId, data[0].id, contentHash],
        tenantId
      );
      if (dup.data.length > 0) return { duplicateOf: dup.data[0].id };
    }
  }

  const now = new Date();
  const { data, error } = await rawQuery<{ id: string }>(
    "insert into saved_resumes " +
      "(tenant_id, job_id, role_title, company, label, html, design_version, content_hash, expires_at, page_margin, content, kind) " +
      "values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) returning id",
    [
      tenantId,
      input.jobId,
      input.roleTitle,
      input.company,
      input.label ? input.label : null,
      html,
      DESIGN_VERSION,
      contentHash,
      expiresAtFrom(now, input.retentionDays).toISOString(),
      input.pageMargin ? input.pageMargin : null,
      input.content === null ? null : JSON.stringify(input.content),
      input.kind,
    ],
    tenantId
  );
  const described = describeWriteFailure(error ? error.message : undefined, "save that résumé");
  if (described !== undefined) return { error: described };
  return { id: data[0].id };
}
