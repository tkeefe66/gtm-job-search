import { beforeEach, describe, expect, test, vi } from "vitest";

const h = vi.hoisted(() => ({
  onboardedAt: "2026-08-18T01:58:02Z" as string | null,
  read: { kind: "unreadable" } as Record<string, unknown>,
  ingest: { added: [{}], skipped: [], seenTitles: [] } as Record<string, unknown>,
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
}));
vi.mock("@/lib/ingest-roles", () => ({ ingestRoles: vi.fn(async () => h.ingest) }));
vi.mock("@/lib/search-criteria", () => ({
  loadCriteriaAndScoringInputs: async () => ({ fitInputs: {} }),
}));

import { addRoleFromUrl } from "./add-role";
import { ingestRoles } from "@/lib/ingest-roles";
import { readPosting, readPostingText } from "@/lib/posting-read";

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
