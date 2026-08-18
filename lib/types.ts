import type { SystemStatusKey } from "@/lib/job-statuses";

/**
 * The statuses code reads and writes BY NAME. No longer the full list — the
 * user's list lives in app_settings and is resolved by lib/job-statuses.ts.
 * `Job.status` below is `string` because it can hold any key the user defined.
 */
export type JobStatus = SystemStatusKey;

// Legacy pipeline statuses for Tracker funnel view
export type PipelineStatus = "Tracking" | "Applied" | "Interviewing" | "Offer" | "Passed";
export const PIPELINE_STATUSES: PipelineStatus[] = [
  "Tracking",
  "Applied",
  "Interviewing",
  "Offer",
  "Passed",
];

export type Seniority = "VP/Head" | "Director" | "Senior Manager" | "Manager/IC";

export interface Startup {
  company: string;
  tagline: string;
  raised: string;
  stage: string;
  lead_investor: string;
  founded: string;
  traction: string;
  careers_url: string;
  category: string;
  /** The employer's headquarters. NOT where the signal happened — see `location`. */
  headquarters: string;
  /**
   * WHERE the hiring signal happened — the site, facility, or region named
   * in the signal, which may differ from `headquarters` (a plant expansion's
   * HQ can sit in a different state entirely from the plant). Required
   * alongside `signal`/`extras`, so it is part of the fixed core every
   * profile's Discover result carries, not something career-specific.
   */
  location: string;
  /**
   * One legible sentence describing what happened — "Raised $400M Series D
   * led by a16z", "Won $2.1B USAF sustainment contract". What makes Discover
   * legible across domains: see lib/hiring-signal-prompt.ts.
   *
   * REQUIRED, not optional: an optional field would let a row through with
   * neither `signal` nor `extras`, and the card would render empty. Existing
   * cached rows (written before this field existed) have neither at
   * runtime despite the type — read them defensively via
   * `s.signal ?? legacySignalFrom(s)` (lib/legacy-signal.ts).
   */
  signal: string;
  /**
   * Per-signal detail beyond the fixed core, keyed by the tenant's
   * `profile.hiringSignal.extraFields` — `raised`/`stage`/`lead_investor` for
   * the shipped funding profile, `contract_value`/`awarding_agency` for a
   * defence-contract one. REQUIRED for the same reason `signal` is; read
   * defensively (`s.extras ?? {}`) against rows written before it existed.
   */
  extras: Record<string, string>;
}

export interface Role {
  role_title: string;
  job_url: string;
  location: string;
  seniority: Seniority | string;
  salary_range: string;
  description_summary: string;
  fit_signal: string;
  ic_flag: boolean;
}

export interface RolesResult {
  roles: Role[];
  message?: string;
}

export interface Job {
  id: string;
  company: string;
  role_title: string;
  status: JobStatus | string;
  seniority: string | null;
  department: string | null;
  location: string | null;
  job_url: string | null;
  careers_url: string | null;
  category: string | null;
  raised: string | null;
  stage: string | null;
  traction: string | null;
  key_skills: string | null;
  salary_range: string | null;
  source: string | null;
  notes: string | null;
  fit_score: number | null;
  fit_summary: string | null;
  recruiter_name: string | null;
  recruiter_email: string | null;
  recruiter_company: string | null;
  recruiter_notes: string | null;
  company_url: string | null;
  company_description: string | null;
  arr: string | null;
  exit_signal: string | null;
  backer: string | null;
  ic_flag: boolean | null;
  /**
   * Where the role was found, when that differs from where it now links.
   * Set only when job_url is REPLACED with the employer's own posting, so a
   * relink can always be traced back or undone.
   */
  source_url: string | null;
  added_date: string | null;
  applied_date: string | null;
  created_at: string;
  updated_at: string;
}

export type JobInsert = Partial<Omit<Job, "id" | "created_at" | "updated_at">> & {
  company: string;
  role_title: string;
};

export type CrawlStatus = "ok" | "empty" | "error" | "needs_url";
export type CrawlMethod = "fetch" | "search";

export interface TrackedCompany {
  id: string;
  company: string;
  tagline: string | null;
  raised: string | null;
  stage: string | null;
  lead_investor: string | null;
  founded: string | null;
  traction: string | null;
  careers_url: string | null;
  category: string | null;
  headquarters: string | null;
  added_at: string;
  last_checked_at: string | null;
  tracking_enabled: boolean;
  crawl_method: CrawlMethod | null;
  crawl_interval_days: number;
  last_crawl_status: CrawlStatus | null;
  last_crawl_error: string | null;
  consecutive_failures: number;
  source: string | null;
}

export interface CrawlRun {
  id: string;
  company: string;
  started_at: string;
  finished_at: string | null;
  method: CrawlMethod | null;
  roles_found: number;
  new_roles: number;
  role_titles: string[];
  status: CrawlStatus | "running";
  error: string | null;
}

export type RoleSearchFamily = "title" | "stack";

export interface RoleMatch extends Role {
  company: string;
}
