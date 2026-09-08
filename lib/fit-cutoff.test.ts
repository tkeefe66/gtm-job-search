import { describe, expect, test } from "vitest";

import { MIN_KEPT_FIT_SCORE, autoFileStatus, shouldAutoFile } from "./fit-cutoff";
import { DEFAULT_STATUSES } from "./job-statuses";

// Measured, not assumed: across 194 scored roles, every 1 and 2 the user ever
// touched was marked Not Interested — ten for ten, none pursued past New. The
// cutoff acts on the score AFTER it is computed; the rubric is untouched,
// because telling the model to only ever answer 3-5 does not remove weak roles,
// it relabels them and destroys the signal the cutoff needs.
describe("which score is worth keeping", () => {
  test("3 is the bar", () => {
    expect(MIN_KEPT_FIT_SCORE).toBe(3);
  });

  test("a role at or above the bar is left alone", () => {
    for (const score of [3, 4, 5]) {
      expect(shouldAutoFile({ score, wasRead: true, status: "New" })).toBe(false);
    }
  });

  test("a role below the bar is filed away", () => {
    for (const score of [1, 2]) {
      expect(shouldAutoFile({ score, wasRead: true, status: "New" })).toBe(true);
    }
  });

  // The guard that makes this fair. A score computed WITHOUT the posting — the
  // extraction's one-line summary, or a row from before postings were readable
  // — is not evidence the role is weak. Those stay New and stay in the enrich
  // queue, and get their read before anything is decided about them.
  test("a role scored without its posting is never filed", () => {
    expect(shouldAutoFile({ score: 1, wasRead: false, status: "New" })).toBe(false);
  });

  // A row the user has moved is a row the user has an opinion about. A rescore
  // that fires while they are mid-conversation must not sweep it away.
  test("a role the user has already moved is never touched", () => {
    expect(shouldAutoFile({ score: 1, wasRead: true, status: "Applied" })).toBe(false);
  });

  test("a failed score (0) files nothing — that is a scoring failure, not a weak role", () => {
    expect(shouldAutoFile({ score: 0, wasRead: true, status: "New" })).toBe(false);
  });
});

// Statuses are USER-EDITABLE: the tenant may have renamed every label and
// removed the shipped ones. Writing a hardcoded "Not Interested" would store a
// key their config does not contain, which bucketFor cannot place.
describe("where a filed role goes", () => {
  test("the first terminal status in the user's own config", () => {
    expect(autoFileStatus(DEFAULT_STATUSES)).toBe("Not Interested");
  });

  test("a renamed status is still found — the KEY is what matters", () => {
    const renamed = DEFAULT_STATUSES.map((s) =>
      s.key === "Not Interested" ? { ...s, label: "Nope" } : s
    );

    expect(autoFileStatus(renamed)).toBe("Not Interested");
  });

  test("a hidden status is never a destination", () => {
    const hidden = DEFAULT_STATUSES.map((s) =>
      s.key === "Not Interested" ? { ...s, hidden: true } : s
    );

    expect(autoFileStatus(hidden)).toBe("Rejected");
  });

  // Posting Closed is terminal, but it is a CLAIM about the posting — that it
  // is gone — and a weak role's posting is alive. Filing there would be a lie
  // the link checker would then act on.
  test("Posting Closed is never the destination, however the config is ordered", () => {
    const closedFirst = [
      DEFAULT_STATUSES.find((s) => s.key === "Posting Closed")!,
      ...DEFAULT_STATUSES.filter((s) => s.key !== "Posting Closed"),
    ];

    expect(autoFileStatus(closedFirst)).toBe("Not Interested");
  });

  // No terminal status to file into is a real configuration: the user may have
  // deleted them all. Null means "leave it New" — never invent a key.
  test("a config with nowhere to file returns null rather than inventing a status", () => {
    expect(autoFileStatus(DEFAULT_STATUSES.filter((s) => s.bucket !== "terminal"))).toBeNull();
  });
});
