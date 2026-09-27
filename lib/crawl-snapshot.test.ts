import { expect, test } from "vitest";
import { contentFingerprint, pageFingerprint, criteriaFingerprint, listingKey, candidatesToProcess } from "./crawl-snapshot";

const role = { role_title: "Systems Lead", job_url: "https://jobs.ashbyhq.com/example/req1", location: "Remote", salary_range: "$200000", description_summary: "Build systems", seniority: "Lead", fit_signal: "", ic_flag: false };

test("compensation body and location changes invalidate processing while whitespace does not", () => {
  // Mutation: omit compensation/body/location from identity, or hash raw whitespace.
  const hash = contentFingerprint(role);
  expect(contentFingerprint({ ...role, salary_range: "$250000" })).not.toBe(hash);
  expect(contentFingerprint({ ...role, description_summary: "Manage teams" })).not.toBe(hash);
  expect(contentFingerprint({ ...role, location: "Chicago" })).not.toBe(hash);
  expect(contentFingerprint({ ...role, description_summary: " Build   systems\n" })).toBe(hash);
});

test("page ordering and whitespace reuse extraction but criteria changes do not", () => {
  // Mutation: include unstable link order, or drop effective company criteria.
  const links = [{ text: " A ", href: "/jobs/a" }, { text: "B", href: "/jobs/b" }];
  expect(pageFingerprint({text:"Jobs  here",links}, "https://example.test/careers"))
    .toBe(pageFingerprint({text:"Jobs\nhere",links:links.slice().reverse()}, "https://example.test/careers"));
  expect(criteriaFingerprint({ locationRule: "Remote" })).not.toBe(criteriaFingerprint({ locationRule: "Anywhere" }));
});

test("only a successful receipt suppresses processing and stable ATS identity retains ID case", () => {
  // Mutation: consider observed-but-failed content processed, or lowercase posting IDs.
  const entry = { role, hash: contentFingerprint(role) };
  expect(candidatesToProcess([entry], {})).toEqual([entry]);
  expect(candidatesToProcess([entry], { [listingKey(role)]: entry.hash })).toEqual([]);
  expect(listingKey({...role,job_url:role.job_url.replace("req1","REQ1")})).not.toBe(listingKey(role));
});
