import { describe, expect, test, vi } from "vitest";
import {
  buildExtractionPrompt,
  classifyFetchOutcome,
  LAST_TRUSTWORTHY_RUN_SQL,
  rolesFromRaw,
  STALE_POSTING_CANDIDATES_SQL,
  titlesToClose,
} from "./crawler";
import { stripHtml } from "./page-extract";
import { DEFAULT_CRITERIA, type Criteria } from "./search-criteria";

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
    expect(buildExtractionPrompt("Clay", page, DEFAULT_CRITERIA)).toContain("Clay");
  });

  test("includes the location rule", () => {
    // "Denver" reaches the prompt only through criteria.locationRule — it
    // appears nowhere else in the template. Keep this assertion as-is.
    expect(buildExtractionPrompt("Clay", page, DEFAULT_CRITERIA)).toContain("Denver");
  });

  test("includes the page text and its links", () => {
    const prompt = buildExtractionPrompt("Clay", page, DEFAULT_CRITERIA);
    expect(prompt).toContain("Open roles");
    expect(prompt).toContain("/careers/revops");
  });

  test("asks for an empty array rather than prose when nothing matches", () => {
    expect(buildExtractionPrompt("Clay", page, DEFAULT_CRITERIA)).toContain("[]");
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
    const prompt = buildExtractionPrompt("Clay", page, edited);
    expect(prompt).toContain("Chief Waffle Officer");
    expect(prompt).toContain("Reykjavik only.");
    expect(prompt).not.toContain("Denver");
    expect(prompt).not.toContain("Head of Revenue Operations");
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
