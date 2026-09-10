import { expect, test, vi } from "vitest";
import { runRoleSearchBatches } from "./role-search-batches";

test("50 queries run in five bounded calls, with no duplicated query", async () => {
  // Mutation: put the full grid in one request or apply 50 separately to each batch.
  const queries = Array.from({ length: 50 }, (_, i) => `q${i}`);
  const run = vi.fn(async () => [{ company: "Acme", role_title: "Director" }]);
  const result = await runRoleSearchBatches(queries, 50, run);
  expect(run).toHaveBeenCalledTimes(5);
  expect(run.mock.calls.flatMap(call => (call as unknown as [string[]])[0])).toEqual(queries);
  expect(run.mock.calls.every(call => (call as unknown as [string[], number])[1] <= 10)).toBe(true);
  expect(result.items).toHaveLength(1);
  expect(result.error).toBeUndefined();
});
test("later failure preserves earlier results and stops further spending", async () => {
  // Mutation: throw away earlier batches or continue billing after a failed batch.
  const run = vi.fn().mockResolvedValueOnce([{ company: "Acme", role_title: "Director" }]).mockRejectedValue(new Error("limit"));
  const result = await runRoleSearchBatches(Array.from({ length: 50 }, (_, i) => `q${i}`), 50, run);
  expect(result.items).toHaveLength(1);
  expect(result.error).toContain("Partial results");
  expect(run).toHaveBeenCalledTimes(2);
});

test("never discards valid paid-for results when the model exceeds its result target", async () => {
  // Mutation: slice the accumulated results, losing later batches without a warning.
  const items = Array.from({ length: 30 }, (_, i) => ({ company: `Company ${i}`, role_title: "Director" }));
  const result = await runRoleSearchBatches(["query"], 1, async () => items);
  expect(result.items).toEqual(items);
});
