export type JobStatus =
  | "New"
  | "Applied"
  | "Recruiter Outreach"
  | "Phone / Intro Screen"
  | "Hiring Manager"
  | "Panel Interviews"
  | "Exec Presentation"
  | "Reference Check"
  | "Offer"
  | "Not Interested"
  | "Rejected"
  | "Passed"
  | "Posting Closed";

export const JOB_STATUSES: JobStatus[] = [
  "New",
  "Applied",
  "Recruiter Outreach",
  "Phone / Intro Screen",
  "Hiring Manager",
  "Panel Interviews",
  "Exec Presentation",
  "Reference Check",
  "Offer",
  "Not Interested",
  "Rejected",
  "Passed",
  "Posting Closed",
];

export const ACTIVE_STATUSES: JobStatus[] = [
  "Applied",
  "Recruiter Outreach",
  "Phone / Intro Screen",
  "Hiring Manager",
  "Panel Interviews",
  "Exec Presentation",
  "Reference Check",
];

export const TERMINAL_STATUSES: JobStatus[] = [
  "Not Interested",
  "Rejected",
  "Passed",
  "Posting Closed",
];

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
  headquarters: string;
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
