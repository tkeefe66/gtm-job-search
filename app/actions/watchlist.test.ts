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
  getWatchedCompanyKeys,
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
