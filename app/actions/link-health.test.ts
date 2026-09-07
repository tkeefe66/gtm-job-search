import { beforeEach, describe, expect, test, vi } from "vitest";
import type { Job } from "@/lib/types";

// repairOne's ATS branch is the only new code in this change that WRITES to the
// database, so it gets the mock-the-edges treatment app/actions/jobs.test.ts
// established rather than being left to the lib-level tests. Everything this
// action reaches out to is replaced; what is left is the decision.

vi.mock("@/lib/require-actor", () => ({
  requireActor: async () => ({
    userId: "test-user",
    tenantId: "test-user",
    email: "test@example.com",
    isAdmin: false,
  }),
}));
vi.mock("@/lib/tenant", () => ({
  resolveTenantId: async () => "00000000-0000-0000-0000-000000000001",
}));

const h = vi.hoisted(() => ({
  jobs: [] as unknown[],
  verified: { kind: "notApplicable" } as Record<string, unknown>,
  /** What updateJob returns. `""` is the unreachable-database shape. */
  updateError: undefined as string | undefined,
  urlStatus: "live" as "live" | "dead" | "unknown",
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
  getJobStatuses: async () => ({
    statuses: [
      { key: "New", label: "New", bucket: "open" },
      { key: "Posting Closed", label: "Posting Closed", bucket: "terminal" },
    ],
    error: undefined,
  }),
}));
vi.mock("@/lib/verify-url", () => ({ checkJobUrl: vi.fn(async () => h.urlStatus) }));
vi.mock("@/lib/resolve-job-link", () => ({
  resolveEmployerLink: vi.fn(async () => null),
  verifyPostingLink: vi.fn(async () => h.verified),
  newBoardCache: () => new Map(),
}));

import { repairJobLinks } from "./link-health";
import { updateJob } from "@/app/actions/jobs";
import { checkJobUrl } from "@/lib/verify-url";
import { UNDESCRIBED_DB_ERROR } from "@/lib/write-failure";

const STALE = "https://jobs.ashbyhq.com/baseten/b621b620-85eb-4f73-8d77-e4ebd458b02d";
const LIVE = "https://jobs.ashbyhq.com/baseten/5cd2f489-b9ee-428b-b252-94e83d55f107";

const job = (over: Partial<Job> = {}): Job =>
  ({
    id: "job-1",
    company: "Baseten",
    role_title: "GTM Engineer",
    status: "New",
    job_url: STALE,
    source_url: null,
    ...over,
  }) as unknown as Job;

/** The payload of the only updateJob call this pass made. */
const written = () => vi.mocked(updateJob).mock.calls[0][1];

beforeEach(() => {
  h.jobs = [job()];
  h.verified = { kind: "notApplicable" };
  h.updateError = undefined;
  h.urlStatus = "live";
  vi.clearAllMocks();
});

describe("an ATS deep link whose posting id is stale", () => {
  // Mutation this catches: writing job_url alone. The slug here was READ rather
  // than guessed, which makes it tempting to skip the safety net — but a relink
  // still overwrites the only URL this role ever had, and source_url is the only
  // record of where it came from.
  test("a relink writes the board's URL and keeps the original as source_url", async () => {
    h.verified = { kind: "relink", vendor: "ashby", slug: "baseten", url: LIVE };

    const report = await repairJobLinks();

    expect(written()).toEqual({ job_url: LIVE, source_url: STALE });
    expect(report.relinked).toBe(1);
  });

  // Mutation this catches: `source_url: url` instead of `job.source_url ?? url`.
  // On a re-run that overwrites the FIRST link with the previous resolution, and
  // the original is gone for good.
  test("a re-run does not overwrite an existing source_url", async () => {
    h.jobs = [job({ source_url: "https://www.builtin.com/job/12345" })];
    h.verified = { kind: "relink", vendor: "ashby", slug: "baseten", url: LIVE };

    await repairJobLinks();

    expect(written()).toEqual({
      job_url: LIVE,
      source_url: "https://www.builtin.com/job/12345",
    });
  });

  // Mutation this catches: `if (failure)` instead of `failure !== undefined`.
  // lib/write-failure.ts records that `pg` rejects with an AggregateError whose
  // message is "" when a dual-stack host refuses on every address — exactly what
  // an unreachable DATABASE_URL produces. Truthiness reads that as success, and
  // the pass reports a relink that never landed.
  test("a write failure with an EMPTY message is not counted as a relink", async () => {
    h.verified = { kind: "relink", vendor: "ashby", slug: "baseten", url: LIVE };
    h.updateError = "";
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    const report = await repairJobLinks();

    expect(report.relinked).toBe(0);
    expect(logged.mock.calls[0][0]).toContain(UNDESCRIBED_DB_ERROR);
    logged.mockRestore();
  });

  // Mutation this catches: setting liveUrl before checking the write result, or
  // outside the success branch. The row still points at the stale URL, so that
  // is the URL whose liveness decides whether it gets closed.
  test("a failed write leaves the STALE url as the one checked for liveness", async () => {
    h.verified = { kind: "relink", vendor: "ashby", slug: "baseten", url: LIVE };
    h.updateError = "";
    vi.spyOn(console, "error").mockImplementation(() => {});

    await repairJobLinks();

    expect(vi.mocked(checkJobUrl)).toHaveBeenCalledWith(STALE);
  });

  // Mutation this catches: checking `url` rather than `liveUrl` after a relink.
  // The stale Ashby link answers HTTP 200 and paints "Job not found", so this is
  // not academic — the point of the repair is that the NEW link is what gets
  // tested, and a pass that re-tests the old one has verified nothing.
  test("after a relink it is the NEW url that is liveness-checked", async () => {
    h.verified = { kind: "relink", vendor: "ashby", slug: "baseten", url: LIVE };

    await repairJobLinks();

    expect(vi.mocked(checkJobUrl)).toHaveBeenCalledWith(LIVE);
  });

  // Mutation this catches: closing the role on `absent`. It IS strong evidence —
  // the slug was read, not guessed — but closing also marks a role never-live and
  // hides it, and ingestRoles' dedupe means a hidden role never comes back.
  // Widening what closes roles is a separate decision from repairing a link.
  test("absent, unreachable, listed and notApplicable write nothing", async () => {
    for (const verified of [
      { kind: "absent", vendor: "ashby", slug: "baseten", url: "https://jobs.ashbyhq.com/baseten" },
      { kind: "unreachable", vendor: "ashby", slug: "baseten" },
      { kind: "listed", vendor: "ashby", slug: "baseten" },
      { kind: "notApplicable" },
    ]) {
      vi.clearAllMocks();
      h.verified = verified;

      const report = await repairJobLinks();

      expect(vi.mocked(updateJob)).not.toHaveBeenCalled();
      expect(report.relinked).toBe(0);
      expect(report.closed).toBe(0);
      expect(report.closedUnlisted).toBe(0);
      expect(report.unclear).toEqual([]);
    }
  });

  // Mutation this catches: inventing a fourth UnclearReason for this path, or
  // pointing the row at the stored link instead of the board page. The report's
  // existing `empty` copy tells the user to check the company's real careers
  // page, which is only actionable if the row links to the board.
  test("an unclear outcome is reported with the existing reason and the board page", async () => {
    h.verified = {
      kind: "unclear",
      vendor: "ashby",
      slug: "baseten",
      url: "https://jobs.ashbyhq.com/baseten",
      reason: "empty",
    };

    const report = await repairJobLinks();

    expect(vi.mocked(updateJob)).not.toHaveBeenCalled();
    expect(report.unclear).toEqual([
      {
        id: "job-1",
        company: "Baseten",
        role_title: "GTM Engineer",
        url: "https://jobs.ashbyhq.com/baseten",
        reason: "empty",
      },
    ]);
  });
});

describe("the ATS branch does not disturb the paths around it", () => {
  // Mutation this catches: routing aggregator links into the new branch, which
  // would delete the guessed-slug lookup that is the only thing repairing a
  // reseller link.
  test("an aggregator link never reaches the posting verifier", async () => {
    h.jobs = [job({ job_url: "https://www.builtin.com/job/12345" })];
    const { verifyPostingLink } = await import("@/lib/resolve-job-link");

    await repairJobLinks();

    expect(vi.mocked(verifyPostingLink)).not.toHaveBeenCalled();
  });

  // Mutation this catches: letting the ATS branch's early exits skip the 404
  // check below it. That check predates this change and closes roles on the one
  // definitive signal there is.
  test("a definitive 404 still closes the role after the ATS branch", async () => {
    h.verified = { kind: "listed", vendor: "ashby", slug: "baseten" };
    h.urlStatus = "dead";

    const report = await repairJobLinks();

    expect(written()).toEqual({ status: "Posting Closed" });
    expect(report.closed).toBe(1);
  });
});
