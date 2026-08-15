"use server";

import { supabase } from "@/lib/supabase";
import type { Job, JobInsert, JobStatus } from "@/lib/types";

export async function getJobs(): Promise<{ jobs: Job[]; error?: string }> {
  const { data, error } = await supabase
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
  const { data, error } = await supabase
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
  const { error } = await supabase
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
  const { error } = await supabase.from("jobs").delete().eq("id", id);
  if (error) {
    console.error("deleteJob error:", error);
    return { error: error.message };
  }
  return {};
}
