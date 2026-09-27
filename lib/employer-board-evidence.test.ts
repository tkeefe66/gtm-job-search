import { expect, test } from "vitest";
import { employerBoardEvidence } from "./employer-board-evidence";
import { parseBoardUrl, parseBoardLink } from "./job-link";

test("an employer-published bare Ashby board establishes evidence without changing posting parsing", () => {
  // Mutation: require a posting ID for employer board references.
  const url = "https://jobs.ashbyhq.com/example-labs";
  expect(parseBoardUrl(url)).toEqual({ vendor: "ashby", slug: "example-labs" });
  expect(parseBoardLink(url)).toBeNull();
  expect(employerBoardEvidence("https://example.test/careers", `<a href="${url}">Open jobs</a>`))
    .toMatchObject({ vendor: "ashby", slug: "example-labs", evidenceUrl: "https://example.test/careers", boardUrl: url });
});

test("a guessed URL mentioned as prose or conflicting published boards cannot establish ownership", () => {
  // Mutation: trust arbitrary text matches or pick the first conflicting board.
  expect(employerBoardEvidence("https://example.test/careers", "https://jobs.ashbyhq.com/example-labs")).toBeNull();
  expect(employerBoardEvidence("https://example.test/careers", '<a href="https://jobs.ashbyhq.com/a">A</a><iframe src="https://jobs.ashbyhq.com/b"></iframe>')).toBeNull();
  expect(parseBoardUrl("https://jobs.ashbyhq.com.evil.test/example")).toBeNull();
});

test("comments and scripts containing links do not fabricate employer evidence", () => {
  // Mutation: scan commented markup and stringified HTML as live page links.
  expect(employerBoardEvidence("https://example.test/jobs", '<!-- <a href="https://jobs.ashbyhq.com/wrong"> --> <script>"<a href=\'https://jobs.ashbyhq.com/wrong\'>"</script>')).toBeNull();
});
