import { describe, expect, test } from "vitest";

import { intakeIdentity, needsPaste, normalizeIntakeUrl } from "./manual-intake";

// Step 1 of the verifiable-sourcing spec: URL first, paste as the fallback.
// The URL is preferred over a pasted blob for one reason — IDENTITY. Pasted
// text carries no employer, no link and no posting id, so it cannot be deduped,
// re-checked for liveness, or attributed without the user typing it all.
describe("what a pasted URL has to be before anything is fetched", () => {
  test("whitespace and a trailing slash do not make two different roles", () => {
    expect(normalizeIntakeUrl("  https://x.com/jobs/1/  ")).toBe("https://x.com/jobs/1");
  });

  test("a bare host is accepted — some careers pages live at the root", () => {
    expect(normalizeIntakeUrl("https://x.com")).toBe("https://x.com");
  });

  test("a missing scheme is assumed https rather than refused", () => {
    expect(normalizeIntakeUrl("jobs.example.com/x")).toBe("https://jobs.example.com/x");
  });

  test("anything that is not a URL at all is refused", () => {
    expect(normalizeIntakeUrl("")).toBeNull();
    expect(normalizeIntakeUrl("paste the job description here")).toBeNull();
    expect(normalizeIntakeUrl("mailto:someone@example.com")).toBeNull();
  });
});

describe("who the role is, once the page has been read", () => {
  test("the posting's own identity wins over nothing", () => {
    expect(
      intakeIdentity({ title: "Director, RevOps", employer: "Baseten" }, {})
    ).toEqual({ company: "Baseten", roleTitle: "Director, RevOps", complete: true });
  });

  // The user is the authority when they bothered to type it: they can see the
  // page, and structured data is regularly stale or generic.
  test("what the user typed wins over the page", () => {
    expect(
      intakeIdentity(
        { title: "Director, RevOps", employer: "Baseten" },
        { company: "Baseten Inc", roleTitle: "Director of Revenue Operations" }
      )
    ).toEqual({
      company: "Baseten Inc",
      roleTitle: "Director of Revenue Operations",
      complete: true,
    });
  });

  // A row with no company or no title cannot be deduped, scored or displayed
  // sensibly, so intake must ASK rather than invent one from the URL.
  test("a page that names neither is incomplete, not guessed at", () => {
    expect(intakeIdentity({ title: "", employer: "" }, {})).toMatchObject({
      complete: false,
    });
  });

  test("one of the two missing is still incomplete", () => {
    expect(intakeIdentity({ title: "RevOps Lead", employer: "" }, {})).toMatchObject({
      complete: false,
    });
  });
});

// The paste box appears only when the read failed, and it must say WHY —
// "this site blocks automated readers" is actionable, a silent empty box is not.
describe("when the paste fallback is offered", () => {
  test("a page that could not be read offers it", () => {
    expect(needsPaste({ kind: "unreadable" })).toBe(true);
  });

  test("a model failure offers it too — the text was there, the call was not", () => {
    expect(needsPaste({ kind: "failed", message: "overloaded" })).toBe(true);
  });

  test("a read that found nothing usable offers it", () => {
    expect(needsPaste({ kind: "read", empty: true })).toBe(true);
  });

  test("a successful read does not", () => {
    expect(needsPaste({ kind: "read", empty: false })).toBe(false);
  });
});
