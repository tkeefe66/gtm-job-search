import { hostOf, classifyJobLink } from "./job-link";
import { excludedJobSource } from "./job-source-policy";
import type { JobStatusDef } from "./job-statuses";

export const DISPOSITIONS = [
  { key: "not_interested", label: "Not interested", help: "Personal preference; no source-quality penalty." },
  { key: "not_a_fit", label: "Not a fit", help: "Pay, location, seniority or responsibilities don't fit." },
  { key: "job_not_found", label: "Job not found", help: "You couldn't locate the advertised role." },
  { key: "posting_closed", label: "Posting closed", help: "The employer explicitly stopped accepting applications." },
  { key: "duplicate", label: "Duplicate", help: "This opportunity is already in your pipeline." },
] as const;
export type Disposition = typeof DISPOSITIONS[number]["key"];
export const FIT_REASONS = [
  { key: "pay", label: "Compensation" },
  { key: "location", label: "Location" },
  { key: "seniority", label: "Seniority" },
  { key: "responsibilities", label: "Responsibilities" },
  { key: "other", label: "Other" },
] as const;
export type FitReason = typeof FIT_REASONS[number]["key"];

export function isDisposition(value: unknown): value is Disposition {
  return DISPOSITIONS.some(d => d.key === value);
}
export function isFitReason(value: unknown): value is FitReason {
  return FIT_REASONS.some(r => r.key === value);
}
export function dispositionLabel(value: string | null | undefined): string {
  return DISPOSITIONS.find(d => d.key === value)?.label ?? "No disposition";
}
export function dispositionStatus(disposition: Disposition, statuses: JobStatusDef[]): string | null {
  if (disposition === "posting_closed") return "Posting Closed";
  const available = statuses.filter(s => s.bucket === "terminal" && !s.hidden && s.key !== "Posting Closed");
  return available.find(s => s.key === "Not Interested")?.key ?? available[0]?.key ?? null;
}

export interface SourceRecord {
  id: string;
  job_id: string | null;
  company: string;
  role_title: string;
  source_url: string | null;
  source_method: string | null;
  discovered_at: string;
  cohort: "new" | "legacy";
  status: string;
  disposition: Disposition | null;
  disposition_reason: FitReason | null;
  actor: "user" | "automation" | null;
  occurred_at: string | null;
  never_live: boolean;
  event_count: number;
}

export function safeSourceUrl(value: string | null): string | null {
  if (!hostOf(value)) return null;
  const url = new URL(value!);
  // Never show credentials embedded in imported URLs.
  url.username = "";
  url.password = "";
  return url.href;
}

export function sourceIdentity(url: string | null, company: string): string {
  const host = hostOf(url);
  if (!host) return "Unknown source";
  if (excludedJobSource(url)) return "BuiltIn";
  // Shared ATS domains describe a platform, not one employer's source.
  if (classifyJobLink(url) === "ats") {
    const path = new URL(url!).pathname.split("/").filter(Boolean);
    if (/^(jobs\.ashbyhq\.com|jobs(?:\.eu)?\.lever\.co|(?:job-)?boards(?:\.eu)?\.greenhouse\.io|apply\.workable\.com|jobs\.smartrecruiters\.com|jobs\.jobvite\.com)$/.test(host)) {
      const slug = path[0] && path[0] !== "j" ? path[0] : company;
      return `${host}/${slug}`;
    }
    // Unrecognized ATS URL shapes still retain the known employer. Merging
    // every tenant on a shared vendor host would produce misleading scores.
    return `${host} (${company})`;
  }
  return host;
}

export interface SourceGroup {
  name: string;
  total: number;
  counts: Record<Disposition, number>;
  humanFeedback: number;
  automatedFeedback: number;
  deadAtDiscovery: number;
  records: SourceRecord[];
}

/** One snapshot per role; event_count is history, never the denominator. */
export function groupSources(records: SourceRecord[], cohort: "new" | "legacy"): SourceGroup[] {
  const groups = new Map<string, SourceGroup>();
  const seen = new Set<string>();
  for (const record of records) {
    if (record.cohort !== cohort || seen.has(record.id)) continue;
    seen.add(record.id);
    const name = sourceIdentity(record.source_url, record.company);
    let group = groups.get(name);
    if (!group) {
      group = { name, total: 0, counts: {not_interested:0,not_a_fit:0,job_not_found:0,posting_closed:0,duplicate:0}, humanFeedback:0, automatedFeedback:0, deadAtDiscovery:0, records:[] };
      groups.set(name, group);
    }
    group.total++;
    group.records.push(record);
    if (record.never_live) group.deadAtDiscovery++;
    if (record.disposition && isDisposition(record.disposition)) {
      group.counts[record.disposition]++;
      if (record.actor === "user") group.humanFeedback++;
      if (record.actor === "automation") group.automatedFeedback++;
    }
  }
  return Array.from(groups.values()).sort((a,b) => b.total - a.total || a.name.localeCompare(b.name));
}
