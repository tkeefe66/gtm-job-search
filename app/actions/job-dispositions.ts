"use server";

import { requireActor } from "@/lib/require-actor";
import { getJobStatuses } from "@/app/actions/jobs";
import { patchJobWithActor, readSourceQuality } from "@/lib/job-disposition-store";
import { dispositionStatus, isDisposition, isFitReason, type Disposition, type FitReason } from "@/lib/job-dispositions";

export async function setJobDisposition(id: string, disposition: Disposition, reason?: FitReason | null): Promise<{error?:string}> {
  const actor = await requireActor();
  if (!isDisposition(disposition)) return {error:"Choose a valid disposition."};
  if (reason != null && (disposition !== "not_a_fit" || !isFitReason(reason))) return {error:"Choose a valid reason for Not a fit."};
  const result = await getJobStatuses();
  if (result.error !== undefined) return {error:result.error};
  const status = dispositionStatus(disposition, result.statuses);
  if (!status) return {error:"No compatible filing status is available. Enable a terminal status in Settings (other than Posting Closed for this disposition), then try again."};
  return patchJobWithActor(actor.tenantId,id,{status,disposition,disposition_reason:reason ?? null},"user",true);
}

export async function getSourceQuality() {
  const actor = await requireActor();
  return readSourceQuality(actor.tenantId);
}
