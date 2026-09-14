import { expect, test } from "vitest";
import { allowedJobSources, excludedJobSource } from "./job-source-policy";

test("excludes BuiltIn and regional hosts, including subdomains", () => {
  for (const host of ["builtin.com", "builtincolorado.com", "builtinnyc.com", "builtinsf.com", "builtinaustin.com", "builtinchicago.org", "builtinboston.com", "builtinla.com", "builtinseattle.com"]) {
    expect(excludedJobSource(`https://www.${host}/job/123`)).toBe(true);
  }
});

test("preserves independent employer URLs and other sources", () => {
  const allowed = [
    { job_url: "https://jobs.ashbyhq.com/acme/123?ref=builtin.com" },
    { job_url: "https://notbuiltin.com/job/123" },
    { job_url: "https://builtin.com.example.org/job/123" },
    { job_url: "https://indeed.com/viewjob?jk=123" },
    { job_url: null },
  ];
  expect(allowedJobSources([...allowed, { job_url: "https://builtin.com/job/123" }])).toEqual(allowed);
});
