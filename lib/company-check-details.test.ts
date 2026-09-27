import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import CompanyCheckDetails from "../components/CompanyCheckDetails";
import type { TrackedCompany } from "./types";

const company = { company: "Example employer", crawl_interval_days: 7, last_checked_at: "2026-09-25T15:00:00Z", last_attempted_at: "2026-09-27T15:00:00Z", last_successful_check_at: null, last_crawl_error: "Paid search is off." } as TrackedCompany;

test("renders missing historical cost and last success without inventing a free successful check", () => {
  const html = renderToStaticMarkup(createElement(CompanyCheckDetails, { company }));
  expect(html).toContain("Last successful check");
  expect(html.match(/Not recorded/g)).toHaveLength(3);
  expect(html).not.toContain("$0.00");
  expect(html).toContain("Paid search is off.");
});

test("an unavailable cost read cannot display previously loaded zeroes", () => {
  const summary = { company: company.company, month: "2026-09", knownCostMicrousd: 0, unknownRequests: 0, inFlightRequests: 0, latest: null };
  const html = renderToStaticMarkup(createElement(CompanyCheckDetails, { company, summary, costError: "Could not load costs." }));
  expect(html.match(/Unavailable/g)).toHaveLength(2);
  expect(html).not.toContain("$0.00");
  expect(html).toContain('role="alert"');
});
