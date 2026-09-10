import { expect, test, vi } from "vitest";
const { completeDetailed } = vi.hoisted(() => ({ completeDetailed: vi.fn() }));
vi.mock("./model-call", async (original) => ({
  ...await original<typeof import("./model-call")>(), completeDetailed,
}));
import { parseJson } from "./model-call";
import { arrayUnder, parseOrSalvage } from "./salvage-call";
import { rolesFrom, rolesFromRaw } from "./crawler";

test.each(["max_tokens", "pause_turn", "refusal", null])("rejects parseable incomplete search (%s)", async stopReason => {
  // Mutation: move the completion guard into the parse catch.
  await expect(parseOrSalvage({ raw: '{"roles":[]}', stopReason, key: "roles", itemNoun: "role", label: "test", extract: rolesFrom })).rejects.toThrow();
});
test("rejects unexpected envelopes instead of creating empty results", () => {
  // Mutation: default a missing array to []. Synthetic malformed model output.
  for (const extract of [rolesFrom, arrayUnder("roles")]) {
    expect(() => extract({ error: "Could not read listing" })).toThrow();
    expect(() => extract({ roles: [null] })).toThrow();
  }
  expect(() => rolesFromRaw('{"error":"Could not read listing"}')).toThrow();
  expect(() => rolesFrom({ roles: [{ role_title: "Director", job_url: {} }] })).toThrow();
  expect(() => rolesFrom({ roles: [{ role_title: "Director", requirements: "Not an array" }] })).toThrow();
});
test("rejects a truncated recovery even when its JSON parses", async () => {
  // Mutation: use text-only complete or ignore the recovery's stop reason.
  completeDetailed.mockResolvedValue({ text: '{"roles":[]}', stopReason: "max_tokens" });
  await expect(parseOrSalvage({ raw: "Found some roles", stopReason: "end_turn", key: "roles", itemNoun: "role", label: "test", extract: rolesFrom })).rejects.toThrow();
  expect(completeDetailed).toHaveBeenCalledWith(expect.objectContaining({ maxTokens: 16000 }));
});
test("extracts JSON after bracketed narration without accepting nested fragments", () => {
  // Mutation: slice between first and last bracket, or parse a nested array from a broken object.
  expect(parseJson('I checked [1].\n[{"role_title":"Director"}]')).toEqual([{ role_title: "Director" }]);
  expect(parseJson('Result: {"text":"a } and [ inside a string"} [1]')).toEqual({ text: "a } and [ inside a string" });
  expect(() => parseJson('{"roles":[]')).toThrow();
});
