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

  // `absent` USED to be listed here, on the stated grounds that "closing also
  // marks a role never-live and hides it". That reason was false and was
  // checked before this changed: repairOne writes `{ status: "Posting Closed" }`
  // and nothing else, `never_live` is set only by ingest, and partitionNeverLive
  // hides on never_live rather than on status — so a role closed here stays
  // visible under the Out filter and can be moved back. See the describe below
  // for what replaced it, and why the evidence justifies acting.
  test("unreachable, listed and notApplicable write nothing", async () => {
    for (const verified of [
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
      expect(report.closedAbsent).toBe(0);
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

// The evidence that changed this, gathered 2026-09-07 against production rows:
// four Greenhouse postings sampled, all four answering 404 from the board API
// for their own posting id while the posting PAGE answered 302 to the board
// root. ~18 rows were in that state, sitting as New indefinitely, because
// checkJobUrl follows the redirect, gets a 200, and calls the link live.
//
// The distinction that makes this safe is one this codebase already draws: the
// slug here is READ out of the stored URL, so the board being asked is
// certainly the employer's. resolveEmployerLink GUESSES a slug from a company
// name, and a wrong guess there could close a live role against a stranger's
// board — which is why that path's absent has always been treated separately.
describe("a posting its own board no longer carries is closed", () => {
  const ABSENT = {
    kind: "absent",
    vendor: "ashby",
    slug: "baseten",
    url: "https://jobs.ashbyhq.com/baseten",
  };

  test("the role is closed and counted under its own reason", async () => {
    h.verified = ABSENT;

    const report = await repairJobLinks();

    expect(written()).toEqual({ status: "Posting Closed" });
    expect(report.closedAbsent).toBe(1);
  });

  // never_live is ingest-time PROVENANCE — "this was already dead the first
  // time we saw it" — and it HIDES the row from /roles and both tiles. A role
  // that was live when found and has since closed is a different fact, and
  // hiding it would also make it unreachable: ingestRoles' dedupe reads every
  // row regardless of status, so a hidden row never comes back.
  test("it is never marked never_live, so it stays visible under Out", async () => {
    h.verified = ABSENT;

    await repairJobLinks();

    expect(written()).not.toHaveProperty("never_live");
  });

  test("a failed write leaves the row open rather than reporting a close", async () => {
    h.verified = ABSENT;
    h.updateError = ""; // the unreachable-database shape: presence, not truthiness

    const report = await repairJobLinks();

    expect(report.closedAbsent).toBe(0);
  });

  // One close, not two. The 404 check at the end of repairOne would otherwise
  // write the same status again for a row this branch already closed.
  test("a row closed here is not written a second time by the 404 check", async () => {
    h.verified = ABSENT;
    h.urlStatus = "dead";

    const report = await repairJobLinks();

    expect(vi.mocked(updateJob)).toHaveBeenCalledTimes(1);
    expect(report.closed).toBe(0);
    expect(report.closedAbsent).toBe(1);
  });

  // The guessed-slug path keeps its own counter. Two boards found two different
  // ways are two different strengths of evidence, and folding them into one
  // number would hide that.
  test("the guessed-slug close still reports separately", async () => {
    h.verified = { kind: "notApplicable" };

    const report = await repairJobLinks();

    expect(report.closedAbsent).toBe(0);
  });
});
