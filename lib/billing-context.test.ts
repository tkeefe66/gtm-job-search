import { expect, test } from "vitest";
import { recordUsage, runWithBilling, type BillingScope } from "./billing-context";

// Mutation: drop grounding requests, or count search queries as billable prompts.
test("keeps grounded requests separate from search query count across nested calls", async () => {
  const scope: BillingScope = { maxSearches: null, apiKey: "test", provider: "google", model: "gemini-2.5-flash", searches: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 };
  await runWithBilling(scope, async () => {
    recordUsage({ searches: 3, groundedRequests: 1, inputTokens: 100 });
    recordUsage({ searches: 2, groundedRequests: 1, outputTokens: 50 });
    recordUsage({ outputTokens: 20 });
  });
  expect(scope.searches).toBe(5);
  expect(scope.groundedRequests).toBe(2);
  expect(scope.outputTokens).toBe(70);
});
