import { beforeEach, describe, expect, test, vi } from "vitest";

// The tenant resolver is mocked: these tests are about how settings are read,
// merged and validated, and resolveTenantId reaches the session (or, under the
// platform branch, the database) before any of that runs. Which tenant the rows
// belong to is asserted where it belongs — in the SQL these tests already pin.
vi.mock("@/lib/tenant", () => ({
  resolveTenantId: async () => "00000000-0000-0000-0000-000000000001",
}));


// The only module in this file's graph that touches the network, mocked the
// same way lib/settings-store.test.ts mocks it. The loaders at the bottom of
// this file are otherwise unreachable from a test, and the property they have
// to hold — ONE read of app_settings per load — is invisible to every other
// kind of check.
vi.mock("@/lib/supabase", () => ({ rawQuery: vi.fn() }));
import {
  BUILDING_CONCEPT,
  BUILDING_UPSIDE,
  CANDIDATE_PERSONA,
  DEFAULT_CRITERIA,
  MAX_QUERY_MULTIPLIER,
  dateContextLine,
  emptySearchReason,
  loadCriteriaAndScoringInputs,
  loadScoringInputs,
  loadSearchInputs,
  pickQueries,
  planQueries,
  roleExtractionSchema,
  scoringInputsFrom,
  stackQueries,
  titleListForPrompt,
  titleQueries,
  type Criteria,
} from "./search-criteria";
import { rawQuery } from "@/lib/supabase";
import {
  DEFAULT_DOMAIN_BONUS,
  DEFAULT_MODERATE_TAIL,
  DEFAULT_STRONG_TAIL,
  DEFAULT_TITLE_SCOPE,
  DEFAULT_WEAK_FIT_TAIL,
} from "@/lib/fit-prompt";

const SMALL: Criteria = {
  titles: ["Head of RevOps", "GTM Engineer"],
  locations: ["Denver", "remote"],
  stackTerms: ["Clay", "Gong"],
  locationRule: "Remote or Colorado only.",
  fitBrain: "A candidate.",
};

describe("DEFAULT_CRITERIA", () => {
  test("target titles cover the core GTM systems roles", () => {
    const joined = DEFAULT_CRITERIA.titles.join(" | ").toLowerCase();
    expect(joined).toContain("revenue operations");
    expect(joined).toContain("gtm systems");
    expect(joined).toContain("gtm engineer");
    expect(joined).toContain("marketing operations");
  });

  test("stack terms include the GTM tools that identify these roles", () => {
    const joined = DEFAULT_CRITERIA.stackTerms.join(" ").toLowerCase();
    expect(joined).toContain("salesforce");
    expect(joined).toContain("clay");
    expect(joined).toContain("gong");
  });

  test("location rule names both the remote and Colorado conditions", () => {
    expect(DEFAULT_CRITERIA.locationRule.toLowerCase()).toContain("remote");
    expect(DEFAULT_CRITERIA.locationRule).toContain("Denver");
    expect(DEFAULT_CRITERIA.locationRule).toContain("Boulder");
  });

  test("every default list is non-empty", () => {
    expect(DEFAULT_CRITERIA.titles.length).toBeGreaterThan(0);
    expect(DEFAULT_CRITERIA.locations.length).toBeGreaterThan(0);
    expect(DEFAULT_CRITERIA.stackTerms.length).toBeGreaterThan(0);
  });

  test("fit brain describes the candidate and names a location preference", () => {
    expect(DEFAULT_CRITERIA.fitBrain.length).toBeGreaterThan(200);
    expect(DEFAULT_CRITERIA.fitBrain).toContain("Denver");
  });
});

describe("titleListForPrompt", () => {
  test("renders the supplied criteria, not the defaults", () => {
    const rendered = titleListForPrompt(SMALL);
    expect(rendered).toBe("Head of RevOps, GTM Engineer");
    expect(rendered).not.toContain("Marketing Operations");
  });

  test("has no trailing or doubled comma", () => {
    const rendered = titleListForPrompt(SMALL);
    expect(rendered.endsWith(",")).toBe(false);
    expect(rendered).not.toContain(",,");
  });
});

describe("titleQueries", () => {
  test("produces one query per title and location from the supplied criteria", () => {
    const queries = titleQueries(SMALL);
    expect(queries.length).toBe(4);
  });

  test("quotes the title so search engines match the phrase", () => {
    expect(titleQueries(SMALL)).toContain('"Head of RevOps" Denver job opening');
  });

  test("every query carries a location term", () => {
    const queries = titleQueries(SMALL);
    expect(queries.length).toBeGreaterThan(0);
    for (const q of queries) {
      expect(SMALL.locations.some((t) => q.includes(t))).toBe(true);
    }
  });

  test("returns nothing when either list is empty rather than emitting a malformed query", () => {
    expect(titleQueries({ ...SMALL, titles: [] })).toEqual([]);
    expect(titleQueries({ ...SMALL, locations: [] })).toEqual([]);
  });
});

describe("stackQueries", () => {
  test("pairs tool names with hiring language", () => {
    const queries = stackQueries(SMALL);
    expect(queries.length).toBe(4);
    expect(queries.some((q) => q.includes("Clay"))).toBe(true);
    expect(queries.every((q) => q.toLowerCase().includes("hiring"))).toBe(true);
  });

  test("every query carries a location term", () => {
    const queries = stackQueries(SMALL);
    expect(queries.length).toBeGreaterThan(0);
    for (const q of queries) {
      expect(SMALL.locations.some((t) => q.includes(t))).toBe(true);
    }
  });

  test("returns nothing when either list is empty", () => {
    expect(stackQueries({ ...SMALL, stackTerms: [] })).toEqual([]);
    expect(stackQueries({ ...SMALL, locations: [] })).toEqual([]);
  });
});

describe("pickQueries", () => {
  const list = Array.from({ length: 39 }, (_, i) => `q${i}`);

  test("returns the input unchanged when it is already within the cap", () => {
    expect(pickQueries(list.slice(0, 5), 10)).toEqual(list.slice(0, 5));
  });

  test("returns the input array itself at the equality boundary", () => {
    // toBe, not toEqual: at cap === length the striding formula yields
    // identical CONTENT via the loop path, so only reference identity proves
    // the early return fired. Mutating `<=` to `<` must fail this test.
    const list = ["a", "b", "c"];
    expect(pickQueries(list, 3)).toBe(list);
  });

  test("returns exactly the cap when the input exceeds it", () => {
    expect(pickQueries(list, 15).length).toBe(15);
  });

  test("returns no duplicates", () => {
    const picked = pickQueries(list, 15);
    expect(new Set(picked).size).toBe(picked.length);
  });

  test("every returned item comes from the input", () => {
    const picked = pickQueries(list, 15);
    expect(picked.length).toBeGreaterThan(0);
    for (const q of picked) expect(list).toContain(q);
  });

  test("spreads across the whole list rather than taking a head slice", () => {
    const picked = pickQueries(list, 15);
    expect(picked).toContain("q0");
    expect(picked.some((q) => list.indexOf(q) > 30)).toBe(true);
    expect(picked).not.toEqual(list.slice(0, 15));
  });

  test("covers every title at the default cap", () => {
    const queries = titleQueries(DEFAULT_CRITERIA);
    const picked = pickQueries(queries, 15);
    for (const title of DEFAULT_CRITERIA.titles) {
      expect(picked.some((q) => q.includes(`"${title}"`))).toBe(true);
    }
  });

  test("covers every entry in DEFAULT_CRITERIA.locations", () => {
    const queries = titleQueries(DEFAULT_CRITERIA);
    const picked = pickQueries(queries, 15);
    expect(picked.length).toBe(15);
    for (const place of DEFAULT_CRITERIA.locations) {
      expect(picked.some((q) => q.includes(place))).toBe(true);
    }
  });

  test("stack queries: covers every entry in DEFAULT_CRITERIA.stackTerms at cap 15", () => {
    const queries = stackQueries(DEFAULT_CRITERIA);
    const picked = pickQueries(queries, 15);
    expect(picked.length).toBe(15);
    for (const tool of DEFAULT_CRITERIA.stackTerms) {
      expect(picked.some((q) => q.includes(`"${tool}"`))).toBe(true);
    }
  });

  test("a cap of zero or less yields nothing", () => {
    expect(pickQueries(list, 0)).toEqual([]);
    expect(pickQueries(list, -1)).toEqual([]);
  });
});

describe("planQueries", () => {
  const list = Array.from({ length: 39 }, (_, i) => `q${i}`);

  test("no ceiling sends every query and sets max_uses to the multiple", () => {
    const plan = planQueries(list, null);
    expect(plan.queries).toBe(list);
    expect(plan.maxSearches).toBe(39 * MAX_QUERY_MULTIPLIER);
    expect(plan.reason).toContain("no ceiling set");
  });

  test("a ceiling narrows the offer AND becomes the hard cap", () => {
    // Both halves matter: the ceiling has to bind the prompt (how many we
    // offer) and max_uses (how many are billable). A change that applied it
    // to only one of the two would pass a test asserting only the other.
    const plan = planQueries(list, 12);
    expect(plan.queries.length).toBe(12);
    expect(plan.maxSearches).toBe(12);
    expect(plan.reason).toContain("ceiling 12");
  });

  test("a ceiling above the query count cannot inflate the offer", () => {
    const plan = planQueries(list, 500);
    expect(plan.queries.length).toBe(39);
  });

  test("a rejected ceiling is reported as ignored, not as absent", () => {
    // The diagnostic must not lie about the one input it exists to explain:
    // the user DID set a value and the run DID ignore it. "no ceiling set"
    // would send someone looking at the wrong thing.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const plan = planQueries(list, 0);
      expect(plan.reason).not.toContain("no ceiling set");
      expect(plan.reason).toContain("ignored");
      expect(plan.reason).toContain("0");
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toContain("ignoring a stored search ceiling");
    } finally {
      warn.mockRestore();
    }
  });

  test("an honored ceiling and an absent one warn about nothing", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      planQueries(list, 12);
      planQueries(list, null);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  test("a stored ceiling of 0 reads as 'no ceiling', never as 'zero searches'", () => {
    // The precedence trap this function exists to close. `ceiling ? a : b` is
    // falsy at 0 (sends all 39) while `ceiling ?? c` is NOT nullish at 0
    // (max_uses 0) — inconsistent, and the combination silently returns no
    // results. Whichever way 0 is resolved, the two must agree.
    const plan = planQueries(list, 0);
    expect(plan.queries.length).toBe(39);
    expect(plan.maxSearches).toBe(39 * MAX_QUERY_MULTIPLIER);
  });

  test("a negative stored ceiling reads as 'no ceiling' too", () => {
    const plan = planQueries(list, -5);
    expect(plan.queries.length).toBe(39);
    expect(plan.maxSearches).toBeGreaterThan(0);
  });

  test("max_uses is never zero, even with no queries to send", () => {
    // Every title deleted → an empty enumeration → max_uses 0, which the API
    // rejects outright rather than degrading to "no searches".
    expect(planQueries([], null).maxSearches).toBeGreaterThanOrEqual(1);
  });
});

describe("emptySearchReason", () => {
  test("a fully-populated criteria set can run either family", () => {
    expect(emptySearchReason("title", SMALL)).toBeNull();
    expect(emptySearchReason("stack", SMALL)).toBeNull();
    expect(emptySearchReason("title", DEFAULT_CRITERIA)).toBeNull();
  });

  test("an empty title list blocks the title search before anything is billed", () => {
    const reason = emptySearchReason("title", { ...SMALL, titles: [] });
    expect(reason).not.toBeNull();
    expect(reason).toContain("target titles");
    // Says what to do about it, not just that it failed.
    expect(reason).toContain("Settings");
  });

  test("an empty stack list blocks the stack search", () => {
    expect(emptySearchReason("stack", { ...SMALL, stackTerms: [] })).toContain(
      "stack terms"
    );
  });

  test("an empty location list blocks BOTH families", () => {
    // titleQueries and stackQueries both cross their list with locations, so
    // an empty locations list zeroes either enumeration.
    const empty = { ...SMALL, locations: [] };
    expect(emptySearchReason("title", empty)).toContain("location terms");
    expect(emptySearchReason("stack", empty)).toContain("location terms");
  });

  test("the other family's empty list does not block this one", () => {
    // A user who cleared stack terms can still run a title search. Blocking
    // on the wrong list would be a self-inflicted outage.
    expect(emptySearchReason("title", { ...SMALL, stackTerms: [] })).toBeNull();
    expect(emptySearchReason("stack", { ...SMALL, titles: [] })).toBeNull();
  });

  test("agrees with the enumeration it guards, in both directions", () => {
    // The guard is only worth anything if "blocked" means exactly "zero
    // queries". Pinning it against the real query builders keeps the two from
    // drifting apart, in a way that hand-written cases cannot.
    const cases: Array<Partial<Criteria>> = [
      {},
      { titles: [] },
      { stackTerms: [] },
      { locations: [] },
      { titles: [], stackTerms: [] },
      { titles: [], locations: [] },
    ];
    for (const patch of cases) {
      const c = { ...SMALL, ...patch };
      expect(emptySearchReason("title", c) === null).toBe(titleQueries(c).length > 0);
      expect(emptySearchReason("stack", c) === null).toBe(stackQueries(c).length > 0);
    }
  });
});

describe("MAX_QUERY_MULTIPLIER", () => {
  test("is pinned so changing the runaway rail is deliberate", () => {
    expect(MAX_QUERY_MULTIPLIER).toBe(2);
  });
});

describe("roleExtractionSchema", () => {
  test("names every field the Role type requires", () => {
    const schema = roleExtractionSchema(CANDIDATE_PERSONA, BUILDING_CONCEPT, BUILDING_UPSIDE);
    for (const field of [
      "role_title",
      "job_url",
      "location",
      "seniority",
      "salary_range",
      "description_summary",
      "fit_signal",
      "ic_flag",
    ]) {
      expect(schema).toContain(field);
    }
  });

  // Load-bearing: fit_signal becomes fit_summary and reaches the scorer as
  // `Summary:` (lib/ingest-roles.ts:156 → lib/fit-prompt.ts:163), so this
  // wording is an input to the fit score on every row, not a cosmetic label.
  //
  // ic_flag is asserted TWICE: once with toContain (cheap sanity check) and
  // once by isolating the exact field entry (the schema is built with
  // `.join("\n- ")`, so splitting on that separator recovers each field
  // verbatim) and comparing it with `.toBe()` against the literal text
  // pinned at 7c7cb6a:lib/search-criteria.ts:129 — byte-identical, not a
  // substring match that could pass on a superset. A one-character edit to
  // CANDIDATE_PERSONA, BUILDING_CONCEPT, or BUILDING_UPSIDE fails this test.
  test("the persona and building concept reach the schema verbatim", () => {
    const schema = roleExtractionSchema(CANDIDATE_PERSONA, BUILDING_CONCEPT, BUILDING_UPSIDE);
    expect(schema).toContain(
      "fit_signal (string, 1 sentence on why a GTM Systems / RevOps / Marketing Ops leader and AI practitioner-builder might fit)"
    );
    const ORIGINAL_IC_FLAG_LINE =
      "ic_flag (boolean — true when the role is an IC / hands-on practitioner role that centers on building GTM systems and agentic AI workflows, OR the function is early/nascent at this company and you would define it from scratch. False for standard leadership roles and for narrow IC roles at mature orgs with no systems/AI-building upside)";
    expect(schema).toContain(ORIGINAL_IC_FLAG_LINE);
    const icFlagField = schema.split("\n- ").find((line) => line.startsWith("ic_flag"));
    expect(icFlagField).toBe(ORIGINAL_IC_FLAG_LINE);
  });

  // Proves a different persona reaches BOTH grammatical forms the building
  // concept appears in — the positive gerund phrase in the true case and the
  // compressed negative adjective in the false case — not just the first one.
  test("a different persona replaces it everywhere", () => {
    const schema = roleExtractionSchema(
      "senior mechanical engineer",
      "designing mechanical systems",
      "mechanical-design"
    );
    expect(schema).not.toContain("GTM");
    expect(schema).not.toContain("RevOps");
    expect(schema).not.toContain("AI-building");
    expect(schema).toContain("senior mechanical engineer");
    expect(schema).toContain("designing mechanical systems");
    expect(schema).toContain("mechanical-design");
  });
});

describe("dateContextLine", () => {
  test("states the supplied date in ISO form", () => {
    expect(dateContextLine(new Date("2026-08-13T12:00:00Z"))).toContain("2026-08-13");
  });

  test("tracks the clock rather than hardcoding a year", () => {
    // The bug this exists to prevent was a hardcoded-feeling year. A literal
    // "2026" in the implementation would pass the test above and fail this one.
    expect(dateContextLine(new Date("2031-01-05T00:00:00Z"))).toContain("2031-01-05");
    expect(dateContextLine(new Date("2031-01-05T00:00:00Z"))).not.toContain("2026");
  });

  test("forbids appending a year, which is the observed failure", () => {
    const line = dateContextLine(new Date("2026-08-13T12:00:00Z"));
    expect(line.toLowerCase()).toContain("do not append a year");
  });
});

describe("scoringInputsFrom", () => {
  const ROWS = [
    { key: "compFloor", value: 180000 },
    { key: "searchCeiling", value: 12 },
    { key: "fitBrain", value: "stored brain" },
  ];

  test("pairs the fit brain with the floor from the SAME snapshot", () => {
    // The failure this guards is invisible: reading the brain from one read of
    // app_settings and the floor from another lets a save landing between them
    // score a batch against one version's candidate and another's minimum.
    // Nothing logs it and no integration test would catch it.
    expect(scoringInputsFrom(SMALL, ROWS)).toEqual({
      fitBrain: "A candidate.",
      compFloor: 180000,
      weakFitTail: DEFAULT_WEAK_FIT_TAIL,
      moderateTail: DEFAULT_MODERATE_TAIL,
      strongTail: DEFAULT_STRONG_TAIL,
      titleScope: DEFAULT_TITLE_SCOPE,
      domainBonus: DEFAULT_DOMAIN_BONUS,
    });
  });

  test("reads compFloor, not the search ceiling sitting next to it", () => {
    // Both are NUMBER_SETTING_KEYS, both come off the same rows, and swapping
    // the two accessors type-checks perfectly. The values differ here so the
    // transposition fails.
    expect(scoringInputsFrom(SMALL, ROWS).compFloor).toBe(180000);
    expect(scoringInputsFrom(SMALL, ROWS).compFloor).not.toBe(12);
  });

  test("no stored floor is null — the shape scoreFit reads as 'no floor'", () => {
    expect(scoringInputsFrom(SMALL, []).compFloor).toBeNull();
    expect(scoringInputsFrom(SMALL, [{ key: "searchCeiling", value: 12 }]).compFloor)
      .toBeNull();
  });

  test("a non-numeric stored floor degrades to null rather than reaching the prompt", () => {
    // A hand-edit or a bad write. `"180000"` interpolated into the floor line
    // would read as a number to the model and as a string to every comparison.
    expect(scoringInputsFrom(SMALL, [{ key: "compFloor", value: "180000" }]).compFloor)
      .toBeNull();
    expect(scoringInputsFrom(SMALL, [{ key: "compFloor", value: null }]).compFloor)
      .toBeNull();
  });

  test("takes the fit brain from the criteria it is handed, not from the rows", () => {
    // The criteria arrive already merged (defaults + overrides). Re-deriving
    // the brain from the raw rows here would drop the shipped default whenever
    // no override is stored.
    expect(scoringInputsFrom(SMALL, ROWS).fitBrain).toBe(SMALL.fitBrain);
    expect(scoringInputsFrom(SMALL, ROWS).fitBrain).not.toBe("stored brain");
  });

  test("carries nothing beyond the seven scoring inputs", () => {
    // FitInputs is deliberately narrow: it is handed down every batch path,
    // and anything extra here would widen what the crawler and the role search
    // carry around. The keys are the contract. The three tails (weakFitTail,
    // moderateTail, strongTail) and the two blocks (titleScope, domainBonus)
    // belong here for the same reason fitBrain and compFloor do: they are
    // scoring inputs, not extraction-time settings.
    const keys = Object.keys(scoringInputsFrom(SMALL, ROWS));
    expect(keys.length).toBe(7);
    expect(keys.sort()).toEqual([
      "compFloor",
      "domainBonus",
      "fitBrain",
      "moderateTail",
      "strongTail",
      "titleScope",
      "weakFitTail",
    ]);
  });
});

describe("the settings loaders", () => {
  const query = rawQuery as unknown as ReturnType<typeof vi.fn>;
  const ok = (rows: unknown[]) => ({ data: rows, error: null }) as never;
  const STORED = [
    { key: "fitBrain", value: "stored brain" },
    { key: "compFloor", value: 180000 },
    { key: "searchCeiling", value: 12 },
  ];

  beforeEach(() => {
    query.mockReset();
    query.mockResolvedValue(ok(STORED));
  });

  test("loadScoringInputs pairs the stored brain with the stored floor", async () => {
    expect(await loadScoringInputs()).toEqual({
      fitBrain: "stored brain",
      compFloor: 180000,
      weakFitTail: DEFAULT_WEAK_FIT_TAIL,
      moderateTail: DEFAULT_MODERATE_TAIL,
      strongTail: DEFAULT_STRONG_TAIL,
      titleScope: DEFAULT_TITLE_SCOPE,
      domainBonus: DEFAULT_DOMAIN_BONUS,
    });
  });

  test("loadScoringInputs reads app_settings ONCE", async () => {
    // Not loadCriteria() plus readCompFloor(). Two round trips let a save
    // landing between them score a role against one version's fit brain and
    // another version's minimum — a split nothing logs and no fixture reveals.
    await loadScoringInputs();
    expect(query).toHaveBeenCalledTimes(1);
  });

  test("loadCriteriaAndScoringInputs returns both off ONE read, agreeing", async () => {
    const { criteria, fitInputs } = await loadCriteriaAndScoringInputs();
    expect(query).toHaveBeenCalledTimes(1);
    expect(fitInputs).toEqual({
      fitBrain: "stored brain",
      compFloor: 180000,
      weakFitTail: DEFAULT_WEAK_FIT_TAIL,
      moderateTail: DEFAULT_MODERATE_TAIL,
      strongTail: DEFAULT_STRONG_TAIL,
      titleScope: DEFAULT_TITLE_SCOPE,
      domainBonus: DEFAULT_DOMAIN_BONUS,
    });
    // The crawl run context and the Discover ingest hand these two around
    // together; a fit brain that disagreed with the criteria object would
    // score roles against text the same run never searched with.
    expect(criteria.fitBrain).toBe(fitInputs.fitBrain);
  });

  test("loadSearchInputs carries the fit inputs off its own single read", async () => {
    const { criteria, ceiling, fitInputs } = await loadSearchInputs();
    expect(query).toHaveBeenCalledTimes(1);
    expect(ceiling).toBe(12);
    expect(criteria.fitBrain).toBe("stored brain");
    expect(fitInputs).toEqual({
      fitBrain: "stored brain",
      compFloor: 180000,
      weakFitTail: DEFAULT_WEAK_FIT_TAIL,
      moderateTail: DEFAULT_MODERATE_TAIL,
      strongTail: DEFAULT_STRONG_TAIL,
      titleScope: DEFAULT_TITLE_SCOPE,
      domainBonus: DEFAULT_DOMAIN_BONUS,
    });
  });

  test("with nothing stored, every loader reports no floor and the defaults", async () => {
    query.mockResolvedValue(ok([]));
    expect(await loadScoringInputs()).toEqual({
      fitBrain: DEFAULT_CRITERIA.fitBrain,
      compFloor: null,
      weakFitTail: DEFAULT_WEAK_FIT_TAIL,
      moderateTail: DEFAULT_MODERATE_TAIL,
      strongTail: DEFAULT_STRONG_TAIL,
      titleScope: DEFAULT_TITLE_SCOPE,
      domainBonus: DEFAULT_DOMAIN_BONUS,
    });
    expect((await loadCriteriaAndScoringInputs()).fitInputs.compFloor).toBeNull();
    expect((await loadSearchInputs()).fitInputs.compFloor).toBeNull();
  });

  test("a failed read degrades to the defaults rather than throwing mid-crawl", async () => {
    // readAllSettings swallows the error by design — the crawler calls this on
    // every run. What must NOT happen is a floor surviving from nowhere.
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    query.mockResolvedValue({ data: [], error: { message: "connection lost" } } as never);
    expect(await loadScoringInputs()).toEqual({
      fitBrain: DEFAULT_CRITERIA.fitBrain,
      compFloor: null,
      weakFitTail: DEFAULT_WEAK_FIT_TAIL,
      moderateTail: DEFAULT_MODERATE_TAIL,
      strongTail: DEFAULT_STRONG_TAIL,
      titleScope: DEFAULT_TITLE_SCOPE,
      domainBonus: DEFAULT_DOMAIN_BONUS,
    });
    err.mockRestore();
  });
});
