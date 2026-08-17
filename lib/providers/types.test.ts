import { describe, expect, test } from "vitest";
import { mustRefuseSearch } from "./types";

// The spec: "On a provider reporting `none`, a metered tier's search calls are
// REFUSED, not silently uncapped — the admin daily cap is runaway protection
// and must not degrade to a pre-call check."
describe("mustRefuseSearch", () => {
  test("a metered call on a provider that cannot cap in-request is refused", () => {
    expect(mustRefuseSearch("none", 12)).toBe(true);
  });

  test("an uncapped (BYO) call is allowed even when the provider cannot cap", () => {
    // Null is BYO: the tenant spends their own money and is recorded, not rationed.
    expect(mustRefuseSearch("none", null)).toBe(false);
  });

  test("a provider that caps in-request is never refused", () => {
    expect(mustRefuseSearch("in-request", 12)).toBe(false);
    expect(mustRefuseSearch("in-request", null)).toBe(false);
  });

  test("a cap of zero is still a cap, and still refused on a provider that cannot enforce it", () => {
    expect(mustRefuseSearch("none", 0)).toBe(true);
  });
});
