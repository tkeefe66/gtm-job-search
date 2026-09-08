// app/actions/restore-saved-version.test.ts
//
// Two halves. The FIRST covers the pure decision helpers in
// lib/checkpoint-decision.ts. The SECOND executes restoreSavedVersion's own
// body — nothing did before, so its two suppression conjuncts could each be
// deleted, and the demotion could be moved above the tailored_resumes upsert,
// with the whole suite still green. That function can destroy the user's
// working draft with no undo.
//
// The mocks below are module-wide (vi.mock hoists), which the first half is
// indifferent to: it imports only the pure helpers.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { restoreWouldChangeNothing, shouldCheckpoint } from "@/lib/checkpoint-decision";

const draft = { themes: ["ops"], selection: { positioningId: "gtm", bullets: {} }, overrides: {} };

/** A structurally-identical but reference-distinct copy — every nested value
 *  is rebuilt from scratch via the JSON round trip, so nothing in it shares a
 *  reference with `draft`. Needed because `{ ...draft }` is a SHALLOW copy:
 *  its `selection` and `overrides` are the exact same objects as `draft`'s,
 *  so any comparison that only checks those fields by reference passes
 *  trivially there and proves nothing about a by-value comparison. */
function deepCopy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

describe("shouldCheckpoint", () => {
  // Mutation this catches: an implementation that special-cases null content
  // TOWARD suppression (e.g. `if (newest.content === null) return false;`).
  // That is the real, live risk this guards: a pre-021 row's content is null,
  // and suppressing against it destroys the draft's only copy.
  //
  // What this test does NOT prove: that the null guard exists at all.
  // Deleting the guard and falling straight through to the JSON.stringify
  // comparison still passes THIS fixture by coincidence —
  // `JSON.stringify(null)` is the string `"null"`, which is never equal to a
  // stringified object, so the fallthrough still returns `true` here even
  // with no guard. (Comparing `content_hash` instead of `content` is not a
  // mutation this signature can express at all — `newest: { content: unknown
  // | null }` carries no hash field to compare.)
  it("always checkpoints against a row that records no content", () => {
    expect(shouldCheckpoint(draft, { content: null })).toBe(true);
  });

  // Mutation this catches: suppressing whenever a newest row exists at all.
  it("checkpoints when the draft differs from the newest row", () => {
    expect(shouldCheckpoint(draft, { content: { ...draft, themes: ["data"] } })).toBe(true);
  });

  // Mutation this catches: never suppressing, which writes a full HTML document
  // every time the user opens a saved résumé.
  it("does not checkpoint when the draft is already the newest row", () => {
    expect(shouldCheckpoint(draft, { content: { ...draft } })).toBe(false);
  });

  // Mutation this catches: comparing only `themes` instead of the whole
  // content, e.g.
  //   JSON.stringify(draft.themes) !== JSON.stringify(newest.content.themes)
  // That mutant passes every OTHER case in this file — the "differs" case
  // above happens to vary themes, and the "already the newest" case's
  // `{ ...draft }` shares `overrides`/`selection` by reference either way —
  // so it must be exercised on a content difference that themes cannot see.
  it("checkpoints when the draft differs from the newest row only in overrides", () => {
    const newest = { ...draft, overrides: { pageMargin: "1in" } };
    expect(shouldCheckpoint(draft, { content: newest })).toBe(true);
  });

  // Same mutation as above, isolated to `selection` instead of `overrides`.
  it("checkpoints when the draft differs from the newest row only in selection", () => {
    const newest = { ...draft, selection: { positioningId: "gtm", bullets: { a: ["x"] } } };
    expect(shouldCheckpoint(draft, { content: newest })).toBe(true);
  });

  // Mutation this catches: a reference-based (or partially-by-reference)
  // comparison — e.g. one that compares `themes` by value but `selection`/
  // `overrides` by `!==` — which would return `true` here even though the two
  // sides are structurally identical, because a deep copy shares no nested
  // references with `draft`. This is what proves the comparison is by VALUE,
  // not by reference: unlike the "already the newest" case above (built from
  // a shallow `{ ...draft }`, whose nested fields alias `draft`'s), nothing
  // here can pass by accidentally sharing an object.
  it("does not checkpoint against a deep copy sharing no references", () => {
    expect(shouldCheckpoint(draft, { content: deepCopy(draft) })).toBe(false);
  });

  // Mutation this catches: treating "no draft" as "nothing to compare, so write
  // one". There is nothing to preserve, and the row would duplicate the restored
  // document.
  it("does not checkpoint when there is no draft at all", () => {
    expect(shouldCheckpoint(null, { content: { ...draft } })).toBe(false);
    expect(shouldCheckpoint(null, null)).toBe(false);
  });

  // Mutation this catches: suppressing when no saved row exists yet. The draft
  // is unprotected and a restore would destroy it.
  it("checkpoints a draft when the job has no saved rows yet", () => {
    expect(shouldCheckpoint(draft, null)).toBe(true);
  });
});

// The second suppression, and the reason it cannot be folded into
// shouldCheckpoint: shouldCheckpoint compares the draft against the newest
// LIVE saved row, and after one restore that row is the checkpoint the restore
// itself wrote.
describe("restoreWouldChangeNothing", () => {
  // Mutation this catches: OMITTING the check entirely at the call site
  // (restore-saved-version.ts Step 4). Restore S, then back-navigate and click
  // "Edit this version" on S again: the draft is now S and the newest live row
  // is the checkpoint holding the OLD draft D, so shouldCheckpoint still says
  // yes — a worthless second checkpoint holding S is written AND the demotion
  // moves C1, the only copy of D, from 30 days down to 3. `disabled={isPending}`
  // guards a double-click, not a back navigation.
  it("suppresses a restore of the version the draft already is", () => {
    const newestIsTheCheckpoint = { content: { ...draft, themes: ["old"] } };
    // shouldCheckpoint alone would write one...
    expect(shouldCheckpoint(draft, newestIsTheCheckpoint)).toBe(true);
    // ...and this is what stops it, because restoring S over a draft that is
    // already S changes nothing, so there is nothing to preserve.
    expect(restoreWouldChangeNothing(draft, deepCopy(draft))).toBe(true);
  });

  // Mutation this catches: comparing by reference, which would report a
  // structurally identical deep copy as different and let the redundant
  // checkpoint through. Covered above too; asserted here on the negative side
  // so a by-value comparison is pinned in both directions.
  it("does not suppress when the restored version differs from the draft", () => {
    expect(restoreWouldChangeNothing(draft, { ...draft, themes: ["data"] })).toBe(false);
    expect(
      restoreWouldChangeNothing(draft, { ...draft, overrides: { pageMargin: "1in" } })
    ).toBe(false);
  });

  // Mutation this catches: dropping the null/undefined guards, where
  // JSON.stringify(undefined) === JSON.stringify(undefined) makes two absent
  // values compare EQUAL and suppresses the checkpoint of a draft that exists.
  it("never suppresses when either side is absent", () => {
    expect(restoreWouldChangeNothing(null, null)).toBe(false);
    expect(restoreWouldChangeNothing(undefined, undefined)).toBe(false);
    expect(restoreWouldChangeNothing(draft, null)).toBe(false);
    expect(restoreWouldChangeNothing(null, draft)).toBe(false);
  });
});

import { selectBullets } from "@/lib/resume-render/render";
import career from "@/lib/resume-render/content/resume.json";
import type { CareerRecord } from "@/lib/resume-render/render";

vi.mock("@/lib/require-actor", () => ({
  requireActor: async () => ({
    userId: "admin-1", tenantId: "t1", email: "admin@example.com", isAdmin: true,
  }),
}));

vi.mock("@/lib/settings-store", () => ({
  readAllSettingsResult: async () => ({ rows: [], error: undefined }),
  careerOverlayFrom: () => [],
}));

const h = vi.hoisted(() => ({
  state: {
    calls: [] as { op: string; sql?: string; args?: unknown[]; row?: Record<string, unknown> }[],
    savedRow: null as Record<string, unknown> | null,
    draftContent: undefined as unknown,
    newestContent: undefined as unknown,
    insertResult: { data: [{ id: "cp-1" }], error: null } as { data: { id: string }[]; error: unknown },
    upsertError: null as { message: string } | null,
    forceDuplicate: false,
  },
}));

vi.mock("@/lib/supabase", () => ({
  rawQuery: async (sql: string, args: unknown[]) => {
    h.state.calls.push({ op: "rawQuery", sql, args });
    if (sql.indexOf("select job_id, role_title, company, content, created_at from saved_resumes") === 0)
      return { data: h.state.savedRow ? [h.state.savedRow] : [], error: null };
    if (sql.indexOf("select content from tailored_resumes") === 0)
      return { data: h.state.draftContent !== undefined ? [{ content: h.state.draftContent }] : [], error: null };
    if (sql.indexOf("select content from saved_resumes") === 0)
      return { data: h.state.newestContent !== undefined ? [{ content: h.state.newestContent }] : [], error: null };
    if (sql.indexOf("insert into saved_resumes") === 0) return h.state.insertResult;
    if (sql.indexOf("update saved_resumes set expires_at") === 0) return { data: [], error: null };
    throw new Error("unmocked rawQuery: " + sql.slice(0, 60));
  },
  supabase: {
    forTenant: () => ({
      from: (table: string) => ({
        // The marker-turn read (resume_chats).
        select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }),
        upsert: async (row: Record<string, unknown>) => {
          h.state.calls.push({ op: "upsert:" + table, row });
          return { error: table === "tailored_resumes" ? h.state.upsertError : null };
        },
      }),
    }),
  },
}));

// insertSavedRow's {duplicateOf} outcome cannot be produced through the rawQuery mock
// (allowDuplicate: true skips the dedupe select entirely), so it is forced here. The real
// implementation runs for every other test — the insert-argument assertions below are
// asserting the real statement, not a stub's bookkeeping.
vi.mock("@/lib/saved-resume-insert", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/saved-resume-insert")>();
  return {
    insertSavedRow: async (...args: Parameters<typeof real.insertSavedRow>) =>
      h.state.forceDuplicate ? { duplicateOf: "some-other-row" } : real.insertSavedRow(...args),
  };
});

import { restoreSavedVersion } from "@/app/actions/restore-saved-version";

const SELECTION = selectBullets(career as CareerRecord, { themes: ["systems", "data"] });
const draftOf = (over: Record<string, unknown> = {}) => ({
  themes: ["systems", "data"],
  selection: SELECTION,
  overrides: over,
});
const RESTORING = { themes: ["ops"], selection: SELECTION, overrides: {} };

const ops = () => h.state.calls.map((c) => (c.op === "rawQuery" ? c.sql!.slice(0, 34) : c.op));
const insertArgs = () => h.state.calls.find((c) => c.sql?.startsWith("insert into saved_resumes"))?.args;

beforeEach(() => {
  h.state.calls = [];
  h.state.savedRow = {
    job_id: "job-1", role_title: "Head of RevOps", company: "Acme",
    content: RESTORING, created_at: "2026-09-01T00:00:00Z",
  };
  h.state.draftContent = draftOf();
  h.state.newestContent = undefined;
  h.state.insertResult = { data: [{ id: "cp-1" }], error: null };
  h.state.upsertError = null;
  h.state.forceDuplicate = false;
});

describe("restoreSavedVersion", () => {
  it("checkpoints the draft it is about to overwrite", async () => {
    const res = await restoreSavedVersion("s1");
    expect(res.error).toBeUndefined();
    expect(res).toMatchObject({ jobId: "job-1", checkpointId: "cp-1" });
  });

  // Mutation: writing the checkpoint with kind "save", or with SAVE_RETENTION_DAYS.
  // Both make the row indistinguishable from a deliberate Save — the demotion's
  // `kind = 'checkpoint'` filter would then demote real saves, and the 60-day
  // window would be claimed by an auto row.
  it("writes the checkpoint as kind 'checkpoint' with the 30-day window", async () => {
    const before = Date.now();
    await restoreSavedVersion("s1");
    const args = insertArgs()!;
    expect(args[11]).toBe("checkpoint");
    const days = (Date.parse(args[8] as string) - before) / 86_400_000;
    expect(days).toBeGreaterThan(29.9);
    expect(days).toBeLessThan(30.1);
  });

  // Mutation: dropping `pageMargin` from the insertSavedRow call. page_margin lives
  // OUTSIDE the captured HTML (migration 020's whole reason), so a checkpoint of a
  // 0.5in draft silently prints and downloads at the 0.68in default.
  it("carries the draft's page margin onto the checkpoint row", async () => {
    h.state.draftContent = draftOf({ pageMargin: "0.5in" });
    await restoreSavedVersion("s1");
    expect(insertArgs()![9]).toBe("0.5in");
  });

  // Mutation: moving the demotion above the tailored_resumes upsert. Demoting first
  // moves the previous checkpoint — potentially the only copy of an EARLIER draft —
  // from 30 days to 3 for a restore that then fails and never happened.
  it("demotes older checkpoints strictly after the draft upsert succeeds", async () => {
    await restoreSavedVersion("s1");
    const o = ops();
    const upsert = o.indexOf("upsert:tailored_resumes");
    const demote = o.findIndex((s) => s.startsWith("update saved_resumes set expires"));
    expect(upsert).toBeGreaterThan(-1);
    expect(demote).toBeGreaterThan(upsert);
  });

  // Mutation: removing BOTH checkpoint guards (the `error !== undefined` return and the
  // `id === undefined` return). This is the data-loss path — the upsert then overwrites the
  // working draft with no copy of it anywhere. Deleting only the first guard does NOT fail
  // this test, and that is a fact about the code rather than a hole in the test: the second
  // guard catches the same case, since a failed insert also leaves `id` undefined.
  it("restores nothing when the checkpoint could not be written", async () => {
    h.state.insertResult = { data: [], error: { message: "disk full" } };
    const res = await restoreSavedVersion("s1");
    expect(res.error).toBeDefined();
    expect(res.jobId).toBeUndefined();
    expect(ops()).not.toContain("upsert:tailored_resumes");
  });

  // Mutation: same path, the OTHER outcome of insertSavedRow — {duplicateOf} rather
  // than {error}, which leaves `id` undefined. Unreachable only because allowDuplicate
  // is set today; dropping that flag makes the draft destroyable through this branch.
  it("restores nothing when the checkpoint insert returns no id", async () => {
    h.state.forceDuplicate = true;
    const res = await restoreSavedVersion("s1");
    expect(res.error).toBeDefined();
    expect(ops()).not.toContain("upsert:tailored_resumes");
  });

  // Mutation: deleting the `shouldCheckpoint` conjunct at the callsite. A draft that
  // already equals the newest live saved row needs no second copy of itself.
  it("writes no checkpoint when the draft already equals the newest saved row", async () => {
    h.state.newestContent = h.state.draftContent;
    const res = await restoreSavedVersion("s1");
    expect(res.checkpointId).toBeUndefined();
    expect(ops()).not.toContain("insert into saved_resumes");
    expect(ops()).toContain("upsert:tailored_resumes");
  });

  // Mutation: deleting the `restoreWouldChangeNothing` conjunct at the callsite. A
  // back-navigate and a second click on the same version then writes a junk checkpoint
  // holding S and demotes the real one — the only copy of the original draft — to 3 days.
  it("writes no checkpoint when restoring what the draft already holds", async () => {
    h.state.draftContent = RESTORING;
    const res = await restoreSavedVersion("s1");
    expect(res.checkpointId).toBeUndefined();
    expect(ops()).not.toContain("insert into saved_resumes");
  });

  // Mutation: moving the demotion above the upsert — it would then run even though the
  // restore failed. The checkpoint id is returned alongside the error deliberately: the
  // checkpoint is real and committed, and the caller must not present it as lost.
  it("returns the checkpoint id and demotes nothing when the upsert fails", async () => {
    h.state.upsertError = { message: "conflict" };
    const res = await restoreSavedVersion("s1");
    expect(res.error).toBeDefined();
    expect(res.checkpointId).toBe("cp-1");
    expect(ops().some((s) => s.startsWith("update saved_resumes set expires"))).toBe(false);
  });
});
