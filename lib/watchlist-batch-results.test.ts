import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import WatchlistBatchResults from "../components/WatchlistBatchResults";
import type { WatchlistBatchProgress } from "./watchlist-batch";

const progress = (results: WatchlistBatchProgress["results"]): WatchlistBatchProgress => ({
  total: results.length, completed: results.length, currentCompany: null, stopped: false, interrupted: false, results,
});
const render = (value: WatchlistBatchProgress) => renderToStaticMarkup(createElement(WatchlistBatchResults, { progress: value, onReview: () => {} }));

// Mutation: mix successes into the action count, drop any of the twelve follow-ups, or hide them inside the successful-results disclosure.
test("all twelve unresolved companies have visible reasons and review controls ahead of successes", () => {
  const results: WatchlistBatchProgress["results"] = Array.from({ length: 12 }, (_, i) => ({ company: `Company ${i + 1}`,
    outcome: { company: `Company ${i + 1}`, method: "fetch", status: "skipped", rolesFound: 0, newRoles: 0,
      error: "Direct check finished. Choose Deep search to search beyond direct sources." },
  }));
  results.unshift({ company: "Completed company", outcome: { company: "Completed company", method: "fetch", status: "ok", rolesFound: 5, newRoles: 2 } });
  const html = render(progress(results));
  const visible = html.slice(0, html.indexOf("<details"));
  expect(visible).toContain("12 companies need a next step");
  expect(visible.match(/aria-label="Review Company /g)).toHaveLength(12);
  for (let i = 1; i <= 12; i++) expect(visible).toContain(`aria-label="Review Company ${i}"`);
  expect(visible).toContain("Next step:");
  expect(visible).toContain("5 paid searches");
  expect(visible).not.toContain("Direct check finished");
  expect(visible).not.toContain("Completed company");
  expect(visible).not.toMatch(/overflow-y|max-h-/);
  expect(html).toContain("1 company completed — no action needed");
  expect(html).toContain("2 new roles");
});

// Mutation: group only by status/label, hiding different counts or recorded causes under a shared explanation.
test("companies with different recorded reasons retain separate explanations", () => {
  const html = render(progress([1, 2].map(n => ({ company: `Pending ${n}`, outcome: {
    company: `Pending ${n}`, status: "partial", method: "fetch", rolesFound: 3, newRoles: 0,
    error: `${n} matching role${n === 1 ? " still needs" : "s still need"} processing.`,
  } }))));
  expect(html).toContain("1 matching role still needs processing.");
  expect(html).toContain("2 matching roles still need processing.");
});

// Mutation: treat an empty unconfirmed-request error as success, or turn a completed empty listing into an issue.
test("unknown request outcomes remain actionable while successful zero-result checks do not", () => {
  const html = render({ ...progress([
    { company: "Unconfirmed", error: "" },
    { company: "No matches", outcome: { company: "No matches", method: "fetch", status: "empty", rolesFound: 0, newRoles: 0 } },
    { company: "Unchanged", outcome: { company: "Unchanged", method: "fetch", status: "unchanged", rolesFound: 4, newRoles: 0 } },
  ]), completed: 2, interrupted: true });
  expect(html).toContain("1 company needs a next step");
  expect(html).toContain("Result not confirmed");
  expect(html).toContain("Reload the watchlist");
  expect(html).toContain("2 companies completed — no action needed");
  expect(html).toContain("2 of 3 checks returned");
});

// Mutation: show a stopped batch as fully finished or omit the companies that never ran.
test("a stopped batch names how much work remains without labelling it failed", () => {
  const html = render({ ...progress([]), total: 4, stopped: true });
  expect(html).toContain("Batch stopped");
  expect(html).toContain("4 companies were not checked");
  expect(html).not.toContain("need a next step");
});
