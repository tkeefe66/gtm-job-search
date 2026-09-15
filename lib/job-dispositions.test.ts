import { expect, test } from "vitest";
import { dispositionStatus, sourceIdentity, groupSources, type SourceRecord } from "./job-dispositions";
import { DEFAULT_STATUSES } from "./job-statuses";

test("missing job is filed without claiming formal closure", () => {
  expect(dispositionStatus("job_not_found", DEFAULT_STATUSES)).toBe("Not Interested");
  expect(dispositionStatus("posting_closed", DEFAULT_STATUSES)).toBe("Posting Closed");
  expect(dispositionStatus("duplicate", DEFAULT_STATUSES.filter(s => s.key === "Posting Closed"))).toBeNull();
});

test("source identity respects hostname boundaries and separate ATS employers", () => {
  expect(sourceIdentity("https://www.builtincolorado.com/job/1", "Acme")).toBe("BuiltIn");
  expect(sourceIdentity("https://builtin.com.evil.test/1", "Acme")).toBe("builtin.com.evil.test");
  expect(sourceIdentity("https://jobs.lever.co/acme/1", "Acme")).toBe("jobs.lever.co/acme");
  expect(sourceIdentity("https://jobs.lever.co/other/1", "Other")).not.toBe("jobs.lever.co/acme");
  expect(sourceIdentity("https://jobs.smartrecruiters.com/Acme/123", "Acme")).toBe("jobs.smartrecruiters.com/Acme");
  expect(sourceIdentity("https://jobs.jobvite.com/other/job/123", "Other")).toBe("jobs.jobvite.com/other");
  expect(sourceIdentity(null, "Acme")).toBe("Unknown source");
});

test("report denominator separates legacy feedback, and counts each role once", () => {
  const base = {id:"a", job_id:"job-a", company:"Acme", role_title:"Director", source_url:"https://indeed.com/viewjob?jk=1", source_method:"Role Search", discovered_at:"2026-09-14T00:00:00Z", cohort:"new", status:"Not Interested", disposition:"job_not_found", disposition_reason:null, actor:"user", occurred_at:"2026-09-15T00:00:00Z", never_live:false, event_count:3} as SourceRecord;
  const grouped = groupSources([base, {...base,id:"b",cohort:"legacy"}, {...base,id:"c",disposition:null,status:"New"}], "new");
  expect(grouped[0].total).toBe(2);
  expect(grouped[0].counts.job_not_found).toBe(1);
  expect(grouped[0].humanFeedback).toBe(1);
  expect(groupSources([base, {...base,id:"b",cohort:"legacy"}], "legacy")[0].total).toBe(1);
});
