import { expect, test } from "vitest";
import { parseSpendDollars } from "./spend-limits";

// Mutation: Number("") turns an unset limit into a zero pause.
test("blank dollars are unset while a typed zero is a pause", () => {
  expect(parseSpendDollars("  ")).toBeNull();
  expect(parseSpendDollars("0")).toBe(0);
  expect(parseSpendDollars("1.25")).toBe(125);
});

// Mutation: parseFloat silently accepts trailing text or rounds fractional cents.
test.each(["1.005", "1e3", "-1", "abc", "1 dollar", "Infinity", "1000000.01"])("reject invalid dollar input %s", (value) => {
  expect(parseSpendDollars(value)).toBeUndefined();
});
