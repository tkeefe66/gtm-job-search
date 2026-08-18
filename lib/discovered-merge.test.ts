import { describe, expect, test } from "vitest";
import { mergeDiscoveredStartups, type DiscoveredRow } from "./discovered-merge";
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

function row(date_range: string, ...startups: Startup[]): DiscoveredRow {
  return { date_range, startups };
}

describe("mergeDiscoveredStartups", () => {
  // The Known Outstanding gap this function closes. Before companyIdentityKey
  // these two spellings keyed differently and rendered as two cards.
  test("merges name variants of one employer into a single card", () => {
    const merged = mergeDiscoveredStartups([
      row(
        "30d",
        startup({ company: "RTX (Raytheon)", signal: "Won a sustainment contract" }),
        startup({ company: "Raytheon (RTX)", signal: "Opened a Tucson facility" })
      ),
    ]);

    expect(merged).toHaveLength(1);
    expect(merged[0].signals).toEqual([
      "Won a sustainment contract",
      "Opened a Tucson facility",
    ]);
  });

  // Without this the merge is invisible: a reader cannot tell a correct merge
  // from a wrong one, and companyIdentityKey merges on a guess.
  test("records the alternate spellings it merged away", () => {
    const merged = mergeDiscoveredStartups([
      row(
        "30d",
        startup({ company: "RTX (Raytheon)", signal: "a" }),
        startup({ company: "Raytheon (RTX)", signal: "b" })
      ),
    ]);

    expect(merged[0].company).toBe("RTX (Raytheon)");
    expect(merged[0].alsoKnownAs).toEqual(["Raytheon (RTX)"]);
  });

  test("a single spelling leaves alsoKnownAs empty", () => {
    const merged = mergeDiscoveredStartups([
      row("7d", startup({ company: "Lockheed Martin", signal: "a" })),
    ]);
    expect(merged[0].alsoKnownAs).toEqual([]);
  });

  test("lists a repeated alternate spelling only once", () => {
    const merged = mergeDiscoveredStartups([
      row(
        "30d",
        startup({ company: "RTX (Raytheon)", signal: "a" }),
        startup({ company: "Raytheon (RTX)", signal: "b" }),
        startup({ company: "Raytheon (RTX)", signal: "c" })
      ),
    ]);
    expect(merged[0].alsoKnownAs).toEqual(["Raytheon (RTX)"]);
  });

  // The Lockheed case: two exact repeats under ONE spelling. The pre-fix
  // dedupe kept the first and dropped the second real signal.
  test("keeps every distinct signal under one spelling", () => {
    const merged = mergeDiscoveredStartups([
      row(
        "30d",
        startup({ company: "Lockheed Martin", signal: "Contract A" }),
        startup({ company: "Lockheed Martin", signal: "Contract B" })
      ),
    ]);
    expect(merged[0].signals).toEqual(["Contract A", "Contract B"]);
  });

  test("does not repeat an identical signal line", () => {
    const merged = mergeDiscoveredStartups([
      row("30d", startup({ company: "Acme", signal: "Same" })),
      row("7d", startup({ company: "Acme", signal: "Same" })),
    ]);
    expect(merged[0].signals).toEqual(["Same"]);
  });

  // Rows arrive fetched_at DESC, so the FIRST row wins the core fields. A
  // last-wins implementation passes every other test in this file.
  test("the first row seen wins the core fields and the range", () => {
    const merged = mergeDiscoveredStartups([
      row("7d", startup({ company: "Acme", tagline: "newest", signal: "a" })),
      row("6m", startup({ company: "Acme", tagline: "oldest", signal: "b" })),
    ]);
    expect(merged[0].tagline).toBe("newest");
    expect(merged[0].discovered_range).toBe("7d");
  });

  // Rows cached before the `signal` field existed carry the venture trio
  // instead; legacySignalFrom composes a line out of them.
  //
  // The fixture DELETES `signal` rather than setting it to "": the fallback
  // is `??`, so it fires on an ABSENT field only, and that is exactly the
  // shape a pre-`signal` cache row has at runtime despite what the type says.
  // Writing `signal: ""` here would test a shape the database never holds and
  // would report a passing implementation as broken.
  test("composes a signal for legacy rows that have none", () => {
    const legacy = startup({ company: "Acme", raised: "$40M", stage: "Series B" });
    delete (legacy as Partial<Startup>).signal;

    const merged = mergeDiscoveredStartups([row("6m", legacy)]);
    expect(merged[0].signals).toEqual(["Raised $40M (Series B)"]);
  });

  test("a row with nothing to say contributes no signal entry", () => {
    const merged = mergeDiscoveredStartups([
      row("6m", startup({ company: "Acme", signal: "" })),
    ]);
    expect(merged[0].signals).toEqual([]);
  });

  test("different employers stay separate", () => {
    const merged = mergeDiscoveredStartups([
      row(
        "7d",
        startup({ company: "Acme Health", signal: "a" }),
        startup({ company: "Acme Wealth", signal: "b" })
      ),
    ]);
    expect(merged).toHaveLength(2);
  });

  test("no rows yields no cards", () => {
    expect(mergeDiscoveredStartups([])).toEqual([]);
  });
});
