import { describe, expect, test } from "vitest";

import { relinkPatch } from "./relink";

// The first-relink-only rule, in ONE place. It had two identical copies inside
// app/actions/link-health.ts and the backfill would have made a third — the
// drift hazard CLAUDE.md records for compFloor's `>` vs `>=`, where two copies
// of one comparison disagreed and produced a role the table hid while its
// score still read 4.
describe("a relink is never lossy", () => {
  test("the first relink keeps the link it replaced", () => {
    expect(relinkPatch({ source_url: null }, "https://old", "https://new")).toEqual({
      job_url: "https://new",
      source_url: "https://old",
    });
  });

  test("a re-run does NOT overwrite the original with the previous resolution", () => {
    expect(
      relinkPatch({ source_url: "https://original" }, "https://guessed", "https://new")
    ).toEqual({ job_url: "https://new", source_url: "https://original" });
  });
});
