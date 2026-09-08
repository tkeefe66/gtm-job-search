// app/actions/restore-saved-version.ts
//
// Reopens a saved résumé as the working draft (tailored_resumes), without
// destroying whatever draft it replaces.
//
// Takes ONLY `savedId`. `jobId` is not accepted as an argument even though the
// caller has it in the URL and in client state: an arbitrary value would reach
// the tailored_resumes upsert, and RLS on that table checks tenant_id only —
// the FK to jobs bypasses row security by design (migration 016's own
// comment) — so a caller could key a row in their own tenant to another
// tenant's job. job_id is derived from the saved row itself instead.
"use server";

import { requireResumeAdmin } from "@/lib/require-resume-admin";
import { rawQuery, supabase } from "@/lib/supabase";
import { describeWriteFailure } from "@/lib/write-failure";
import { shouldCheckpoint } from "@/lib/checkpoint-decision";
import { renderDraftHtml } from "@/lib/draft-render";
import { insertSavedRow } from "@/lib/saved-resume-insert";
import { careerOverlayFrom, readAllSettingsResult } from "@/lib/settings-store";
import {
  CHECKPOINT_RETENTION_DAYS,
  LIVE_PREDICATE,
  SUPERSEDED_CHECKPOINT_DAYS,
} from "@/lib/resume-retention";
import type { CareerRecord, ResumeSelection } from "@/lib/resume-render/render";
import type { ResumeOverrides } from "@/lib/resume-overrides";
import career from "@/lib/resume-render/content/resume.json";

interface SavedRowFields {
  job_id: string | null;
  role_title: string;
  company: string;
  content: unknown;
  created_at: string;
}

/** The shape tailored_resumes.content is written in — see
 *  app/actions/resume.ts (Regenerate: {themes, selection}, no overrides key)
 *  and app/actions/resume-chat.ts (a chat op: {themes, selection, overrides}). */
interface DraftContent {
  themes: string[];
  selection: ResumeSelection;
  overrides?: ResumeOverrides;
}

/** Pinned to "en-US" for the same reason lib/role-age.ts pins its
 *  toLocaleDateString calls: the default locale is the server's, not the
 *  viewer's, for text landing in a database row or a chat transcript. */
function formatDate(d: Date): string {
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

/** Appends an assistant marker message to this job's chat thread, or
 *  describes the failure. Deliberately not reusing app/actions/resume-chat.ts's
 *  readThread/writeThread — neither is exported, and that file's "use server"
 *  directive means only async functions may leave it, so a private helper
 *  there is not reachable from here. Mirrors their upsert shape exactly. */
async function appendRestoreMarker(
  tenantId: string,
  jobId: string,
  text: string
): Promise<{ error?: string }> {
  const { data, error } = await supabase
    .forTenant(tenantId)
    .from("resume_chats")
    .select("messages")
    .eq("job_id", jobId)
    .maybeSingle();
  if (error) {
    return { error: describeWriteFailure(error.message, "load the chat thread") };
  }
  const prior = data ? (data as { messages: unknown }).messages : [];
  const messages = Array.isArray(prior) ? prior : [];
  const updated = [...messages, { role: "assistant", text }];

  const { error: writeError } = await supabase
    .forTenant(tenantId)
    .from("resume_chats")
    .upsert(
      { job_id: jobId, messages: updated, updated_at: new Date().toISOString() },
      { onConflict: "tenant_id,job_id" }
    );
  return { error: describeWriteFailure(writeError ? writeError.message : undefined, "record the restore") };
}

export async function restoreSavedVersion(
  savedId: string
): Promise<{ jobId?: string; checkpointId?: string; error?: string }> {
  // FIRST statement, never inside a try — auth-required.test.ts asserts this
  // THROWS, and a top-level catch would turn it into a returned {error}.
  const actor = await requireResumeAdmin();

  // Step 1: read the row being restored (S), tenant-scoped.
  const savedResult = await rawQuery<SavedRowFields>(
    "select job_id, role_title, company, content, created_at from saved_resumes " +
      "where tenant_id = $1 and id = $2",
    [actor.tenantId, savedId],
    actor.tenantId
  );
  const savedError = describeWriteFailure(
    savedResult.error ? savedResult.error.message : undefined,
    "read that saved résumé"
  );
  if (savedError !== undefined) return { error: savedError };
  if (savedResult.data.length === 0) return { error: "Could not find that saved résumé." };
  const saved = savedResult.data[0];
  if (saved.job_id === null) {
    // The row outlived its job (016's ON DELETE SET NULL) — nothing to
    // restore into.
    return {
      error: "The tracked role this résumé came from was deleted, so it cannot be restored.",
    };
  }
  if (saved.content === null || saved.content === undefined) {
    // A row written before migration 021 (or otherwise stripped) has no
    // content to become a draft — only html, which tailored_resumes does not
    // store.
    return { error: "That saved résumé has no restorable content." };
  }
  const jobId = saved.job_id;

  // Step 2: read the current working draft for this job.
  const draftResult = await rawQuery<{ content: unknown }>(
    "select content from tailored_resumes where tenant_id = $1 and job_id = $2",
    [actor.tenantId, jobId],
    actor.tenantId
  );
  const draftError = describeWriteFailure(
    draftResult.error ? draftResult.error.message : undefined,
    "read the current draft"
  );
  if (draftError !== undefined) return { error: draftError };
  const draft: unknown | null = draftResult.data.length > 0 ? draftResult.data[0].content : null;

  // Step 3: read the newest LIVE saved row for this job.
  const newestResult = await rawQuery<{ content: unknown }>(
    "select content from saved_resumes where tenant_id = $1 and job_id = $2 and " +
      LIVE_PREDICATE +
      " order by created_at desc limit 1",
    [actor.tenantId, jobId],
    actor.tenantId
  );
  const newestError = describeWriteFailure(
    newestResult.error ? newestResult.error.message : undefined,
    "check for a saved version of this résumé"
  );
  if (newestError !== undefined) return { error: newestError };
  const newest =
    newestResult.data.length > 0 ? { content: newestResult.data[0].content } : null;

  let checkpointId: string | undefined;

  // Step 4: checkpoint the draft first, if restoring would otherwise destroy
  // its only copy.
  if (shouldCheckpoint(draft, newest)) {
    const rowsResult = await readAllSettingsResult();
    if (rowsResult.error !== undefined) {
      return { error: describeWriteFailure(rowsResult.error, "load your settings") };
    }
    const overlay = careerOverlayFrom(rowsResult.rows);
    // shouldCheckpoint(draft, ...) only returns true when draft is neither
    // null nor undefined, so this cast is safe.
    const draftContent = draft as DraftContent;

    const html = renderDraftHtml({
      career: career as CareerRecord,
      overlay,
      themes: draftContent.themes,
      baseSelection: draftContent.selection,
      overrides: draftContent.overrides || {},
    });

    const checkpointResult = await insertSavedRow(actor.tenantId, {
      jobId,
      html,
      // The checkpoint and S share job_id, which is why role_title/company can
      // be borrowed from S's own snapshot — those columns are NOT NULL and no
      // job read has happened here.
      roleTitle: saved.role_title,
      company: saved.company,
      label: "Checkpoint · " + formatDate(new Date()),
      allowDuplicate: true,
      content: draft,
      kind: "checkpoint",
      retentionDays: CHECKPOINT_RETENTION_DAYS,
    });
    if (checkpointResult.error !== undefined) return { error: checkpointResult.error };
    checkpointId = checkpointResult.id;

    // Step 5: demote older checkpoints for this job. least() is load-bearing —
    // an unconditional now()+3days would EXTEND a checkpoint already 29 days
    // old. The kind = 'checkpoint' filter is equally load-bearing — without it
    // this demotes deliberate Saves.
    if (checkpointId !== undefined) {
      await rawQuery(
        "update saved_resumes set expires_at = least(expires_at, now() + interval '" +
          SUPERSEDED_CHECKPOINT_DAYS +
          " days') " +
          "where tenant_id = $1 and job_id = $2 and kind = 'checkpoint' and id <> $3",
        [actor.tenantId, jobId, checkpointId],
        actor.tenantId
      );
    }
  }

  // Step 6: overwrite the working draft with S's content.
  const { error: upsertError } = await supabase
    .forTenant(actor.tenantId)
    .from("tailored_resumes")
    .upsert(
      { job_id: jobId, content: saved.content, generated_at: new Date().toISOString() },
      { onConflict: "tenant_id,job_id" }
    );
  const describedUpsertError = describeWriteFailure(
    upsertError ? upsertError.message : undefined,
    "restore that résumé into your working draft"
  );
  if (describedUpsertError !== undefined) return { error: describedUpsertError, checkpointId };

  // Step 7: append a marker turn so the chat thread does not describe changes
  // the restored document no longer carries. buildChatPrompt
  // (resume-chat.ts:363) is handed the thread whole, and acceptProposedBullets
  // (resume-chat.ts:712-718) resolves ids against every proposal the thread
  // ever carried — without this marker, a proposal from the discarded
  // direction stays accept-able and the model is told it already made changes
  // that are no longer applied.
  const markerText =
    "Restored the version saved on " +
    formatDate(new Date(saved.created_at)) +
    ". The document below is that version; anything I changed after it is no longer applied.";
  const markerResult = await appendRestoreMarker(actor.tenantId, jobId, markerText);
  if (markerResult.error !== undefined) return { error: markerResult.error, jobId, checkpointId };

  return { jobId, checkpointId };
}
