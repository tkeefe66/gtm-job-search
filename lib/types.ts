export type JobStatus =
  | "Tracking"
  | "Applied"
  | "Interviewing"
  | "Offer"
  | "Passed";

export const JOB_STATUSES: JobStatus[] = [
  "Tracking",
  "Applied",
  "Interviewing",
  "Offer",
  "Passed",
];

export type Seniority = "VP/CPO" | "Director" | "Senior PM" | "PM";

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
}

export interface Role {
  role_title: string;
  job_url: string;
  location: string;
  seniority: Seniority | string;
  description_summary: string;
  fit_signal: string;
}

export interface RolesResult {
  roles: Role[];
  message?: string;
}

export interface Job {
  id: string;
  company: string;
  role_title: string;
  status: JobStatus;
  seniority: string | null;
  location: string | null;
  job_url: string | null;
  careers_url: string | null;
  category: string | null;
  raised: string | null;
  stage: string | null;
  traction: string | null;
  notes: string | null;
  fit_score: number | null;
  fit_summary: string | null;
  added_date: string | null;
  applied_date: string | null;
  created_at: string;
  updated_at: string;
}

export type JobInsert = Partial<Omit<Job, "id" | "created_at" | "updated_at">> & {
  company: string;
  role_title: string;
};

export interface CompanyArchetype {
  archetype: string;
  description: string;
  example_companies: string[];
}

export interface Insights {
  top_skills_in_demand: string[];
  common_themes: string[];
  gap_analysis: string;
  positioning_advice: string;
  company_archetypes: CompanyArchetype[];
  recommended_next_searches: string[];
}
