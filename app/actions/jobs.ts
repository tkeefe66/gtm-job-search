"use server";

import { requireActor } from "@/lib/require-actor";
import { resolveTenantId } from "@/lib/tenant";

import { resolveStatuses, type JobStatusDef } from "@/lib/job-statuses";
import { JOB_STATUSES_KEY } from "@/lib/settings-store";
import { rawQuery, supabase } from "@/lib/supabase";
import type { Job, JobInsert, JobStatus } from "@/lib/types";

export async function getJobs(): Promise<{ jobs: Job[]; error?: string }> {
  // Session required. Server Actions are RPC endpoints addressed by an ID that
  // ships in the client bundle, so a page-level check does not cover them.
  await requireActor();
  const { data, error } = await supabase.forTenant(await resolveTenantId())
    .from("jobs")
    .select("*")
    .order("created_at", { ascending: false });

  if (error) {
    console.error("getJobs error:", error);
    return { jobs: [], error: error.message };
  }
  return { jobs: (data as Job[]) ?? [] };
}

export async function addJob(
  job: JobInsert
): Promise<{ job?: Job; error?: string }> {
  // Session required. Server Actions are RPC endpoints addressed by an ID that
  // ships in the client bundle, so a page-level check does not cover them.
  await requireActor();
  const { data, error } = await supabase.forTenant(await resolveTenantId())
    .from("jobs")
    .insert(job)
    .select()
    .single();

  if (error) {
    console.error("addJob error:", error);
    return { error: error.message };
  }
  return { job: data as Job };
}

// `updateJobStatus` was deleted here. It stamped applied_date and had ZERO
// callers — every status write goes through `updateJob` below — so the column
// rendered blank on every row forever. The rule now lives in
// lib/applied-date.ts, where it is pure and tested, and callers spread it into
// their patch. It also no longer overwrites an existing date, which the dead
// version did unconditionally.

export async function updateJob(
  id: string,
  patch: Partial<Job>
): Promise<{ error?: string }> {
  // Session required. Server Actions are RPC endpoints addressed by an ID that
  // ships in the client bundle, so a page-level check does not cover them.
  await requireActor();
  const { error } = await supabase.forTenant(await resolveTenantId())
    .from("jobs")
    // updated_at is stamped UNCONDITIONALLY on purpose: rescoreAll pages
    // through jobs with `order by updated_at asc` (lib/rescore-scope.ts), so
    // dropping this stamp makes every batch re-score the same rows forever.
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("id", id);
  if (error) {
    console.error("updateJob error:", error);
    return { error: error.message };
  }
  return {};
}

export async function deleteJob(id: string): Promise<{ error?: string }> {
  // Session required. Server Actions are RPC endpoints addressed by an ID that
  // ships in the client bundle, so a page-level check does not cover them.
  await requireActor();
  const { error } = await supabase.forTenant(await resolveTenantId()).from("jobs").delete().eq("id", id);
  if (error) {
    console.error("deleteJob error:", error);
    return { error: error.message };
  }
  return {};
}

/**
 * The user's status config, for the client components that render statuses.
 *
 * Carries an error channel on purpose. Returning DEFAULT_STATUSES on a failed
 * read would show the user a config that is not theirs — un-hiding statuses and
 * reverting renames — and then let them write a status their config forbids.
 * The caller must be able to tell "your config" from "the database is down".
 */
export async function getJobStatuses(): Promise<{
  statuses: JobStatusDef[];
  error?: string;
}> {
  await requireActor();
  const tenantId = await resolveTenantId();
  const { data, error } = await rawQuery<{ value: unknown }>(
    `select value from app_settings where tenant_id = $1 and key = $2`,
    [tenantId, JOB_STATUSES_KEY],
    tenantId
  );
  // Verbatim, empty string included — presence is the signal.
  if (error) return { statuses: resolveStatuses(null), error: error.message };
  return { statuses: resolveStatuses(data?.[0]?.value ?? null) };
}
