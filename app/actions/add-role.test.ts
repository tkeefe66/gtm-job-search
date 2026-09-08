import { beforeEach, describe, expect, test, vi } from "vitest";

const h = vi.hoisted(() => ({
  onboardedAt: "2026-08-18T01:58:02Z" as string | null,
  read: { kind: "unreadable" } as Record<string, unknown>,
  ingest: { added: [{}], skipped: [], seenTitles: [] } as Record<string, unknown>,
  existing: [] as { id: string; source_url: string | null; status?: string }[],
  score: { score: 4, rationale: "fits" } as { score: number; rationale: string },
}));

vi.mock("@/lib/require-actor", () => ({
  requireActor: vi.fn(async () => ({ tenantId: "t1", isAdmin: false })),
}));
vi.mock("@/lib/settings-store", () => ({
  readOnboardedAtFor: vi.fn(async () => h.onboardedAt),
}));
vi.mock("@/lib/metered", () => ({
  withBudget: vi.fn(async (o: { fn: () => Promise<unknown> }) => ({ result: await o.fn() })),
}));
vi.mock("@/lib/posting-read", () => ({
  readPosting: vi.fn(async () => h.read),
  readPostingText: vi.fn(async () => h.read),
  readDetail: (r: { detail: unknown }) => ({
    ...(r.detail as object),
    enrichedAt: "2026-09-08T00:00:00.000Z",
  }),
}));
vi.mock("@/lib/supabase", () => ({
  supabase: {
    forTenant: () => ({
      from: () => ({
        select: () => ({ eq: () => ({ ilike: async () => ({ data: h.existing, error: null }) }) }),
      }),
    }),
  },
  rawQuery: vi.fn(async () => ({ data: h.existing, error: null })),
}));
vi.mock("@/app/actions/jobs", () => ({
  updateJob: vi.fn(async () => ({})),
  getJobStatuses: vi.fn(async () => ({
    statuses: [
      { key: "New", label: "New", bucket: "active", hidden: false },
      { key: "Not Interested", label: "Not Interested", bucket: "terminal", hidden: false },
    ],
  })),
}));
vi.mock("@/app/actions/parse-role", () => ({ scoreFit: vi.fn(async () => h.score) }));
vi.mock("@/lib/tenant", () => ({ resolveTenantId: async () => "t1" }));
vi.mock("@/lib/ingest-roles", () => ({
  ingestRoles: vi.fn(async () => h.ingest),
  MAX_SEARCH_READS: 20,
}));
vi.mock("@/lib/search-criteria", () => ({
  loadCriteriaAndScoringInputs: async () => ({ fitInputs: {} }),
}));

import { addRoleFromUrl } from "./add-role";
import { ingestRoles } from "@/lib/ingest-roles";
import { readPosting, readPostingText } from "@/lib/posting-read";
import { updateJob } from "@/app/actions/jobs";
import { scoreFit } from "@/app/actions/parse-role";

const READ = {
  kind: "read",
  detail: { requirements: ["SQL"], niceToHaves: [] },
  department: "RevOps",
  employer: "Baseten",
  title: "Director, Revenue Operations",
  summary: "Runs the stack.",
  empty: false,
};

beforeEach(() => {
  h.onboardedAt = "2026-08-18T01:58:02Z";
  h.read = { kind: "unreadable" };
  h.ingest = { added: [{}], skipped: [], seenTitles: [] };
  h.existing = [];
  h.score = { score: 4, rationale: "fits" };
  vi.clearAllMocks();
});

describe("adding a role from its URL", () => {
  test("a readable posting lands with its own employer and title", async () => {
    h.read = READ;

    const res = await addRoleFromUrl({ url: "https://jobs.ashbyhq.com/baseten/1" });

    expect(res.added).toEqual({
      company: "Baseten",
      roleTitle: "Director, Revenue Operations",
      read: true,
    });
  });

  // The whole reason URL beats paste: ingest gets the posting we already read,
  // so the row is stored without a second fetch and a second billed call.
  test("the posting just read is handed to ingest rather than read again", async () => {
    h.read = READ;

    await addRoleFromUrl({ url: "https://jobs.ashbyhq.com/baseten/1" });

    const opts = vi.mocked(ingestRoles).mock.calls[0][0];
    expect(opts.preRead?.["https://jobs.ashbyhq.com/baseten/1"]).toBe(h.read);
    expect(opts.source).toBe("Added by URL");
  });

  test("what the user typed wins over the page's own words", async () => {
    h.read = READ;

    const res = await addRoleFromUrl({
      url: "https://jobs.ashbyhq.com/baseten/1",
      company: "Baseten Inc",
    });

    expect(res.added?.company).toBe("Baseten Inc");
  });

  test("a trailing slash does not create a second row for one posting", async () => {
    h.read = READ;

    await addRoleFromUrl({ url: "  https://jobs.ashbyhq.com/baseten/1/  " });

    expect(vi.mocked(ingestRoles).mock.calls[0][0].roles[0].job_url).toBe(
      "https://jobs.ashbyhq.com/baseten/1"
    );
  });
});

describe("when the site cannot be read", () => {
  test("the paste box is offered, with the reason and the link kept", async () => {
    h.read = { kind: "unreadable" };

    const res = await addRoleFromUrl({ url: "https://www.indeed.com/viewjob?jk=1" });

    expect(res.needsPaste?.url).toBe("https://www.indeed.com/viewjob?jk=1");
    expect(res.needsPaste?.reason.toLowerCase()).toContain("blocks automated readers");
    expect(vi.mocked(ingestRoles)).not.toHaveBeenCalled();
  });

  // The point of the fallback: the JD arrives by hand, the row still keeps the
  // URL, so liveness checking keeps working on it forever.
  test("pasted text stores the role against the original link", async () => {
    h.read = READ;

    const res = await addRoleFromUrl({
      url: "https://www.indeed.com/viewjob?jk=1",
      company: "Baseten",
      roleTitle: "Director, Revenue Operations",
      pastedText: "We are looking for someone to run the revenue stack.",
    });

    expect(vi.mocked(readPostingText)).toHaveBeenCalledTimes(1);
    // The fetch is SKIPPED: the user is pasting because it cannot work.
    expect(vi.mocked(readPosting)).not.toHaveBeenCalled();
    expect(vi.mocked(ingestRoles).mock.calls[0][0].roles[0].job_url).toBe(
      "https://www.indeed.com/viewjob?jk=1"
    );
    expect(res.added).toBeTruthy();
  });

  test("a page that names no role asks for the identity rather than inventing one", async () => {
    h.read = { ...READ, employer: "", title: "" };

    const res = await addRoleFromUrl({ url: "https://x.com/careers/1" });

    expect(res.needsPaste?.reason.toLowerCase()).toContain("which role");
    expect(vi.mocked(ingestRoles)).not.toHaveBeenCalled();
  });
});

describe("the gates", () => {
  test("an un-onboarded tenant is refused before anything is read", async () => {
    h.onboardedAt = null;

    const res = await addRoleFromUrl({ url: "https://x.com/jobs/1" });

    expect(res.error).toBeTruthy();
    expect(vi.mocked(readPosting)).not.toHaveBeenCalled();
  });

  test("something that is not a link is refused with a sentence", async () => {
    const res = await addRoleFromUrl({ url: "paste the job description here" });

    expect(res.error).toContain("link");
    expect(vi.mocked(readPosting)).not.toHaveBeenCalled();
  });

  test("a role already tracked says so rather than reporting success", async () => {
    h.read = READ;
    h.ingest = { added: [], skipped: [{}], seenTitles: [] };

    const res = await addRoleFromUrl({ url: "https://jobs.ashbyhq.com/baseten/1" });

    expect(res.error).toContain("already");
  });
});

// Seen in use: pasting a live posting URL for a role already tracked answered
// "You already have that role." and stopped — while holding a freshly read job
// description the row did not have. The duplicate is not the point; the JD is.
describe("a role you already have gets the description attached", () => {
  test("the existing row is updated rather than refused", async () => {
    h.read = READ;
    h.ingest = { added: [], skipped: [{}], seenTitles: [] };
    h.existing = [{ id: "job-9", source_url: null }];

    const res = await addRoleFromUrl({ url: "https://jobs.ashbyhq.com/openai/a389" });

    expect(vi.mocked(updateJob).mock.calls[0][0]).toBe("job-9");
    expect(vi.mocked(updateJob).mock.calls[0][1]).toMatchObject({
      posting: expect.objectContaining({ requirements: ["SQL"] }),
      job_url: "https://jobs.ashbyhq.com/openai/a389",
    });
    expect(res.added).toBeTruthy();
  });

  // The pasted URL is the user's own evidence about where the posting lives, so
  // it replaces the stored link — and relinkPatch keeps the old one, so the
  // repair is never lossy.
  test("the link the user pasted replaces the stored one, non-destructively", async () => {
    h.read = READ;
    h.ingest = { added: [], skipped: [{}], seenTitles: [] };
    h.existing = [{ id: "job-9", source_url: null }];

    await addRoleFromUrl({ url: "https://jobs.ashbyhq.com/openai/a389" });

    expect(vi.mocked(updateJob).mock.calls[0][1]).toMatchObject({
      source_url: expect.any(String),
    });
  });

  // Nothing to attach means nothing to say beyond the duplicate.
  test("a duplicate with no readable posting still just reports the duplicate", async () => {
    h.read = { kind: "unreadable" };
    h.ingest = { added: [], skipped: [{}], seenTitles: [] };
    h.existing = [{ id: "job-9", source_url: null }];

    const res = await addRoleFromUrl({
      url: "https://www.indeed.com/viewjob?jk=1",
      company: "Acme",
      roleTitle: "RevOps",
      pastedText: "",
    });

    expect(res.needsPaste).toBeTruthy();
  });

  test("a duplicate we cannot locate says so rather than failing silently", async () => {
    h.read = READ;
    h.ingest = { added: [], skipped: [{}], seenTitles: [] };
    h.existing = [];

    const res = await addRoleFromUrl({ url: "https://jobs.ashbyhq.com/openai/a389" });

    expect(res.error).toContain("already");
  });
});

// The gap that left a score of 1 on screen after the user supplied the JD: the
// attach path stored the posting and never re-scored, so the row kept a number
// computed from a job title and the fit cutoff — which only runs where a score
// is written — never saw it.
describe("attaching a description re-scores the row it belongs to", () => {
  beforeEach(() => {
    h.read = READ;
    h.ingest = { added: [], skipped: [{}], seenTitles: [] };
    h.existing = [{ id: "job-9", source_url: null, status: "New" }];
  });

  test("the row is scored against the posting that was just attached", async () => {
    h.score = { score: 4, rationale: "fits" };

    await addRoleFromUrl({ url: "https://jobs.ashbyhq.com/openai/a389" });

    const scored = vi.mocked(scoreFit).mock.calls[0][0];
    expect(scored.key_skills).toBe(READ.summary);
    expect(vi.mocked(updateJob).mock.calls[0][1]).toMatchObject({ fit_score: 4 });
  });

  // REVERSED deliberately, minutes after it was written: this path first filed
  // a weak role away like every other scoring site, and the first manual add
  // scored 2, filed itself, and vanished from the open list. The cutoff exists
  // to keep a SEARCH's output out of the table; a URL the user pasted is a
  // decision, and the app must not silently overturn it. The score is still
  // written, so the number stays honest.
  test("a role that reads weak keeps its score and stays where the user put it", async () => {
    h.score = { score: 1, rationale: "not close" };

    await addRoleFromUrl({ url: "https://jobs.ashbyhq.com/openai/a389" });

    const patch = vi.mocked(updateJob).mock.calls[0][1];
    expect(patch).toMatchObject({ fit_score: 1 });
    expect(patch).not.toHaveProperty("status");
  });

  // A failed score must not overwrite a real one with zero, and must not file
  // anything: scoreFit returns 0 rather than throwing.
  test("a failed score leaves the existing score alone", async () => {
    h.score = { score: 0, rationale: "" };

    await addRoleFromUrl({ url: "https://jobs.ashbyhq.com/openai/a389" });

    const patch = vi.mocked(updateJob).mock.calls[0][1];
    expect(patch).not.toHaveProperty("fit_score");
    expect(patch).not.toHaveProperty("status");
    expect(patch).toHaveProperty("posting");
  });
});

// The same rule on the attach path: a role you pasted a URL for is a decision,
// and re-scoring it must not undo that decision.
describe("a role you added yourself is never filed away by its score", () => {
  test("the ingest is told these roles were chosen", async () => {
    h.read = READ;

    await addRoleFromUrl({ url: "https://jobs.ashbyhq.com/openai/a389" });

    expect(vi.mocked(ingestRoles).mock.calls[0][0].chosenByUser).toBe(true);
  });

  test("attaching to an existing row scores it but does not file it", async () => {
    h.read = READ;
    h.ingest = { added: [], skipped: [{}], seenTitles: [] };
    h.existing = [{ id: "job-9", source_url: null, status: "New" }];
    h.score = { score: 1, rationale: "not close" };

    await addRoleFromUrl({ url: "https://jobs.ashbyhq.com/openai/a389" });

    const patch = vi.mocked(updateJob).mock.calls[0][1];
    expect(patch).toMatchObject({ fit_score: 1 });
    expect(patch).not.toHaveProperty("status");
  });
});
