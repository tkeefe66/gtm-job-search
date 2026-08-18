import { beforeEach, describe, expect, test, vi } from "vitest";

// vi.hoisted rather than a top-level await import: vi.mock is hoisted above
// const declarations, and a top-level await here fails tsc under this repo's
// module target even though vitest runs it happily.
const { complete } = vi.hoisted(() => ({ complete: vi.fn() }));

vi.mock("@/lib/model-call", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./model-call")>();
  return { ...actual, complete };
});

import { arrayUnder, parseOrSalvage } from "./salvage-call";

beforeEach(() => {
  complete.mockReset();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});

const PROSE = "I found a careers page but no qualifying roles at this time.";

describe("parseOrSalvage on a response that parses", () => {
  test("returns the parsed items without calling the model", async () => {
    // Mutation this catches: salvaging unconditionally rather than only on a
    // parse failure. That would double the cost of every single search call in
    // the app while still returning the right answer — green tests, silent bill.
    const out = await parseOrSalvage({
      raw: JSON.stringify([{ role_title: "GTM Engineer" }]),
      stopReason: "end_turn",
      key: "roles",
      itemNoun: "role",
      label: "test",
      extract: arrayUnder("roles"),
    });

    expect(out.items).toEqual([{ role_title: "GTM Engineer" }]);
    expect(out.salvaged).toBe(false);
    expect(complete).not.toHaveBeenCalled();
  });
});

describe("parseOrSalvage on prose", () => {
  test("recovers the items through a constrained-decoding call", async () => {
    complete.mockResolvedValue(JSON.stringify({ roles: [{ role_title: "Head of RevOps" }] }));

    const out = await parseOrSalvage({
      raw: PROSE,
      stopReason: "end_turn",
      key: "roles",
      itemNoun: "role",
      label: "test",
      extract: arrayUnder("roles"),
    });

    expect(out.items).toEqual([{ role_title: "Head of RevOps" }]);
    expect(out.salvaged).toBe(true);
  });

  test("sends the prose verbatim and forces the caller's key", async () => {
    // Mutation this catches: calling complete() WITHOUT jsonSchema. The salvage
    // would then be free to answer in prose again — the exact failure it exists
    // to fix — and the test would still pass on the happy path because the mock
    // returns JSON regardless. Asserting the schema is what discriminates.
    complete.mockResolvedValue(JSON.stringify({ startups: [] }));

    await parseOrSalvage({
      raw: PROSE,
      stopReason: null,
      key: "startups",
      itemNoun: "company",
      label: "test",
      extract: arrayUnder("startups"),
    });

    const arg = complete.mock.calls[0][0];
    expect(arg.prompt).toContain(PROSE);
    expect(arg.jsonSchema.required).toEqual(["startups"]);
    // No search on the salvage call — it is a reformat, not a second search.
    expect(arg).not.toHaveProperty("maxSearches");
  });

  test("a null stop reason still salvages", async () => {
    // Mutation this catches: treating an unknown/absent stop_reason as
    // truncation. Every prose response from a provider that does not report
    // one would become a hard failure — and in the crawler, a dead-page signal.
    complete.mockResolvedValue(JSON.stringify({ roles: [] }));

    const out = await parseOrSalvage({
      raw: PROSE, stopReason: null, key: "roles", itemNoun: "role",
      label: "test", extract: arrayUnder("roles"),
    });

    expect(out.salvaged).toBe(true);
  });
});

describe("parseOrSalvage on a truncated response", () => {
  test("rethrows without calling the model", async () => {
    // Mutation this catches: dropping the stop_reason gate so truncation
    // salvages too. Re-reading incomplete narration manufactures a confident
    // empty answer — and in the crawler an empty run is trusted as evidence
    // that closes live postings.
    await expect(
      parseOrSalvage({
        raw: PROSE, stopReason: "max_tokens", key: "roles", itemNoun: "role",
        label: "test", extract: arrayUnder("roles"),
      })
    ).rejects.toThrow();

    expect(complete).not.toHaveBeenCalled();
  });
});

describe("parseOrSalvage when the salvage itself fails", () => {
  test("rethrows the ORIGINAL parse error, not the salvage error", async () => {
    // Mutation this catches: rethrowing salvageErr. The user- or log-facing
    // message would then describe a follow-up call nobody knows happened,
    // hiding what the search actually returned.
    complete.mockRejectedValue(new Error("rate limited"));

    await expect(
      parseOrSalvage({
        raw: PROSE, stopReason: "end_turn", key: "roles", itemNoun: "role",
        label: "test", extract: arrayUnder("roles"),
      })
    ).rejects.toThrow(/is not valid JSON/);
  });

  test("rethrows the original error when the salvage returns prose too", async () => {
    complete.mockResolvedValue("Still prose, sorry.");

    await expect(
      parseOrSalvage({
        raw: PROSE, stopReason: "end_turn", key: "roles", itemNoun: "role",
        label: "test", extract: arrayUnder("roles"),
      })
    ).rejects.toThrow();
  });
});

describe("arrayUnder", () => {
  test("accepts a bare array, which is what the search prompts ask for", () => {
    expect(arrayUnder("roles")([{ a: 1 }])).toEqual({ items: [{ a: 1 }] });
  });

  test("accepts the keyed object the salvage schema produces", () => {
    // Mutation this catches: handling only the bare-array shape. Every salvage
    // would then extract zero items while reporting success — the failure mode
    // is a silent empty result, not an error.
    expect(arrayUnder("roles")({ roles: [{ a: 1 }], message: "why" })).toEqual({
      items: [{ a: 1 }],
      message: "why",
    });
  });

  test("reads the message only from the keyed shape", () => {
    expect(arrayUnder("roles")({ roles: [], message: "none open" }).message).toBe("none open");
  });

  test("a keyed object whose array is missing yields no items rather than throwing", () => {
    expect(arrayUnder("roles")({ message: "none" })).toEqual({ items: [], message: "none" });
  });

  test("ignores a non-string message", () => {
    // Mutation this catches: passing `message` through unchecked. It reaches
    // the UI, so a number or object there renders as garbage.
    expect(arrayUnder("roles")({ roles: [], message: 42 }).message).toBeUndefined();
  });
});
