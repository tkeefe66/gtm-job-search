// app/actions/resume.test.ts
//
// Pins the one invariant auth-required.test.ts's blanket session-less-call
// check cannot catch on its own: a SESSION-HOLDING but non-admin actor must
// still be refused. Mirrors the shape lib/auth-policy.test.ts uses for this
// app's other auth invariants.
import { describe, expect, test, vi } from "vitest";

vi.mock("@/lib/require-actor", () => ({
  requireActor: async () => ({
    userId: "u1",
    tenantId: "u1",
    email: "someone@example.com",
    isAdmin: false,
  }),
}));

import { getJobContext, getTailoredResume, tailorResumeForJob } from "./resume";

describe("resume.ts refuses a non-admin actor", () => {
  test("tailorResumeForJob", async () => {
    await expect(tailorResumeForJob("11111111-1111-1111-1111-111111111111")).rejects.toThrow(
      /Not authorized/
    );
  });

  test("getTailoredResume", async () => {
    await expect(getTailoredResume("11111111-1111-1111-1111-111111111111")).rejects.toThrow(
      /Not authorized/
    );
  });

  test("getJobContext", async () => {
    await expect(getJobContext("11111111-1111-1111-1111-111111111111")).rejects.toThrow(
      /Not authorized/
    );
  });
});
