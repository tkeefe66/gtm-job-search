import { readFileSync } from "node:fs";
import { expect, test } from "vitest";

test("model crawl failures cannot disable tracking or increment dead-page evidence", () => {
  // Mutation: restore the generic error -> consecutive_failures -> untrack path.
  const source = readFileSync("lib/crawler.ts", "utf8");
  expect(source).not.toMatch(/tracking_enabled\s*=\s*false/);
  expect(source).not.toMatch(/consecutive_failures\s*\+\s*1/);
  expect(source).toContain('const healthy = status === "ok" || status === "empty"');
  expect(source).toContain("case when $5 then 0 else consecutive_failures end");
  expect(source).toContain("case when $5 then null else failing_since end");
});
