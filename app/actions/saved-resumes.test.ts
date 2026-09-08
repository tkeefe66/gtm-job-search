// app/actions/saved-resumes.test.ts
//
// Pins what app/actions/auth-required.test.ts structurally cannot: a
// SESSION-HOLDING but non-admin actor must still be refused. Exact mirror of
// app/actions/resume.test.ts.
//
// Also pins page_margin (Task 14): saveResumeFromDraft persists it, both reads
// (listSavedResumes and getSavedResume) return it, and a null column reads
// back as null here — the DEFAULT_PAGE_MARGIN default (lib/resume-download.ts)
// is applied by the renderer (SavedResumePanel's `resume.pageMargin ||
// DEFAULT_PAGE_MARGIN`), never invented at this layer as "" or as a failure.
import { beforeEach, describe, expect, it, test, vi } from "vitest";

// isAdmin is toggled per-suite via this hoisted, mutable state rather than a
// static literal — the refusal tests below need isAdmin: false and the
// page_margin tests need an admin actor, and vi.mock is hoisted module-wide,
// so a single static mock cannot serve both. vi.hoisted is what makes a
// variable available inside a hoisted factory at all.
const auth = vi.hoisted(() => ({ isAdmin: false }));
vi.mock("@/lib/require-actor", () => ({
  requireActor: async () => ({
    userId: auth.isAdmin ? "admin-1" : "u1",
    tenantId: auth.isAdmin ? "admin-1" : "u1",
    email: auth.isAdmin ? "admin@example.com" : "someone@example.com",
    isAdmin: auth.isAdmin,
  }),
}));

// rawQuery is dispatched by matching the leading SQL keywords/table rather
// than by call order, so the opportunistic purge inside listSavedResumes
// (a DELETE that runs before the SELECT) doesn't have to be modeled turn by
// turn. deleteSavedResume/deleteSavedResumes go through the query builder,
// not rawQuery, and aren't exercised here.
const h = vi.hoisted(() => {
  const state = {
    insertArgs: null as unknown[] | null,
    listRow: null as Record<string, unknown> | null,
    getRow: null as Record<string, unknown> | null,
    // undefined means "no draft row found" (mirrors data.length === 0 in the
    // real driver), distinct from a draft that legitimately stored null
    // content — see the tailored_resumes branch below.
    draftContent: undefined as unknown,
    sourceRow: null as Record<string, unknown> | null,
  };
  return { state };
});

vi.mock("@/lib/supabase", () => ({
  supabase: { forTenant: () => ({ from: () => ({}) }) },
  rawQuery: async (sql: string, args: unknown[]) => {
    if (sql.indexOf("insert into saved_resumes") === 0) {
      h.state.insertArgs = args;
      return { data: [{ id: "new-id" }], error: null };
    }
    if (sql.indexOf("delete from saved_resumes") === 0) {
      return { data: [], error: null }; // opportunistic purge inside listSavedResumes
    }
    if (sql.indexOf("select content from tailored_resumes") === 0) {
      // saveResumeFromDraft's server-side read of the draft's BASE selection.
      return {
        data: h.state.draftContent !== undefined ? [{ content: h.state.draftContent }] : [],
        error: null,
      };
    }
    if (sql.indexOf("select job_id, role_title, company, content from saved_resumes") === 0) {
      // saveResumeAsNewVersion's read of the SOURCE row being versioned.
      return { data: h.state.sourceRow ? [h.state.sourceRow] : [], error: null };
    }
    if (sql.indexOf("select id") === 0 && sql.indexOf("html") !== -1) {
      // getSavedResume's select (the only one carrying html/design_version)
      return { data: h.state.getRow ? [h.state.getRow] : [], error: null };
    }
    if (sql.indexOf("select id") === 0) {
      // listSavedResumes' select, and insertSavedRow's own duplicate-check
      // select, which shares the "select id from saved_resumes" prefix.
      return { data: h.state.listRow ? [h.state.listRow] : [], error: null };
    }
    return { data: [], error: null };
  },
}));

import {
  saveResumeFromDraft,
  saveResumeAsNewVersion,
  listSavedResumes,
  getSavedResume,
  deleteSavedResume,
  deleteSavedResumes,
  getDownloadAssets,
} from "./saved-resumes";
import { savedRowToSummary } from "@/lib/saved-resume-shape";

const ID = "11111111-1111-1111-1111-111111111111";

beforeEach(() => {
  auth.isAdmin = false;
  h.state.insertArgs = null;
  h.state.listRow = null;
  h.state.getRow = null;
  h.state.draftContent = undefined;
  h.state.sourceRow = null;
});

describe("saved-resumes.ts refuses a non-admin actor", () => {
  test("saveResumeFromDraft", async () => {
    await expect(
      saveResumeFromDraft({
        jobId: ID,
        html: "<div class=\"rsm\"></div>",
        roleTitle: "t",
        company: "c",
      })
    ).rejects.toThrow(/Not authorized/);
  });
  test("saveResumeAsNewVersion", async () => {
    await expect(
      saveResumeAsNewVersion({ fromSavedId: ID, html: "<div class=\"rsm\"></div>" })
    ).rejects.toThrow(/Not authorized/);
  });
  test("listSavedResumes", async () => {
    await expect(listSavedResumes()).rejects.toThrow(/Not authorized/);
  });
  test("getSavedResume", async () => {
    await expect(getSavedResume(ID)).rejects.toThrow(/Not authorized/);
  });
  test("deleteSavedResume", async () => {
    await expect(deleteSavedResume(ID)).rejects.toThrow(/Not authorized/);
  });
  test("deleteSavedResumes", async () => {
    await expect(deleteSavedResumes([ID])).rejects.toThrow(/Not authorized/);
  });
  test("getDownloadAssets", async () => {
    await expect(getDownloadAssets()).rejects.toThrow(/Not authorized/);
  });
});

describe("saved-resumes.ts: page_margin", () => {
  beforeEach(() => {
    auth.isAdmin = true;
  });

  // Index 9 of the insert's values list: tenant_id, job_id, role_title,
  // company, label, html, design_version, content_hash, expires_at,
  // page_margin, content, kind — see insertSavedRow's INSERT statement in
  // lib/saved-resume-insert.ts.
  const PAGE_MARGIN_ARG_INDEX = 9;

  test("saveResumeFromDraft inserts the given pageMargin", async () => {
    const res = await saveResumeFromDraft({
      jobId: ID,
      html: '<div class="rsm"></div>',
      roleTitle: "VP RevOps",
      company: "Acme",
      allowDuplicate: true, // skips the dup-check SELECT, isolating the INSERT under test
      pageMargin: "0.5in",
    });

    expect(res.error).toBeUndefined();
    expect(res.id).toBe("new-id");
    expect(h.state.insertArgs).not.toBeNull();
    expect((h.state.insertArgs as unknown[])[PAGE_MARGIN_ARG_INDEX]).toBe("0.5in");
  });

  test("saveResumeFromDraft stores an omitted pageMargin as null, not as \"\"", async () => {
    await saveResumeFromDraft({
      jobId: ID,
      html: '<div class="rsm"></div>',
      roleTitle: "VP RevOps",
      company: "Acme",
      allowDuplicate: true,
    });

    expect((h.state.insertArgs as unknown[])[PAGE_MARGIN_ARG_INDEX]).toBe(null);
  });

  test("listSavedResumes returns the stored pageMargin", async () => {
    h.state.listRow = {
      id: ID,
      job_id: "job-1",
      role_title: "VP RevOps",
      company: "Acme",
      label: null,
      created_at: "2026-09-01T00:00:00.000Z",
      expires_at: "2026-10-31T00:00:00.000Z",
      page_margin: "0.5in",
    };

    const res = await listSavedResumes();

    expect(res.error).toBeUndefined();
    expect(res.resumes).toHaveLength(1);
    expect(res.resumes[0].pageMargin).toBe("0.5in");
  });

  test("listSavedResumes: a null page_margin column reads back as null, not \"\"", async () => {
    h.state.listRow = {
      id: ID,
      job_id: "job-1",
      role_title: "VP RevOps",
      company: "Acme",
      label: null,
      created_at: "2026-09-01T00:00:00.000Z",
      expires_at: "2026-10-31T00:00:00.000Z",
      page_margin: null,
    };

    const res = await listSavedResumes();

    // Every row written before this column existed is null here. The
    // 0.68in fallback belongs to the renderer (SavedResumePanel), not to
    // this action — inventing a default at this layer would make a genuine
    // null indistinguishable from a future bug that fails to select the
    // column at all.
    expect(res.resumes[0].pageMargin).toBeNull();
  });

  test("getSavedResume returns the stored pageMargin", async () => {
    h.state.getRow = {
      id: ID,
      job_id: "job-1",
      role_title: "VP RevOps",
      company: "Acme",
      label: null,
      created_at: "2026-09-01T00:00:00.000Z",
      expires_at: "2026-10-31T00:00:00.000Z",
      html: '<div class="rsm"></div>',
      design_version: "2026-08-28",
      page_margin: "0.75in",
    };

    const res = await getSavedResume(ID);

    expect(res.error).toBeUndefined();
    expect(res.resume?.pageMargin).toBe("0.75in");
  });

  test("getSavedResume: a null page_margin column reads back as null, not \"\"", async () => {
    h.state.getRow = {
      id: ID,
      job_id: "job-1",
      role_title: "VP RevOps",
      company: "Acme",
      label: null,
      created_at: "2026-09-01T00:00:00.000Z",
      expires_at: "2026-10-31T00:00:00.000Z",
      html: '<div class="rsm"></div>',
      design_version: "2026-08-28",
      page_margin: null,
    };

    const res = await getSavedResume(ID);

    expect(res.resume?.pageMargin).toBeNull();
  });
});

// Fix round 1, I-1: the task's core invariant — content is read SERVER-SIDE
// from tailored_resumes for a fresh save, and copied forward from the SOURCE
// saved row (never the draft) for a new version — had no assertion at the
// action layer. Before this block, insertSavedRow hardcoding content: null,
// saveResumeFromDraft accepting a client-supplied content, and
// saveResumeAsNewVersion reading the draft instead of the source row all
// passed the whole file.
describe("saved-resumes.ts: content and kind", () => {
  beforeEach(() => {
    auth.isAdmin = true;
  });

  // Index 10/11 of the insert's values list — see PAGE_MARGIN_ARG_INDEX's
  // comment above for the full column order.
  const CONTENT_ARG_INDEX = 10;
  const KIND_ARG_INDEX = 11;

  test("saveResumeFromDraft writes the draft's content, JSON-stringified, and kind \"save\"", async () => {
    const sentinel = { totem: "draft-sentinel" };
    h.state.draftContent = sentinel;

    const res = await saveResumeFromDraft({
      jobId: ID,
      html: '<div class="rsm"></div>',
      roleTitle: "VP RevOps",
      company: "Acme",
      allowDuplicate: true, // isolates the INSERT from the dup-check SELECT
    });

    expect(res.error).toBeUndefined();
    const args = h.state.insertArgs as unknown[];
    // Kills a hardcoded content: null — the tailored_resumes read must
    // actually reach the insert.
    expect(args[CONTENT_ARG_INDEX]).toBe(JSON.stringify(sentinel));
    // Kills accepting content from the caller: nothing in the input above
    // carries a `content` field, so a value here can only have come from the
    // mocked tailored_resumes read.
    expect(args[KIND_ARG_INDEX]).toBe("save");
  });

  test(
    "saveResumeAsNewVersion writes the SOURCE row's job/role/company/content — " +
      "never the draft's",
    async () => {
      const sourceSentinel = { totem: "source-sentinel" };
      const draftSentinel = { totem: "draft-sentinel-should-not-appear" };
      h.state.sourceRow = {
        job_id: "job-src",
        role_title: "Director of RevOps",
        company: "Globex",
        content: sourceSentinel,
      };
      // A correct implementation never queries tailored_resumes for this
      // action at all. Setting a DIFFERENT, recognisable sentinel here is
      // what makes the absence assertion below meaningful: a wrong
      // implementation that reads the draft INSTEAD of (or in addition to)
      // the source row would leak this string into the insert args.
      h.state.draftContent = draftSentinel;

      const res = await saveResumeAsNewVersion({
        fromSavedId: "saved-1",
        html: '<div class="rsm"></div>',
        allowDuplicate: true,
      });

      expect(res.error).toBeUndefined();
      const args = h.state.insertArgs as unknown[];
      expect(args[1]).toBe("job-src");
      expect(args[2]).toBe("Director of RevOps");
      expect(args[3]).toBe("Globex");
      expect(args[CONTENT_ARG_INDEX]).toBe(JSON.stringify(sourceSentinel));
      // The one assertion that catches "reads the draft instead of the
      // source row": a wrong implementation that happens to also satisfy the
      // value checks above (e.g. by reading both and preferring the source)
      // would still slip past them without this.
      expect(args).not.toContain(JSON.stringify(draftSentinel));
    }
  );

  test("saveResumeAsNewVersion: no such saved résumé", async () => {
    h.state.sourceRow = null;

    const res = await saveResumeAsNewVersion({
      fromSavedId: "missing",
      html: '<div class="rsm"></div>',
    });

    expect(res.error).toBe("Could not find that saved résumé.");
    expect(h.state.insertArgs).toBeNull();
  });

  test("saveResumeAsNewVersion: refuses when the source row's job was deleted", async () => {
    h.state.sourceRow = {
      job_id: null,
      role_title: "VP RevOps",
      company: "Acme",
      content: null,
    };

    const res = await saveResumeAsNewVersion({
      fromSavedId: "orphaned",
      html: '<div class="rsm"></div>',
    });

    expect(res.error).toBe(
      "The tracked role this résumé came from was deleted, so it cannot be versioned."
    );
    expect(h.state.insertArgs).toBeNull();
  });
});

describe("savedRowToSummary", () => {
  const row = {
    id: "s1",
    job_id: "j1",
    role_title: "Director",
    company: "Acme",
    label: null,
    created_at: "2026-09-08T00:00:00.000Z",
    expires_at: "2026-11-07T00:00:00.000Z",
    page_margin: null,
    kind: "checkpoint",
    has_content: true,
  };

  // Mutation this catches: selecting `content` itself into the list. lib/types.ts
  // documents why `html` is excluded from the summary — at up to 512 KB a row it
  // would ship every document in the tenant on one page load — and `content`
  // carries the full selection plus overrides.text, which is arbitrary rewritten
  // bullet prose. The affordance needs a boolean, so the summary carries one.
  it("carries a boolean, never the content payload", () => {
    const s = savedRowToSummary(row);
    expect(s.hasContent).toBe(true);
    expect(Object.keys(s)).not.toContain("content");
  });

  // Fix round 1, M-3: without this, hasContent: true is hardcoded in the
  // mapper and the test above can never fail. Pins `r.has_content === true`,
  // which also correctly maps an undefined has_content (a pre-021 read that
  // never selected the column) to false rather than throwing or defaulting
  // to true.
  it("maps has_content: false to hasContent: false", () => {
    expect(savedRowToSummary({ ...row, has_content: false }).hasContent).toBe(false);
  });

  // Mutation this catches: defaulting kind to "save" in the mapper. A checkpoint
  // mislabelled as a save reads as a document the user chose to keep, and its
  // 3-day clock becomes invisible.
  it("preserves the row's kind", () => {
    expect(savedRowToSummary(row).kind).toBe("checkpoint");
    expect(savedRowToSummary({ ...row, kind: "save" }).kind).toBe("save");
  });
});
