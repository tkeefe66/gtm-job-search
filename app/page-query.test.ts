import React from "react";
import { beforeAll, expect, test, vi } from "vitest";

vi.mock("@/auth", () => ({ auth: vi.fn(async () => null), signIn: vi.fn() }));
vi.mock("@/lib/require-actor", () => ({ requireActorPage: vi.fn(async () => ({ isAdmin: true })) }));
vi.mock("@/lib/settings-store", () => ({ readCompFloor: vi.fn(async () => null) }));
vi.mock("@/app/actions/resume", () => ({ getJobContext: vi.fn(), loadResumeContext: vi.fn() }));
vi.mock("@/app/actions/saved-resumes", () => ({ listSavedResumes: vi.fn(async () => ({ resumes: [] })) }));
vi.mock("@/components/SignupIntro", () => ({ default: () => null }));
vi.mock("@/components/RolesTable", () => ({ default: () => null }));
vi.mock("@/components/Discover", () => ({ default: () => null }));
vi.mock("@/components/resume/TailorPanel", () => ({ default: () => null }));
vi.mock("@/components/resume/SavedResumeList", () => ({ default: () => null }));
vi.mock("@/components/resume/SavedResumeScreen", () => ({ default: () => null }));
beforeAll(() => { vi.stubGlobal("React", React); });

// Mutation: read Promise searchParams synchronously and silently render signup.
test("sign-in reads login mode from asynchronous search params", async () => {
  const { default: Page } = await import("./signin/page");
  const result = await Page({ searchParams: Promise.resolve({ mode: "login" }) } as never);
  expect(result.props.returning).toBe(true);
});
// Mutation: synchronous access loses the manual-add deep link.
test("roles opens manual intake from asynchronous search params", async () => {
  const { default: Page } = await import("./roles/page");
  const result = await Page({ searchParams: Promise.resolve({ add: "1" }) } as never);
  expect(result.props.initialAddOpen).toBe(true);
});
// Mutation: synchronous access sends role-search deep link to company search.
test("discover selects role mode from asynchronous search params", async () => {
  const { default: Page } = await import("./discover/page");
  const result = await Page({ searchParams: Promise.resolve({ mode: "role" }) } as never);
  expect(result.props.initialMode).toBe("role");
});
// Mutation: synchronous access loses saved document selection and renders archive.
test("resume preserves saved-document precedence with asynchronous search params", async () => {
  const { default: Page } = await import("./resume/page");
  const result = await Page({ searchParams: Promise.resolve({ savedId: "saved-example", jobId: "job-example" }) } as never);
  expect(result.props.id).toBe("saved-example");
});
