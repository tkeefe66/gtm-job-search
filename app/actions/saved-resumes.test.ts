// app/actions/saved-resumes.test.ts
//
// Pins what app/actions/auth-required.test.ts structurally cannot: a
// SESSION-HOLDING but non-admin actor must still be refused. Exact mirror of
// app/actions/resume.test.ts.
import { describe, expect, test, vi } from "vitest";

vi.mock("@/lib/require-actor", () => ({
  requireActor: async () => ({
    userId: "u1",
    tenantId: "u1",
    email: "someone@example.com",
    isAdmin: false,
  }),
}));

import {
  saveResume,
  listSavedResumes,
  getSavedResume,
  deleteSavedResume,
  deleteSavedResumes,
  getDownloadAssets,
} from "./saved-resumes";

const ID = "11111111-1111-1111-1111-111111111111";

describe("saved-resumes.ts refuses a non-admin actor", () => {
  test("saveResume", async () => {
    await expect(
      saveResume({ jobId: ID, html: "<div class=\"rsm\"></div>", roleTitle: "t", company: "c" })
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
