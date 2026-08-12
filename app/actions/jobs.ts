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

export async function updateJobStatus(
  id: string,
  status: JobStatus
): Promise<{ error?: string }> {
  const patch: Record<string, unknown> = {
    status,
    updated_at: new Date().toISOString(),
  };
  if (status === "Applied") {
    patch.applied_date = new Date().toISOString().slice(0, 10);
  }

  const { error } = await supabase.from("jobs").update(patch).eq("id", id);
  if (error) {
    console.error("updateJobStatus error:", error);
    return { error: error.message };
  }
  return {};
}

export async function updateJob(
  id: string,
  patch: Partial<Job>
): Promise<{ error?: string }> {
  const { error } = await supabase
    .from("jobs")
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
