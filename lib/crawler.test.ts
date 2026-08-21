import { describe, expect, test, vi } from "vitest";

// The session guard is mocked, not exercised: these tests are about each
// action's own failure reporting, and requireActor() would otherwise throw
// before any of that ran. That the guard EXISTS on every action is asserted
// separately, in app/actions/auth-required.test.ts — mocking it here would
// otherwise quietly delete that coverage.
vi.mock("@/lib/require-actor", () => ({
  requireActor: async () => ({
    userId: "test-user",
    tenantId: "test-user",
    email: "test@example.com",
    isAdmin: false,
  }),
}));

import {
  buildExtractionPrompt,
  classifyFetchOutcome,
  closureEvidenceTitles,
  closureRunsFromRows,
  criteriaForCompany,
  LAST_TRUSTWORTHY_RUN_SQL,
  rolesFromRaw,
  runProvidesClosureEvidence,
  runsEligibleForClosure,
  STALE_POSTING_CANDIDATES_SQL,
  titlesToClose,
  type ClosureRun,
} from "./crawler";
import { stripHtml } from "./page-extract";
import { DEFAULT_CRITERIA, type Criteria } from "./search-criteria";
import { DEFAULT_PROFILE } from "./profile";

// Reused from lib/page-extract.test.ts's own fixtures so the shell/content
// boundary this test relies on stays the one that file already pins.
const REAL_PAGE = `
<html><head><style>.a{color:red}</style><script>var x=1;</script></head>
<body>
  <nav><a href="/about">About us</a></nav>
  <h1>Open roles at Example</h1>
  <p>We are hiring across go-to-market and engineering. ${"Filler sentence about the team and mission. ".repeat(20)}</p>
  <ul>
    <li><a href="/careers/head-of-revops">Head of Revenue Operations</a></li>
    <li><a href="/careers/gtm-engineer">GTM Engineer</a></li>
    <li><a href="/careers/marketing-ops">Marketing Operations Manager</a></li>
    <li><a href="/careers/backend-eng">Backend Engineer</a></li>
  </ul>
  <footer><a href="/privacy">Privacy</a></footer>
</body></html>`;

const ATS_SHELL = `
<html><head><script src="https://boards.greenhouse.io/embed/job_board/js?for=example"></script></head>
<body><div id="grnhse_app"></div></body></html>`;

describe("buildExtractionPrompt", () => {
  const page = stripHtml(
    `<p>Open roles</p><a href="/careers/revops">Head of RevOps</a>`
  );

  test("names the company", () => {
    expect(
      buildExtractionPrompt(
        "Clay",
        page,
        DEFAULT_CRITERIA,
        DEFAULT_PROFILE.candidatePersona,
        DEFAULT_PROFILE.buildingConcept,
        DEFAULT_PROFILE.buildingUpside
      )
    ).toContain("Clay");
  });

  test("includes the location rule", () => {
    // "Denver" reaches the prompt only through criteria.locationRule — it
    // appears nowhere else in the template. Keep this assertion as-is.
    expect(
      buildExtractionPrompt(
        "Clay",
        page,
        DEFAULT_CRITERIA,
        DEFAULT_PROFILE.candidatePersona,
        DEFAULT_PROFILE.buildingConcept,
        DEFAULT_PROFILE.buildingUpside
      )
    ).toContain("Denver");
  });

  test("includes the page text and its links", () => {
    const prompt = buildExtractionPrompt(
      "Clay",
      page,
      DEFAULT_CRITERIA,
      DEFAULT_PROFILE.candidatePersona,
      DEFAULT_PROFILE.buildingConcept,
      DEFAULT_PROFILE.buildingUpside
    );
    expect(prompt).toContain("Open roles");
    expect(prompt).toContain("/careers/revops");
  });

  test("asks for an empty array rather than prose when nothing matches", () => {
    expect(
      buildExtractionPrompt(
        "Clay",
        page,
        DEFAULT_CRITERIA,
        DEFAULT_PROFILE.candidatePersona,
        DEFAULT_PROFILE.buildingConcept,
        DEFAULT_PROFILE.buildingUpside
      )
    ).toContain("[]");
  });

  // The point of the whole task: the prompt renders the criteria it is HANDED,
  // not the shipped defaults. Without this, every assertion above would still
  // pass an implementation that ignored its third argument and kept importing
  // the constants.
  test("renders the supplied criteria rather than the defaults", () => {
    const edited: Criteria = {
      titles: ["Chief Waffle Officer"],
      locations: ["Reykjavik"],
      stackTerms: ["Syrup"],
      locationRule: "Reykjavik only.",
      fitBrain: "irrelevant here",
    };
    const prompt = buildExtractionPrompt(
      "Clay",
      page,
      edited,
      DEFAULT_PROFILE.candidatePersona,
      DEFAULT_PROFILE.buildingConcept,
      DEFAULT_PROFILE.buildingUpside
    );
    expect(prompt).toContain("Chief Waffle Officer");
    expect(prompt).toContain("Reykjavik only.");
    expect(prompt).not.toContain("Denver");
    expect(prompt).not.toContain("Head of Revenue Operations");
  });
});

describe("criteriaForCompany", () => {
  test("replaces locationRule with an any-location note when ignoreLocation is true", () => {
    const result = criteriaForCompany(DEFAULT_CRITERIA, true);
    expect(result.locationRule).not.toBe(DEFAULT_CRITERIA.locationRule);
    expect(result.locationRule.toLowerCase()).toContain("not a filter");
  });

  test("leaves every other field untouched when overriding location", () => {
    const result = criteriaForCompany(DEFAULT_CRITERIA, true);
    expect(result.titles).toEqual(DEFAULT_CRITERIA.titles);
    expect(result.locations).toEqual(DEFAULT_CRITERIA.locations);
    expect(result.stackTerms).toEqual(DEFAULT_CRITERIA.stackTerms);
    expect(result.fitBrain).toBe(DEFAULT_CRITERIA.fitBrain);
  });

  test("returns locationRule unchanged when ignoreLocation is false", () => {
    const result = criteriaForCompany(DEFAULT_CRITERIA, false);
    expect(result.locationRule).toBe(DEFAULT_CRITERIA.locationRule);
  });
});

describe("titlesToClose", () => {
  // runs[0] is the CURRENT run, runs[1] the previous successful one.
  test("closes a title absent from both the current and previous run", () => {
    const runs = [["head of revops"], ["head of revops"]];
    expect(titlesToClose(runs, ["gtm engineer"])).toEqual(["gtm engineer"]);
  });

  test("does not close a title present in the current run", () => {
    const runs = [["gtm engineer"], []];
    expect(titlesToClose(runs, ["gtm engineer"])).toEqual([]);
  });

  test("does not close a role found for the first time today", () => {
    // Regression guard: a role just discovered is in activeTitles but absent
    // from every prior run. Closing it immediately would be wrong.
    const runs = [["gtm engineer"], ["head of revops"]];
    expect(titlesToClose(runs, ["gtm engineer"])).toEqual([]);
  });

  test("does not close after only one successful run", () => {
    expect(titlesToClose([["head of revops"]], ["gtm engineer"])).toEqual([]);
  });

  test("does not close when there are no successful runs at all", () => {
    expect(titlesToClose([], ["gtm engineer"])).toEqual([]);
  });

  test("does not close a title missed by the current run but present in the previous run (debounce)", () => {
    // This is the case the whole two-run rule exists for: one noisy crawl
    // (a fetch hiccup, an off day for the extraction model) must not close a
    // role that's still open — it just needs to reappear in the *next* run's
    // "current" slot to stay open, and this test pins that it does.
    const runs = [[], ["gtm engineer"]];
    expect(titlesToClose(runs, ["gtm engineer"])).toEqual([]);
  });

  // Fix 2 (2026-08-12 consolidated wave): closeStalePostings now calls this
  // with runs drawn from status IN ('ok', 'empty') instead of status = 'ok'
  // only, and is invoked for an 'empty' current run too — an 'empty' crawl_runs
  // row always has role_titles = []. titlesToClose itself is agnostic to why
  // an array is empty, so these pin the actual scenario that changed: two
  // consecutive 'empty' runs (a company whose last posting came down) must
  // still close, exactly like two 'ok' runs that stopped mentioning a title.
  test("closes a title when both current and previous runs are empty (two consecutive 'empty'-status crawls)", () => {
    const runs: string[][] = [[], []];
    expect(titlesToClose(runs, ["gtm engineer"])).toEqual(["gtm engineer"]);
  });

  test("an 'empty' previous run still debounces a title missing from the current run", () => {
    // Mirrors the existing debounce test above, but with the previous run's
    // slot representing what an 'empty' crawl_runs row looks like (role_titles
    // = []) rather than a genuine "found nothing" for THIS title — either way,
    // one run's absence must never be enough on its own.
    const runs = [["gtm engineer"], []];
    expect(titlesToClose(runs, ["gtm engineer"])).toEqual([]);
  });
});

describe("runsEligibleForClosure", () => {
  const RUNS: ClosureRun[] = [
    { finished_at: "2026-08-10T00:00:00Z", titles: ["a"] },
    { finished_at: "2026-08-03T00:00:00Z", titles: ["a"] },
  ];

  test("all runs count when criteria have never changed", () => {
    expect(runsEligibleForClosure(RUNS, null).length).toBe(2);
  });

  test("returns the input array itself when criteria have never changed", () => {
    // toBe, not toEqual: before the first criteria edit this function must be
    // a literal no-op on the evidence list, i.e. the early return fired rather
    // than a filter that happened to keep everything. Only reference identity
    // can tell those two apart.
    expect(runsEligibleForClosure(RUNS, null)).toBe(RUNS);
  });

  test("runs older than the criteria change are excluded", () => {
    expect(runsEligibleForClosure(RUNS, "2026-08-05T00:00:00Z").length).toBe(1);
  });

  test("a change newer than every run leaves nothing eligible", () => {
    expect(runsEligibleForClosure(RUNS, "2026-08-12T00:00:00Z")).toEqual([]);
  });

  test("a run exactly at the change timestamp is excluded, not included", () => {
    expect(runsEligibleForClosure(RUNS, "2026-08-10T00:00:00Z").length).toBe(0);
  });

  test("returns the runs themselves, not just a count", () => {
    const eligible = runsEligibleForClosure(RUNS, "2026-08-05T00:00:00Z");
    expect(eligible.length).toBeGreaterThan(0);
    expect(eligible[0].titles).toEqual(["a"]);
  });

  test("an unparseable cutoff falls back to trusting every run", () => {
    // Guards the Number.isNaN branch. Getting this wrong disables closure
    // permanently and silently.
    expect(runsEligibleForClosure(RUNS, "garbage").length).toBe(2);
  });

  test("a run with an unparseable finished_at is dropped loudly, not silently", () => {
    // crawl_runs.finished_at is nullable (db/schema.sql) — a 'running' row has
    // none. It must not be treated as newer than the cutoff.
    //
    // What this test actually pins is OBSERVABILITY, not the drop. Deleting
    // the guard block changes no behavior at all: Date.parse(null) is NaN and
    // `NaN > cutoff` is already false, so the run is excluded either way. All
    // that disappears is the warning — and that warning is the only thing that
    // would ever explain a closure system which had quietly stopped closing.
    // Hence the spy assertion below; without it this test is near-vacuous.
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const withNull: ClosureRun[] = [
      { finished_at: null as unknown as string, titles: ["x"] },
      ...RUNS,
    ];
    const eligible = runsEligibleForClosure(withNull, "2026-08-05T00:00:00Z");
    expect(eligible.some((r) => r.titles[0] === "x")).toBe(false);
    expect(eligible.length).toBe(1);
    // "loudly": the drop is a data-integrity signal, not a routine filter.
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  test("every surviving run is strictly newer than the cutoff", () => {
    const cutoff = "2026-08-05T00:00:00Z";
    const eligible = runsEligibleForClosure(RUNS, cutoff);
    // .every on an empty array is vacuously true, so the length assertion is
    // load-bearing, not decoration.
    expect(eligible.length).toBe(1);
    expect(
      eligible.every((r) => Date.parse(r.finished_at) > Date.parse(cutoff))
    ).toBe(true);
  });
});

describe("closureRunsFromRows", () => {
  test("carries finished_at across, not just the titles", () => {
    // The silent-disable link: SQL selecting the column and
    // runsEligibleForClosure reading it are both pinned elsewhere, but a
    // mapper that dropped it would leave every previous run unparseable and
    // kill closure permanently after the first criteria edit.
    expect(
      closureRunsFromRows([
        { role_titles: ["gtm engineer"], finished_at: "2026-08-10T00:00:00Z" },
      ])
    ).toEqual([{ finished_at: "2026-08-10T00:00:00Z", titles: ["gtm engineer"] }]);
  });

  test("the mapped rows survive the eligibility filter they feed", () => {
    // End-to-end on the pair: a mapper that lost finished_at would produce
    // rows that look fine by shape but get dropped as unparseable here.
    const runs = closureRunsFromRows([
      { role_titles: ["gtm engineer"], finished_at: "2026-08-10T00:00:00Z" },
    ]);
    expect(runsEligibleForClosure(runs, "2026-08-05T00:00:00Z").length).toBe(1);
  });

  test("a null role_titles becomes an empty title list", () => {
    expect(
      closureRunsFromRows([{ role_titles: null, finished_at: "2026-08-10T00:00:00Z" }])
    ).toEqual([{ finished_at: "2026-08-10T00:00:00Z", titles: [] }]);
  });

  test("no trustworthy run maps to no evidence", () => {
    expect(closureRunsFromRows([])).toEqual([]);
  });
});

describe("closureEvidenceTitles", () => {
  // This is the gate itself, not just its predicate: closeStalePostings feeds
  // this function's return value straight into titlesToClose, so mapping the
  // unfiltered `runs` here would restore the auto-closure bug while every
  // runsEligibleForClosure test still passed.
  const RUNS: ClosureRun[] = [
    { finished_at: "2026-08-10T00:00:00Z", titles: ["gtm engineer"] },
    { finished_at: "2026-08-03T00:00:00Z", titles: ["head of revops"] },
  ];

  // The cutoff is passed as a RunContext slice, not a bare string, so that a
  // literal `null` in that argument position — which silently disables the
  // gate — cannot type-check. Sealing only closeStalePostings left this use
  // site open; the review caught it surviving.
  const CHANGED = { criteriaChangedAt: "2026-08-05T00:00:00Z" };
  const NEVER_CHANGED = { criteriaChangedAt: null };

  test("drops the title lists of runs that predate the criteria change", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const evidence = closureEvidenceTitles("Clay", RUNS, CHANGED);
    expect(evidence).toEqual([["gtm engineer"]]);
    spy.mockRestore();
  });

  test("a criteria change pushes the evidence under titlesToClose's two-run minimum", () => {
    // The end-to-end point of the task, asserted on the two functions as they
    // are actually composed: one eligible run is not enough to close anything,
    // so a role the crawler stopped looking for survives the edit.
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const evidence = closureEvidenceTitles("Clay", RUNS, CHANGED);
    expect(evidence.length).toBe(1);
    expect(titlesToClose(evidence, ["head of revops"])).toEqual([]);
    spy.mockRestore();
  });

  test("without a criteria change both runs stay as evidence and closure still works", () => {
    // Guards against over-correction: the debounce must keep closing roles in
    // the ordinary no-edit case.
    const evidence = closureEvidenceTitles("Clay", RUNS, NEVER_CHANGED);
    expect(evidence).toEqual([["gtm engineer"], ["head of revops"]]);
    expect(titlesToClose(evidence, ["marketing ops manager"])).toEqual([
      "marketing ops manager",
    ]);
  });

  test("logs the suppression, naming the emitting function, the company, and how many runs were dropped", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    closureEvidenceTitles("Clay", RUNS, CHANGED);
    expect(spy).toHaveBeenCalledTimes(1);
    const logged = spy.mock.calls[0][0] as string;
    // The prefix must name the function that actually emits the line, or
    // grepping it out of production logs lands in the wrong place.
    expect(logged).toContain("closureEvidenceTitles");
    expect(logged).toContain("Clay");
    expect(logged).toContain("1 run(s)");
    spy.mockRestore();
  });

  test("logs nothing when no run was excluded", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    closureEvidenceTitles("Clay", RUNS, NEVER_CHANGED);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe("LAST_TRUSTWORTHY_RUN_SQL", () => {
  // Same rationale as STALE_POSTING_CANDIDATES_SQL below: no database in this
  // repo's test setup, so this only pins the query's text, not its execution.
  // Its job is to fail loudly if a future edit narrows the scope back to
  // status = 'ok' only (reintroducing the empty-crawl bug fix 2 corrects) or
  // widens it to include 'error'/'needs_url' (breaking the safety property
  // that a fetch failure must never be read as "role is gone").

  test("includes both trustworthy statuses", () => {
    expect(LAST_TRUSTWORTHY_RUN_SQL).toContain("status in ('ok', 'empty')");
  });

  test("does not scope to 'ok' alone", () => {
    expect(LAST_TRUSTWORTHY_RUN_SQL).not.toContain("status = 'ok'");
  });

  test("selects finished_at as well as role_titles", () => {
    // runsEligibleForClosure compares finished_at against the criteria-change
    // stamp. rawQuery's row type is an assertion, not something inferred from
    // the SQL, so dropping this column compiles clean: every previous run
    // would then arrive with finished_at undefined, be dropped as unparseable,
    // and closure would be permanently disabled after the first criteria edit
    // with nothing to point at. A string check is the only guard available
    // without a database.
    expect(LAST_TRUSTWORTHY_RUN_SQL).toContain("role_titles");
    expect(LAST_TRUSTWORTHY_RUN_SQL).toContain("finished_at");
  });
});

describe("STALE_POSTING_CANDIDATES_SQL", () => {
  // This is a string-content check, not a behavioral one — there is no
  // database in this repo's test setup, so it cannot prove the query
  // executes correctly against real rows, only that the two load-bearing
  // predicates are still both present in the text. That is deliberately
  // weak but honest: its only job is to fail loudly if a future edit
  // "simplifies" away either restriction the ruling in lib/crawler.ts
  // requires (source = 'Crawl' and status = 'New').

  test("scopes candidates to the crawler's own findings (source = 'Crawl')", () => {
    expect(STALE_POSTING_CANDIDATES_SQL).toContain("source = 'Crawl'");
  });

  test("scopes candidates to untouched jobs only (status = 'New')", () => {
    expect(STALE_POSTING_CANDIDATES_SQL).toContain("status = 'New'");
  });
});

describe("runProvidesClosureEvidence", () => {
  test("a normal run that found roles is evidence", () => {
    expect(runProvidesClosureEvidence("ok", false)).toBe(true);
  });

  test("a normal run that found nothing is evidence", () => {
    // Mutation this catches: excluding 'empty' to be safe. That was tried and
    // reverted (ruling 2026-08-12) — a company taking down its last posting is
    // the commonest real closure, and excluding empty meant it never closed.
    expect(runProvidesClosureEvidence("empty", false)).toBe(true);
  });

  test("a SALVAGED run is NOT evidence, even when it found roles", () => {
    // Mutation this catches: gating on `salvaged && rolesFound === 0` instead
    // of on `salvaged` alone. A salvaged non-empty run transcribes whatever the
    // prose happened to mention, which is not a complete listing — closing
    // every title absent from it would close roles the prose merely omitted.
    expect(runProvidesClosureEvidence("ok", true)).toBe(false);
  });

  test("a salvaged run that found nothing is NOT evidence", () => {
    // The case this whole column exists for: prose meaning "I could not reach
    // the page" salvages to an empty array, which is indistinguishable from
    // "this company lists nothing" unless provenance is recorded.
    expect(runProvidesClosureEvidence("empty", true)).toBe(false);
  });

  test("a failed run is never evidence", () => {
    expect(runProvidesClosureEvidence("error", false)).toBe(false);
    expect(runProvidesClosureEvidence("needs_url", false)).toBe(false);
  });
});

describe("LAST_TRUSTWORTHY_RUN_SQL", () => {
  test("excludes salvaged runs", () => {
    // The SQL and runProvidesClosureEvidence must agree: the SQL picks the
    // PREVIOUS run used as evidence, the function gates the CURRENT one.
    // rawQuery's row type is an assertion, not inferred from this string, so a
    // dropped clause compiles clean and silently re-opens the hazard.
    expect(LAST_TRUSTWORTHY_RUN_SQL).toContain("salvaged");
    expect(LAST_TRUSTWORTHY_RUN_SQL).toMatch(/not\s+salvaged|salvaged\s*=\s*false/);
  });
});

describe("rolesFromRaw", () => {
  test("returns a bare array as-is", () => {
    const raw = JSON.stringify([{ role_title: "GTM Engineer" }]);
    expect(rolesFromRaw(raw)).toEqual([{ role_title: "GTM Engineer" }]);
  });

  test("unwraps a {roles: [...]} object", () => {
    const raw = JSON.stringify({ roles: [{ role_title: "Head of RevOps" }], message: "ok" });
    expect(rolesFromRaw(raw)).toEqual([{ role_title: "Head of RevOps" }]);
  });

  test("treats a {roles: null} object as empty", () => {
    const raw = JSON.stringify({ roles: null });
    expect(rolesFromRaw(raw)).toEqual([]);
  });

  // Fix 7 (2026-08-12 consolidated wave): parseJson failures used to throw
  // straight through with no diagnostic trail. rolesFromRaw now logs the
  // raw response head before rethrowing, so this failure mode is
  // diagnosable from logs instead of just "JSON parse error" with no
  // context on what the model actually returned.
  test("logs the raw response head and rethrows on malformed JSON", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const raw = "Sorry, I could not find any roles for this company.";
    expect(() => rolesFromRaw(raw)).toThrow();
    expect(spy).toHaveBeenCalledTimes(1);
    const logged = spy.mock.calls[0][0] as string;
    expect(logged).toContain(raw.slice(0, 500));
    spy.mockRestore();
  });
});

describe("classifyFetchOutcome", () => {
  // This is the pure decision the fetch tier's crawl_method-learning depends
  // on: whether an already-fetched page's HTML genuinely has no jobs (a
  // stable property worth learning) vs. has content worth extracting from.
  // It does not cover "unavailable" (robots block, network error, timeout,
  // non-2xx) — those are decided before any HTML exists and would require
  // mocking `fetch` and `robots.txt` lookups, which this repo has no
  // precedent for; that path is exercised only implicitly via crawlCompany
  // and is not unit tested, same as the rest of the DB/API-dependent code.

  test("an empty ATS embed classifies as a shell", () => {
    expect(classifyFetchOutcome(ATS_SHELL)).toEqual({ kind: "shell" });
  });

  test("a populated careers page classifies as content, carrying the extracted page", () => {
    const result = classifyFetchOutcome(REAL_PAGE);
    expect(result.kind).toBe("content");
    if (result.kind === "content") {
      expect(result.page.text).toContain("Open roles at Example");
      expect(result.page.links.map((l) => l.href)).toContain(
        "/careers/head-of-revops"
      );
    }
  });
});
