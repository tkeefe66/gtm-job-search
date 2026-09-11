import { afterEach, expect, test, vi } from "vitest";
import { requestWithDeadline } from "./client-request";
afterEach(() => vi.useRealTimers());
// Mutation: remove the deadline branch. An unresolved RPC must release its caller.
test("a never-settling request times out without cancelling later settlement", async () => {
  vi.useFakeTimers();
  let finish!: (n:number) => void;
  const pending = new Promise<number>(resolve => { finish=resolve; });
  const outcome = expect(requestWithDeadline(pending,100)).rejects.toThrow("Server work may still finish");
  await vi.advanceTimersByTimeAsync(100);
  await outcome;
  finish(4);
  expect(await pending).toBe(4);
});
test("successful requests clear the timer and return the result", async () => {
  vi.useFakeTimers();
  expect(await requestWithDeadline(Promise.resolve(4))).toBe(4);
  expect(vi.getTimerCount()).toBe(0);
});
