// Grouping and the expiry countdown are the archive screen's only pure logic,
// and both are the kind that passes vacuously: a wrong key silently merges two
// roles under one heading, and a wrong rounding tells someone their résumé
// expires a day before it does.
import { describe, expect, test } from "vitest";
import { groupResumes, daysUntil } from "./saved-resume-grouping";
import type { SavedResumeSummary } from "@/lib/types";

function row(over: Partial<SavedResumeSummary>): SavedResumeSummary {
  return {
    id: "id",
    jobId: null,
    roleTitle: "VP Sales",
    company: "Acme",
    label: null,
    createdAt: "2026-09-01T00:00:00.000Z",
    expiresAt: "2026-10-31T00:00:00.000Z",
    pageMargin: null,
    ...over,
  };
}

describe("groupResumes", () => {
  test("groups rows sharing a job, keeping list order", () => {
    const groups = groupResumes([row({ id: "a", jobId: "j1" }), row({ id: "b", jobId: "j1" })]);
    expect(groups.length).toBe(1);
    expect(groups[0].items.map((r) => r.id)).toEqual(["a", "b"]);
  });

  test("keeps two different jobs apart even when the role and company match", () => {
    const groups = groupResumes([row({ id: "a", jobId: "j1" }), row({ id: "b", jobId: "j2" })]);
    expect(groups.length).toBe(2);
  });

  test("falls back to role+company for rows whose job was deleted", () => {
    const groups = groupResumes([row({ id: "a", jobId: null }), row({ id: "b", jobId: null })]);
    expect(groups.length).toBe(1);
    expect(groups[0].jobId).toBe(null);
  });

  test("a deleted-job row does NOT merge into the live job's group", () => {
    const groups = groupResumes([row({ id: "a", jobId: "j1" }), row({ id: "b", jobId: null })]);
    expect(groups.length).toBe(2);
  });

  test("different companies never share a group", () => {
    const groups = groupResumes([
      row({ id: "a", company: "Acme" }),
      row({ id: "b", company: "Globex" }),
    ]);
    expect(groups.length).toBe(2);
  });
});

describe("daysUntil", () => {
  const now = new Date("2026-09-07T12:00:00.000Z").getTime();

  test("rounds up, so a partial day is never reported as fewer days", () => {
    expect(daysUntil("2026-09-08T18:00:00.000Z", now)).toBe(2);
  });

  test("an exact day boundary is that many days", () => {
    expect(daysUntil("2026-09-09T12:00:00.000Z", now)).toBe(2);
  });

  test("an already-expired row is 0, never negative", () => {
    expect(daysUntil("2026-09-01T12:00:00.000Z", now)).toBe(0);
  });
});
