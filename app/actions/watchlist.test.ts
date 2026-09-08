import { beforeEach, describe, expect, test, vi } from "vitest";

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


// The budget wrapper is bypassed, the same way app/actions/parse-role.test.ts
// bypasses it: these tests are about tracking and crawl reporting, and
// withBudget reaches the database for tiers and counters before the crawl runs.
// Budget behaviour is pinned in lib/budget.test.ts; that these two actions are
// WRAPPED at all is pinned separately, below.
vi.mock("@/lib/metered", () => ({
  withBudget: async (o: { fn: () => Promise<unknown> }) => ({ result: await o.fn() }),
}));


// A `"use server"` module IS testable when the network is mocked at its edge —
// the same lesson app/actions/settings.test.ts records in its own header, and
// the reason vitest.config.ts includes `app/**`. The audit that produced these
// fixes drew its "not testable" line at this file, and that was wrong: the
// watchlist pair is the one the audit itself called permanent and manual to
// undo, and it was the least defended code on the branch.
//
// Only the EDGE is replaced. findExistingCompany, normalizeCompanyName and
// resolveCareersUrlWrite stay real, because they are the logic under test.
const h = vi.hoisted(() => {
  const state = {
    result: { data: [] as unknown, error: null as { message: string } | null },
    writes: [] as { table: string; op: string; payload: Record<string, unknown> }[],
  };
  const makeBuilder = (table: string) => {
    const b: Record<string, unknown> = {};
    const chain = () => b;
    for (const m of ["select", "eq", "neq", "order", "limit", "single", "maybeSingle", "delete"]) {
      b[m] = chain;
    }
    for (const op of ["insert", "update", "upsert"]) {
      b[op] = (payload: Record<string, unknown>) => {
        state.writes.push({ table, op, payload });
        return b;
      };
    }
    b.then = (ok: (v: unknown) => unknown, err?: (e: unknown) => unknown) =>
      Promise.resolve(state.result).then(ok, err);
    return b;
  };
  return { state, makeBuilder };
});

vi.mock("@/lib/supabase", () => ({
  rawQuery: vi.fn(),
  supabase: {
    from: (t: string) => h.makeBuilder(t),
    // Same builder either way: these tests assert what the ACTION does,
    // not what the transport adds. That every tenant table is reached
    // through forTenant is enforced by lib/supabase.ts itself, which
    // throws on supabase.from() for a scoped table.
    forTenant: () => ({ from: (t: string) => h.makeBuilder(t) }),
  },
}));
vi.mock("@/lib/crawler", () => ({ crawlCompany: vi.fn() }));

import {
  addToWatchlist,
  checkCompanyNow,
  getWatchedCompanyKeys,
  renameTrackedCompany,
  setIgnoreLocationRule,
  setTracking,
  trackCompanyByName,
} from "./watchlist";
import { crawlCompany } from "@/lib/crawler";
import { rawQuery } from "@/lib/supabase";
import type { Startup } from "@/lib/types";

const query = vi.mocked(rawQuery);
const crawl = vi.mocked(crawlCompany);

const STARTUP: Startup = {
  company: "Clay",
  tagline: "GTM data",
  raised: "$46M",
  stage: "Series B",
  category: "GTM",
  lead_investor: "Sequoia",
  founded: "2021",
  traction: "3x YoY",
  careers_url: "https://guess.example/jobs",
  headquarters: "New York, NY",
};

/** The watchlist read succeeding, with these rows. */
function readOk(rows: { company: string; careers_url: string | null }[] = []) {
  query.mockResolvedValue({ data: rows, error: null } as never);
}

/**
 * The watchlist read FAILING with no message — the only shape a
 * connection-level outage produces, and the one every `if (error)` misses.
 */
function readFailed(message = "") {
  query.mockResolvedValue({ data: [], error: { message } } as never);
}

beforeEach(() => {
  query.mockReset();
  crawl.mockReset();
  crawl.mockResolvedValue({
    company: "Clay",
    method: null,
    rolesFound: 0,
    newRoles: 0,
    status: "ok",
  } as never);
  h.state.result = { data: [], error: null };
  h.state.writes = [];
});

describe("addToWatchlist refuses to write on an unverified name", () => {
  test("a clean read with nothing stored DOES write, and takes the guessed URL", () => {
    // The positive control. Without it, "always refuse" passes every
    // assertion below and the feature is broken rather than defended.
    readOk([]);
    return addToWatchlist(STARTUP).then((res) => {
      expect(res).toEqual({});
      expect(h.state.writes).toHaveLength(1);
      expect(h.state.writes[0].payload.careers_url).toBe("https://guess.example/jobs");
    });
  });

  test("a clean read with a STORED url keeps it — the guess never wins", async () => {
    readOk([{ company: "Clay", careers_url: "https://hand-typed.example/careers" }]);
    await addToWatchlist(STARTUP);
    expect(h.state.writes).toHaveLength(1);
    // undefined = the column is omitted from the write entirely.
    expect(h.state.writes[0].payload.careers_url).toBeUndefined();
    expect("crawl_method" in h.state.writes[0].payload).toBe(false);
  });

  test("a read that failed with NO message writes NOTHING", async () => {
    // M30 (`readFailed = false`) and M31 (`{ known: true }` unconditionally)
    // both restore the original bug here: the failed read looked like an empty
    // watchlist, so Discover's guessed careers_url overwrote a hand-typed one
    // AND the row was upserted under an unverified casing.
    readFailed("");
    const res = await addToWatchlist(STARTUP);
    expect(res.error).toBeTruthy();
    expect(h.state.writes).toHaveLength(0);
  });

  test("a read that failed WITH a message writes nothing either", async () => {
    readFailed("relation \"watchlist\" does not exist");
    const res = await addToWatchlist(STARTUP);
    expect(res.error).toBeTruthy();
    expect(h.state.writes).toHaveLength(0);
  });
});

describe("trackCompanyByName refuses to write on an unverified name", () => {
  test("a clean read tracks and runs the first crawl", async () => {
    // Positive control for the guard below.
    readOk([]);
    const res = await trackCompanyByName("Clay");
    expect(res.error).toBeUndefined();
    expect(h.state.writes).toHaveLength(1);
    expect(crawl).toHaveBeenCalledTimes(1);
  });

  test("a clean read reuses the STORED casing, not the typed one", async () => {
    // The duplicate-row hazard in its normal form: the unique index is on raw
    // text, so "clay" must resolve to the stored "Clay".
    readOk([{ company: "Clay", careers_url: null }]);
    await trackCompanyByName("clay");
    expect(h.state.writes).toHaveLength(1);
    expect(h.state.writes[0].payload.company).toBe("Clay");
  });

  test("a failed read writes nothing and does NOT crawl", async () => {
    // M33. Tracking under an unverified name creates the duplicate row; not
    // tracking is recoverable with another click. Also asserts no crawl, since
    // a crawl on a name that may not exist bills Claude for nothing.
    readFailed("");
    const res = await trackCompanyByName("clay");
    expect(res.error).toBeTruthy();
    expect(h.state.writes).toHaveLength(0);
    expect(crawl).not.toHaveBeenCalled();
  });
});

describe("getWatchedCompanyKeys reports a lookup it could not do", () => {
  test("a clean read returns normalized keys and no error", async () => {
    // Positive control, and it pins the normalization contract: the Set holds
    // normalizeCompanyName keys, not raw stored strings.
    h.state.result = { data: [{ company: "Clay" }, { company: "Big  Co" }], error: null };
    const res = await getWatchedCompanyKeys();
    expect(res.error).toBeUndefined();
    expect(res.keys.size).toBe(2);
    expect(res.keys.has("clay")).toBe(true);
    expect(res.keys.has("big co")).toBe(true);
  });

  test("a failed read reports the error instead of an innocent empty Set", async () => {
    // M32. A bare empty Set reads as "nothing is watched" — plausible, and
    // therefore indistinguishable from the failure. Every company then renders
    // un-starred with a live Track button, and that button writes.
    h.state.result = { data: null, error: { message: "" } };
    const res = await getWatchedCompanyKeys();
    expect(res.error).toBeDefined();
    expect(res.keys.size).toBe(0);
  });
});

describe("resolveWriteTarget tells 'could not look' apart from 'not there'", () => {
  test("a failed read does not claim the company is missing", async () => {
    // The old message asserted the wrong thing: a user shown `"Clay" is not on
    // the watchlist` during an outage goes looking for a company that is
    // sitting right there.
    readFailed("");
    const res = await setTracking("Clay", false);
    expect(res.error).toBeTruthy();
    expect(res.error).not.toContain("is not on the watchlist");
    expect(h.state.writes).toHaveLength(0);
  });

  test("a clean read with no such row DOES say it is not on the watchlist", async () => {
    // Both sides of the branch — the original guard must survive the new one.
    readOk([]);
    const res = await setTracking("Nope", false);
    expect(res.error).toContain("is not on the watchlist");
    expect(h.state.writes).toHaveLength(0);
  });

  test("a clean read with a matching row writes", async () => {
    readOk([{ company: "Clay", careers_url: null }]);
    const res = await setTracking("clay", false);
    expect(res.error).toBeUndefined();
    expect(h.state.writes).toHaveLength(1);
    expect(h.state.writes[0].payload.tracking_enabled).toBe(false);
  });
});

describe("setIgnoreLocationRule", () => {
  test("a clean read with a matching row writes the flag", async () => {
    readOk([{ company: "Clay", careers_url: null }]);
    const res = await setIgnoreLocationRule("clay", true);
    expect(res.error).toBeUndefined();
    expect(h.state.writes).toHaveLength(1);
    expect(h.state.writes[0].payload.ignore_location_rule).toBe(true);
  });

  test("a clean read with no such row does not write", async () => {
    readOk([]);
    const res = await setIgnoreLocationRule("Nope", true);
    expect(res.error).toContain("is not on the watchlist");
    expect(h.state.writes).toHaveLength(0);
  });
});

/**
 * The two interactive crawl paths are METERED.
 *
 * They were not, and the consequence was not a missing statistic: with no
 * ambient billing scope, routing() in lib/model-call.ts falls back to
 * process.env.ANTHROPIC_API_KEY — the PLATFORM key — uncapped and unrecorded.
 * Any approved tenant could spend the owner's money by clicking "Check now".
 * The nightly path through app/api/cron/crawl was wrapped; these, which a person
 * triggers, were not.
 *
 * These tests assert the WRAPPING, which is what regressed. They deliberately
 * un-mock the module-level withBudget stub for one call each, because a stub
 * that always runs `fn` cannot tell a wrapped action from an unwrapped one — the
 * exact blindness that let this ship.
 */
describe("the interactive crawl paths are metered", () => {
  test("a capped budget means no crawl runs at all", async () => {
    const metered = await import("@/lib/metered");
    const spy = vi
      .spyOn(metered, "withBudget")
      .mockResolvedValue({ capped: "Add your API key to run searches." });

    const outcome = await checkCompanyNow("Clay");

    expect(spy).toHaveBeenCalledTimes(1);
    // The refusal reached the caller as a reason, not as silence...
    expect(outcome.error).toBe("Add your API key to run searches.");
    expect(outcome.status).toBe("error");
    // ...and the billed work never happened.
    expect(crawl).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  test("checkCompanyNow declares the crawl action and its cost", async () => {
    const metered = await import("@/lib/metered");
    const spy = vi.spyOn(metered, "withBudget");

    await checkCompanyNow("Clay");

    // estimateCents matches the cron route's per-company figure. A wrapper that
    // reserved nothing would pass every budget check and cap nothing.
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ action: "crawl-now", estimateCents: 10 })
    );
    spy.mockRestore();
  });
});

// The company name is a JOIN KEY, not a label — it is what jobs,
// discovered_roles and crawl_runs are written under and what ingestRoles
// dedupes against. These tests defend the two ends of that: a URL must never
// become a name, and a rename must carry every table or the next crawl
// re-inserts the company's whole role history as duplicates.
describe("a careers URL is never accepted as a company name", () => {
  test("trackCompanyByName refuses a pasted URL and names the company it read", async () => {
    readOk([]);

    const res = await trackCompanyByName("https://cursor.com/careers");

    expect(res.error).toMatch(/Cursor/);
    expect(res.error).toMatch(/not a company name/i);
    // Nothing written, and — the expensive half — nothing crawled.
    expect(h.state.writes).toHaveLength(0);
    expect(crawl).not.toHaveBeenCalled();
  });

  test("a real name still tracks, and the confirm step's URL is stored with it", async () => {
    readOk([]);

    const res = await trackCompanyByName("Cursor", "https://cursor.com/careers");

    expect(res.error).toBeUndefined();
    expect(h.state.writes[0].payload).toMatchObject({
      company: "Cursor",
      careers_url: "https://cursor.com/careers",
    });
  });

  test("a URL pasted into the box does not clobber a careers URL already stored", async () => {
    // resolveCareersUrlWrite's rule 1: a stored URL may have been typed by hand
    // to rescue a broken crawl. Re-tracking must not overwrite it.
    readOk([{ company: "Cursor", careers_url: "https://cursor.com/hand-typed" }]);

    await trackCompanyByName("Cursor", "https://cursor.com/careers");

    expect(h.state.writes[0].payload).not.toHaveProperty("careers_url");
  });

  test("renameTrackedCompany refuses a URL as the new name", async () => {
    readOk([{ company: "Cursor", careers_url: null }]);

    const res = await renameTrackedCompany("Cursor", "https://cursor.com/careers");

    expect(res.error).toMatch(/not a company name/i);
    expect(res.company).toBeUndefined();
  });
});

describe("renameTrackedCompany carries the name through every table", () => {
  test("one statement updates all four tables the name keys", async () => {
    readOk([{ company: "https://cursor.com/careers", careers_url: null }]);

    const res = await renameTrackedCompany("https://cursor.com/careers", "Cursor");

    expect(res.error).toBeUndefined();
    expect(res.company).toBe("Cursor");

    const sql = String(query.mock.calls[query.mock.calls.length - 1][0]);
    // Each table by name. Renaming the watchlist row alone is the defect this
    // asserts against: ingestRoles would then find no rows under the new name
    // and re-insert every existing role as a duplicate "New" job.
    for (const table of ["watchlist", "jobs", "discovered_roles", "crawl_runs"]) {
      expect(sql).toContain(table);
    }
    // ONE statement, so the four either all land or none do.
    expect(sql).toContain("with");
    // Every clause scoped by tenant, not just the first.
    expect(sql.match(/tenant_id = \$3/g)).toHaveLength(4);
  });

  test("refuses to rename into another tracked company rather than merging", async () => {
    readOk([
      { company: "Cursor", careers_url: null },
      { company: "Ramp", careers_url: null },
    ]);

    const res = await renameTrackedCompany("Cursor", "Ramp");

    expect(res.error).toMatch(/already on your watchlist/);
    // The refusal must say what a merge would cost, since the user cannot undo it.
    expect(res.error).toMatch(/cannot be undone|merge/i);
    // Nothing renamed: the read is the only query that ran.
    expect(query).toHaveBeenCalledTimes(2);
  });

  test("a casing-only fix is not a merge — it is this row", async () => {
    readOk([{ company: "cursor", careers_url: null }]);

    const res = await renameTrackedCompany("cursor", "Cursor");

    expect(res.error).toBeUndefined();
    expect(res.company).toBe("Cursor");
  });

  test("refuses when the company is not on the watchlist", async () => {
    readOk([{ company: "Ramp", careers_url: null }]);

    const res = await renameTrackedCompany("Cursor", "Cursor Inc");

    expect(res.error).toMatch(/not on the watchlist/);
  });

  test("refuses when the watchlist could not be READ, rather than reporting not-found", async () => {
    readFailed();

    const res = await renameTrackedCompany("Cursor", "Cursor Inc");

    expect(res.error).toMatch(/could not be read|database/i);
    expect(res.company).toBeUndefined();
  });

  test("reports a failed write whose message is EMPTY", async () => {
    // Presence, not truthiness. An unreachable dual-stack host rejects with an
    // AggregateError whose message is "" — `if (error)` reads that as success
    // and tells the user the rename landed.
    query.mockResolvedValueOnce({
      data: [{ company: "cursor", careers_url: null }],
      error: null,
    } as never);
    query.mockResolvedValueOnce({ data: [], error: { message: "" } } as never);

    const res = await renameTrackedCompany("cursor", "Cursor");

    expect(res.company).toBeUndefined();
    expect(res.error).toBeTruthy();
  });
});
