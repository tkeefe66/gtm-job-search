import { beforeEach, describe, expect, test, vi } from "vitest";

// Same harness as lib/ingest-roles.test.ts: mock the edges, keep the decision.
// What is left is the guardrail, the spend gate and the report.
const h = vi.hoisted(() => ({
  jobs: [] as Record<string, unknown>[],
  onboardedAt: "2026-08-18T01:58:02Z" as string | null,
  robotsAllows: true,
  page: null as string | null,
  answer: JSON.stringify({
    requirements: ["5 years of SQL"],
    nice_to_haves: ["Python"],
    department: "Revenue Operations",
    description_summary: "Runs the revenue stack.",
  }),
  verified: { kind: "notApplicable" } as { kind: string; url?: string; reason?: string },
  resolved: null as { url: string; precision: string } | null,
  updateError: undefined as string | undefined,
  body: null as { text: string; department: string } | null,
}));

vi.mock("@/lib/require-actor", () => ({
  requireActor: vi.fn(async () => ({ tenantId: "t1", isAdmin: false })),
}));
vi.mock("@/lib/tenant", () => ({ resolveTenantId: async () => "t1" }));
vi.mock("@/lib/settings-store", () => ({
  readOnboardedAtFor: vi.fn(async () => h.onboardedAt),
}));
vi.mock("@/lib/supabase", () => ({
  supabase: {
    forTenant: () => ({
      from: () => ({ select: async () => ({ data: h.jobs, error: null }) }),
    }),
  },
}));
vi.mock("@/app/actions/jobs", () => ({
  updateJob: vi.fn(async () => ({ error: h.updateError })),
  getJobStatuses: vi.fn(async () => ({
    statuses: [
      { key: "New", label: "New", bucket: "active", hidden: false },
      { key: "Posting Closed", label: "Closed", bucket: "terminal", hidden: false },
    ],
  })),
}));
// Metered: the real thing reserves against a ceiling. Here it just runs fn, so
// the tests below can assert WHERE the reservation happens by counting calls.
vi.mock("@/lib/metered", () => ({
  withBudget: vi.fn(async (opts: { fn: () => Promise<unknown> }) => ({
    result: await opts.fn(),
  })),
}));
vi.mock("@/lib/fetch-page", () => ({
  fetchAllowed: vi.fn(async () => h.robotsAllows),
  fetchPage: vi.fn(async () => h.page),
}));
vi.mock("@/lib/model-call", () => ({
  callStructured: vi.fn(async () => h.answer),
  parseJson: (raw: string) => JSON.parse(raw),
}));
vi.mock("@/lib/resolve-job-link", () => ({
  newBoardCache: () => new Map(),
  verifyPostingLink: vi.fn(async () => h.verified),
  fetchPostingBody: vi.fn(async () => h.body),
  resolveEmployerLink: vi.fn(async () => h.resolved),
}));

import { enrichRoles } from "./enrich";
import { updateJob } from "@/app/actions/jobs";
import { callStructured } from "@/lib/model-call";
import { fetchAllowed, fetchPage } from "@/lib/fetch-page";
import { withBudget } from "@/lib/metered";
import { readOnboardedAtFor } from "@/lib/settings-store";
import { fetchPostingBody, resolveEmployerLink } from "@/lib/resolve-job-link";

const POSTING =
  "<html><body><p>" +
  "Requires 5 years of SQL. Nice to have: Python. ".repeat(20) +
  "</p></body></html>";

const row = (over: Record<string, unknown> = {}) => ({
  id: "j1",
  company: "Clay",
  role_title: "RevOps Manager",
  status: "New",
  job_url: "https://clay.com/careers/1",
  source_url: null,
  key_skills: null,
  department: null,
  posting: null,
  ...over,
});

beforeEach(() => {
  h.jobs = [row()];
  h.onboardedAt = "2026-08-18T01:58:02Z";
  h.robotsAllows = true;
  h.page = POSTING;
  h.answer = JSON.stringify({
    requirements: ["5 years of SQL"],
    nice_to_haves: ["Python"],
    department: "Revenue Operations",
    description_summary: "Runs the revenue stack.",
  });
  h.verified = { kind: "notApplicable" };
  h.resolved = null;
  h.updateError = undefined;
  h.body = null;
  vi.clearAllMocks();
});

const patch = () => vi.mocked(updateJob).mock.calls[0][1] as Record<string, unknown>;

describe("a thin row is read and stored", () => {
  test("the posting's own words land in the row", async () => {
    const report = await enrichRoles();

    expect(patch().posting).toMatchObject({
      requirements: ["5 years of SQL"],
      niceToHaves: ["Python"],
    });
    expect(report.enriched).toBe(1);
  });

  test("part 1's columns are filled from the same answer", async () => {
    await enrichRoles();

    expect(patch().department).toBe("Revenue Operations");
    expect(patch().key_skills).toBe("Runs the revenue stack.");
  });

  test("the write is stamped so a rescore offer can tell what is newly enriched", async () => {
    await enrichRoles();

    expect((patch().posting as { enrichedAt?: string }).enrichedAt).toBeTruthy();
  });

  // Otherwise this row is re-fetched and re-billed on every later run: the
  // "thin" predicate is literally `posting is null`.
  test("a model that returns nothing usable still writes a row, counted apart", async () => {
    h.answer = JSON.stringify({ requirements: "none", nice_to_haves: null });

    const report = await enrichRoles();

    expect(patch().posting).toMatchObject({ requirements: [], niceToHaves: [] });
    expect(report.enriched).toBe(0);
    expect(report.empty).toBe(1);
  });

  // FILLS ONLY. A column a human edited on the row, or an earlier ingest
  // wrote, is not overwritten by a backfill reading the page today.
  test("a column that already has a value is left alone", async () => {
    h.jobs = [row({ key_skills: "Owns the stack", department: "RevOps" })];

    await enrichRoles();

    expect(patch().key_skills).toBeUndefined();
    expect(patch().department).toBeUndefined();
    expect(patch().posting).toBeDefined();
  });

  test("a failed write is reported as failed, never as enriched", async () => {
    h.updateError = ""; // the unreachable-database case: presence, not truthiness

    const report = await enrichRoles();

    expect(report.enriched).toBe(0);
    expect(report.failed).toBe(1);
  });
});

describe("nothing is read that the guardrail has not cleared", () => {
  test("an aggregator link is resolved to the employer before anything is fetched", async () => {
    h.jobs = [row({ job_url: "https://www.builtin.com/job/12345" })];
    h.resolved = { url: "https://clay.com/careers/1", precision: "posting" };

    await enrichRoles();

    expect(vi.mocked(resolveEmployerLink)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(fetchPage).mock.calls[0][0]).toBe("https://clay.com/careers/1");
  });

  test("an aggregator link that will not resolve is blocked, not read", async () => {
    h.jobs = [row({ job_url: "https://www.builtin.com/job/12345" })];
    h.resolved = null;

    const report = await enrichRoles();

    expect(vi.mocked(fetchPage)).not.toHaveBeenCalled();
    expect(report.blocked.map((b) => b.reason)).toEqual(["unresolved"]);
  });

  test("a relink is WRITTEN before the corrected URL is read", async () => {
    h.jobs = [row({ job_url: "https://jobs.ashbyhq.com/clay/old" })];
    h.verified = { kind: "relink", url: "https://jobs.ashbyhq.com/clay/new" };

    await enrichRoles();

    expect(patch()).toMatchObject({
      job_url: "https://jobs.ashbyhq.com/clay/new",
      source_url: "https://jobs.ashbyhq.com/clay/old",
    });
    expect(vi.mocked(fetchPage).mock.calls[0][0]).toBe("https://jobs.ashbyhq.com/clay/new");
    // Order, not just occurrence: enriching against a corrected URL that was
    // never stored would attach one posting's words to a row still pointing at
    // another.
    expect(vi.mocked(updateJob).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(fetchPage).mock.invocationCallOrder[0]
    );
  });

  test("a relink whose write failed aborts that row rather than enriching a URL nobody stored", async () => {
    h.jobs = [row({ job_url: "https://jobs.ashbyhq.com/clay/old" })];
    h.verified = { kind: "relink", url: "https://jobs.ashbyhq.com/clay/new" };
    h.updateError = "";

    const report = await enrichRoles();

    expect(vi.mocked(fetchPage)).not.toHaveBeenCalled();
    expect(report.failed).toBe(1);
  });

  test("a posting its own board says is gone is blocked", async () => {
    h.jobs = [row({ job_url: "https://jobs.ashbyhq.com/clay/old" })];
    h.verified = { kind: "absent", url: "https://jobs.ashbyhq.com/clay" };

    const report = await enrichRoles();

    expect(report.blocked.map((b) => b.reason)).toEqual(["absent"]);
    expect(vi.mocked(callStructured)).not.toHaveBeenCalled();
  });
});

describe("what it refuses to read at all", () => {
  test("robots.txt is consulted BEFORE the page is fetched", async () => {
    h.robotsAllows = false;

    const report = await enrichRoles();

    expect(vi.mocked(fetchAllowed)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(fetchPage)).not.toHaveBeenCalled();
    expect(report.unreadable).toBe(1);
  });

  // Never escalate to search: falling back to the web_search tier would turn a
  // free-tier backfill into a billed search across the whole table.
  test("a JS shell is skipped and never reaches a model call", async () => {
    h.page = "<html><body><div id='root'></div></body></html>";

    const report = await enrichRoles();

    expect(vi.mocked(callStructured)).not.toHaveBeenCalled();
    expect(report.unreadable).toBe(1);
  });

  test("a page that would not load is skipped, not guessed at", async () => {
    h.page = null;

    const report = await enrichRoles();

    expect(vi.mocked(callStructured)).not.toHaveBeenCalled();
    expect(report.unreadable).toBe(1);
  });
});

describe("the spend gates", () => {
  // A page guard is not coverage for a Server Action: it is an RPC endpoint
  // addressed by an ID that ships in the client bundle, so an un-onboarded
  // tenant could call this directly and bill against it.
  test("an un-onboarded tenant is refused before anything is spent", async () => {
    h.onboardedAt = null;

    const report = await enrichRoles();

    expect(vi.mocked(readOnboardedAtFor)).toHaveBeenCalledWith("t1");
    expect(report.error).toBeTruthy();
    expect(vi.mocked(withBudget)).not.toHaveBeenCalled();
    expect(vi.mocked(callStructured)).not.toHaveBeenCalled();
  });

  // withBudget reserves and checks the ceiling exactly ONCE per call, so a
  // whole-table pass inside one scope passes a single check at row 0 and then
  // bills regardless. The bound is the batch.
  test("a batch reserves once and stops at its limit, reporting the rest", async () => {
    h.jobs = ["a", "b", "c"].map((id) => row({ id }));

    const report = await enrichRoles({ limit: 2 });

    expect(vi.mocked(withBudget)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(callStructured)).toHaveBeenCalledTimes(2);
    expect(report.remaining).toBe(1);
    expect(report.cursor).toBe("b");
  });

  test("the next page starts after the cursor", async () => {
    h.jobs = ["a", "b", "c"].map((id) => row({ id }));

    const report = await enrichRoles({ limit: 2, cursor: "b" });

    expect(report.remaining).toBe(0);
    expect(vi.mocked(callStructured)).toHaveBeenCalledTimes(1);
  });
});

// Measured, not assumed: a real pass over 60 rows skipped 21 as JS shells, and
// Greenhouse and Ashby — whose posting PAGES are client-rendered while their
// board APIs answer honestly — were most of the remaining queue. This is the
// only way past a shell that costs no Claude tokens and issues no search.
describe("a client-rendered posting is read through the employer's board API", () => {
  const ATS = "https://job-boards.greenhouse.io/clay/jobs/4461450008";

  test("a shell falls back to the board body rather than being skipped", async () => {
    h.jobs = [row({ job_url: ATS })];
    h.page = "<html><body><div id='root'></div></body></html>";
    h.body = { text: "Requires 5 years of SQL. ".repeat(30), department: "Revenue Operations" };

    const report = await enrichRoles();

    expect(report.enriched).toBe(1);
    expect(report.unreadable).toBe(0);
    expect(vi.mocked(callStructured)).toHaveBeenCalledTimes(1);
  });

  test("the board's own department is stored when the posting page had none", async () => {
    h.jobs = [row({ job_url: ATS })];
    h.page = null;
    h.body = { text: "Requires 5 years of SQL. ".repeat(30), department: "Revenue Operations" };
    h.answer = JSON.stringify({ requirements: ["SQL"], nice_to_haves: [] });

    await enrichRoles();

    expect(patch().department).toBe("Revenue Operations");
  });

  // The fetch tier is still FIRST: the posting's own page is the fuller
  // document where it renders, and the board API is the fallback.
  test("a page that reads fine never asks the board", async () => {
    h.jobs = [row({ job_url: ATS })];

    await enrichRoles();

    expect(vi.mocked(fetchPostingBody)).not.toHaveBeenCalled();
  });

  test("a vendor with no verified body shape still counts as unreadable", async () => {
    h.jobs = [row({ job_url: "https://careers.example.com/jobs/1" })];
    h.page = "<html><body><div id='root'></div></body></html>";
    h.body = null;

    const report = await enrichRoles();

    expect(report.unreadable).toBe(1);
    expect(vi.mocked(callStructured)).not.toHaveBeenCalled();
  });
})
