import { hostOf } from "./job-link";

const EXCLUDED_HOSTS = [
  "builtin.com", "builtincolorado.com", "builtinnyc.com", "builtinsf.com",
  "builtinaustin.com", "builtinchicago.org", "builtinboston.com", "builtinla.com",
  "builtinseattle.com",
];

export const JOB_SOURCE_INSTRUCTION =
  "Do not search or use Built In (BuiltIn), including its regional sites, as a job source. " +
  "Omit postings sourced only from Built In; use independently verified employer postings instead.";

export function excludedJobSource(url: string | null | undefined): boolean {
  const host = hostOf(url);
  return host !== null && EXCLUDED_HOSTS.some((domain) => host === domain || host.endsWith(`.${domain}`));
}

/** Apply on cache reads too, so old searches cannot reintroduce excluded sources. */
export function allowedJobSources<T extends { job_url?: string | null }>(roles: T[]): T[] {
  return roles.filter((role) => !excludedJobSource(role.job_url));
}
