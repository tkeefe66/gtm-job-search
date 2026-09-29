import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import WatchlistCheckSelection from "../components/WatchlistCheckSelection";
import type { TrackedCompany } from "./types";
import type { WatchlistBatchProgress } from "./watchlist-batch";

const company = (name: string, status: string | null, error: string | null): TrackedCompany => ({
  company: name, last_crawl_status: status, last_crawl_error: error,
  consecutive_failures: 0, last_checked_at: "2026-09-29T10:00:00Z",
} as TrackedCompany);
const render = (companies: TrackedCompany[]) => renderToStaticMarkup(createElement(WatchlistCheckSelection, { companies, onReview: () => {} }));

// Mutation: put per-company explanations back, omit names, or only group the post-batch results.
test("the initial twelve-company selection explains two shared issues once and exposes every company", () => {
  const html = render([
    ...Array.from({ length: 10 }, (_, i) => company(`Unreadable ${i}`, "skipped", "Direct check finished. Choose Deep search to search beyond direct sources.")),
    ...Array.from({ length: 2 }, (_, i) => company(`Incomplete ${i}`, "partial", "Listings were checked; some processing is incomplete or the search covered only part of the source. Try again or review the saved roles.")),
  ]);
  expect(html.match(/<h4 /g)).toHaveLength(2);
  expect(html.match(/Next step:/g)).toHaveLength(2);
  expect(html.match(/exact cause wasn’t recorded/g)).toHaveLength(1);
  expect(html.match(/aria-label="Review /g)).toHaveLength(12);
  expect(html).toContain("10 companies");
  expect(html).toContain("2 companies");
  for (let i = 0; i < 10; i++) expect(html).toContain(`aria-label="Review Unreadable ${i}"`);
  for (let i = 0; i < 2; i++) expect(html).toContain(`aria-label="Review Incomplete ${i}"`);
  expect(html).toContain("Deep search (up to 5 paid searches)");
  expect(html).toContain("Review saved roles in Roles, then use Check now");
  expect(html).not.toContain("<details");
});

// Mutation: classify routine scheduled checks as failures or discard their selection reason.
test("scheduled and first checks stay separate from unresolved checks", () => {
  const html = render([
    company("Scheduled", "ok", null),
    { ...company("First", null, null), last_checked_at: null },
    { ...company("Repeated", null, null), consecutive_failures: 4 },
    company("Unknown", "error", ""),
  ]);
  expect(html).toContain("Due for a check");
  expect(html).toContain("Not checked yet");
  expect(html).toContain("4 unsuccessful checks in a row");
  expect(html).toContain("Check failed");
  expect(html).toContain("No reason was recorded");
  expect(html.match(/<h4 /g)).toHaveLength(4);
});

// Mutation: group by label alone and lose the second company's distinct cause.
test("different recorded causes keep their own explanations in the selection", () => {
  const html = render([company("Blocked", "error", "HTTP 403"), company("Unavailable", "error", "HTTP 503")]);
  expect(html).toContain("HTTP 403");
  expect(html).toContain("HTTP 503");
  expect(html.match(/<h4 /g)).toHaveLength(2);
});

// Mutation: suppress the current selection after any result, hiding stopped or newly added work.
test("after a batch, current candidates remain inspectable and a stopped batch exposes them immediately", () => {
  const previousBatch: WatchlistBatchProgress = {
    total: 3, completed: 1, currentCompany: null, stopped: true, interrupted: false,
    results: [{ company: "Already checked", outcome: { company: "Already checked", method: "fetch", status: "ok", rolesFound: 1, newRoles: 1 } }],
  };
  const companies = [company("Not checked", null, null), company("Newly added", null, null)];
  const stopped = renderToStaticMarkup(createElement(WatchlistCheckSelection, { companies, previousBatch, onReview: () => {} }));
  expect(stopped).toMatch(/<details[^>]*open=""/);
  expect(stopped).toContain("2 companies selected for the next check");
  expect(stopped).toContain('aria-label="Review Not checked"');
  expect(stopped).toContain('aria-label="Review Newly added"');
  const finished = renderToStaticMarkup(createElement(WatchlistCheckSelection, { companies, previousBatch: { ...previousBatch, stopped: false }, onReview: () => {} }));
  expect(finished).toContain("<details");
  expect(finished).not.toMatch(/<details[^>]*open=/);
  expect(finished).toContain('aria-label="Review Newly added"');
});
