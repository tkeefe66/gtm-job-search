export type RemovalReason = "stopped" | "not_interested" | "source_problem";
export interface RemovalRecord {
  company: string;
  careers_url: string | null;
  tracking_enabled?: boolean;
  removal_reason?: RemovalReason | null;
  removed_at?: string | null;
}
export interface RestoreNotice {
  company: string; careersUrl: string | null; reason: RemovalReason | null;
  removedAt: string | null; acknowledgementKey: string;
}
export function restorationNotice(row: RemovalRecord): RestoreNotice | undefined {
  if (row.tracking_enabled !== false) return undefined;
  return {company: row.company, careersUrl: row.careers_url, reason: row.removal_reason ?? null,
    removedAt: row.removed_at ?? null,
    acknowledgementKey: JSON.stringify([row.company, row.careers_url, row.removal_reason ?? null, row.removed_at ?? null])};
}
export function removalReasonLabel(reason?: RemovalReason | null): string {
  return reason === "not_interested" ? "Not interested" : reason === "source_problem" ? "Careers page problem" : "Tracking stopped";
}
export function validRemovalReason(value: unknown): value is RemovalReason {
  return value === "stopped" || value === "not_interested" || value === "source_problem";
}
