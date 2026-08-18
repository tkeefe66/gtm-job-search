import { describe, expect, test } from "vitest";
import { displayableExtras, watchlistSignalFields } from "./watchlist-signal";
import type { Startup } from "./types";

function startup(over: Partial<Startup> & { company: string }): Startup {
  return {
    tagline: "",
    raised: "",
    stage: "",
    lead_investor: "",
    founded: "",
    traction: "",
    careers_url: "",
    category: "",
    headquarters: "",
    location: "",
    signal: "",
    extras: {},
    ...over,
  };
}

describe("watchlistSignalFields", () => {
  test("keeps the model's signal sentence verbatim", () => {
    const { signal } = watchlistSignalFields(
      startup({ company: "Acme", signal: "Won $2.1B USAF sustainment contract" })
    );
    expect(signal).toBe("Won $2.1B USAF sustainment contract");
  });

  // `??` would store "" here and the row would render blank forever. This is
  // the mutation the test exists to catch.
  test("composes from legacy fields when the signal is an empty string", () => {
    const { signal } = watchlistSignalFields(
      startup({ company: "Acme", signal: "", raised: "$40M", stage: "Series B" })
    );
    expect(signal).toBe("Raised $40M (Series B)");
  });

  // null, not "": the column has to distinguish "nothing recorded" from
  // "recorded as blank", because Watchlist falls back to the legacy tags only
  // for the former.
  test("is null when there is nothing at all to say", () => {
    expect(watchlistSignalFields(startup({ company: "Acme" })).signal).toBeNull();
  });

  test("carries extras through untouched", () => {
    const { extras } = watchlistSignalFields(
      startup({
        company: "Acme",
        extras: { contract_value: "$2.1B", awarding_agency: "USAF" },
      })
    );
    expect(extras).toEqual({ contract_value: "$2.1B", awarding_agency: "USAF" });
  });

  // Rows cached before `extras` existed have no such key at runtime despite
  // the type. Without the `?? {}` this writes undefined into a NOT NULL column.
  test("defaults absent extras to an empty object", () => {
    const s = startup({ company: "Acme" });
    delete (s as Partial<Startup>).extras;
    expect(watchlistSignalFields(s).extras).toEqual({});
  });
});

describe("displayableExtras", () => {
  test("preserves the order the profile named the fields in", () => {
    expect(
      displayableExtras({ contract_value: "$2.1B", awarding_agency: "USAF" })
    ).toEqual([
      ["contract_value", "$2.1B"],
      ["awarding_agency", "USAF"],
    ]);
  });

  // A model that could not find a field returns it empty rather than omitting
  // it; rendering those produces a row of blank tags.
  test("drops empty and whitespace-only values", () => {
    expect(
      displayableExtras({ a: "keep", b: "", c: "   ", d: "also keep" })
    ).toEqual([
      ["a", "keep"],
      ["d", "also keep"],
    ]);
  });

  test("null and undefined yield nothing", () => {
    expect(displayableExtras(null)).toEqual([]);
    expect(displayableExtras(undefined)).toEqual([]);
  });

  test("an empty object yields nothing", () => {
    expect(displayableExtras({})).toEqual([]);
  });
});
