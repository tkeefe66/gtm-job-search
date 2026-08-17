import { describe, expect, test } from "vitest";
import { DEFAULT_CRITERIA, DEFAULT_FIT_BRAIN } from "./search-criteria";
import { buildSettingsView, settingsReadWarning } from "./settings-view";
import {
  COMP_SCORING_RESCORED_AT_KEY,
  CRITERIA_CHANGED_AT_KEY,
  JOB_STATUSES_KEY,
  PROFILE_KEY,
  UNDESCRIBED_DB_ERROR,
} from "./settings-store";
import { DEFAULT_STATUSES } from "./job-statuses";
import { DEFAULT_PROFILE } from "./profile";

const CLEAN = {
  rows: [] as { key: string; value: unknown }[],
  settingsError: undefined,
  scoredJobCount: 0,
  countError: undefined,
};

describe("buildSettingsView", () => {
  test("with no stored rows, the page shows the shipped defaults and no error", () => {
    const view = buildSettingsView({ ...CLEAN, scoredJobCount: 12 });
    expect(view.criteria).toEqual(DEFAULT_CRITERIA);
    expect(view.ceiling).toBeNull();
    expect(view.compFloor).toBeNull();
    expect(view.scoredJobCount).toBe(12);
    expect(view.fitBrainOverridden).toBe(false);
    expect(view.compScoringRescoredAt).toBeNull();
    expect(view.error).toBeUndefined();
  });

  test("the compensation-rescore stamp is read off the same snapshot", () => {
    // Off the rows the page already read, not by a query of its own: a second
    // snapshot is one a concurrent save could split the page across.
    const view = buildSettingsView({
      ...CLEAN,
      rows: [
        { key: "compFloor", value: 150000 },
        { key: COMP_SCORING_RESCORED_AT_KEY, value: "2026-08-14T00:00:00.000Z" },
      ],
    });
    expect(view.compScoringRescoredAt).toBe("2026-08-14T00:00:00.000Z");
    // …and it stayed out of the criteria handed to every prompt.
    expect(COMP_SCORING_RESCORED_AT_KEY in view.criteria).toBe(false);
  });

  test("the criteria stamp does not read as a compensation rescore", () => {
    // Two ISO strings in one table. Confusing them would let any
    // crawler-relevant edit permanently suppress the day-one rescore offer.
    const view = buildSettingsView({
      ...CLEAN,
      rows: [{ key: CRITERIA_CHANGED_AT_KEY, value: "2026-08-14T00:00:00.000Z" }],
    });
    expect(view.compScoringRescoredAt).toBeNull();
  });

  test("a failed settings read leaves the offer showing, not suppressed", () => {
    // rows is empty on a failed read, so the stamp reads as "never". The offer
    // showing costs a dismissal; suppressing it would lose the feature with
    // nothing on screen to explain why.
    const view = buildSettingsView({ ...CLEAN, settingsError: "connection terminated" });
    expect(view.compScoringRescoredAt).toBeNull();
  });

  test("stored rows override the defaults, and the ceiling is read off them", () => {
    const view = buildSettingsView({
      ...CLEAN,
      rows: [
        { key: "titles", value: ["Head of RevOps"] },
        { key: "searchCeiling", value: 15 },
      ],
    });
    expect(view.criteria.titles).toEqual(["Head of RevOps"]);
    expect(view.ceiling).toBe(15);
  });

  test("the comp floor is read off stored rows independently of the ceiling", () => {
    const view = buildSettingsView({
      ...CLEAN,
      rows: [
        { key: "searchCeiling", value: 15 },
        { key: "compFloor", value: 150000 },
      ],
    });
    expect(view.ceiling).toBe(15);
    expect(view.compFloor).toBe(150000);
  });

  test("a stored fit brain marks the rescore prompt's gate open", () => {
    const view = buildSettingsView({
      ...CLEAN,
      rows: [{ key: "fitBrain", value: "custom" }],
    });
    expect(view.fitBrainOverridden).toBe(true);
    expect(view.criteria.fitBrain).toBe("custom");
  });

  test("a FAILED settings read is surfaced, never rendered as 'no overrides'", () => {
    // The defect this input exists for. The two queries fail independently: a
    // transient failure on app_settings alone leaves the jobs count fine, so
    // nothing else on the page looks wrong. Without this, /settings renders
    // the DEFAULT fit brain with fitBrainOverridden: false, the user edits a
    // paragraph and saves, and their stored brain is replaced by
    // default-derived text. There is no history table.
    const view = buildSettingsView({
      ...CLEAN,
      settingsError: "connection terminated",
    });
    expect(view.error).toBeDefined();
    expect(view.error).toContain("connection terminated");
    // Still degraded to defaults — the WARNING is the whole fix, and it must
    // say the two things that make the page unsafe to save from.
    expect(view.criteria.fitBrain).toBe(DEFAULT_FIT_BRAIN);
    expect(view.error).toMatch(/default/i);
    expect(view.error).toMatch(/overwrite/i);
  });

  test("a failed count is still surfaced on its own", () => {
    const view = buildSettingsView({
      ...CLEAN,
      countError: "Could not count scored roles — timeout",
    });
    expect(view.error).toBe("Could not count scored roles — timeout");
  });

  test("both failures are reported, not just the first", () => {
    // They are separate queries. Hiding one behind the other loses a failure
    // the user needs: one says the page is unsafe to save from, the other says
    // the rescore cost figure is missing.
    const view = buildSettingsView({
      ...CLEAN,
      settingsError: "connection terminated",
      countError: "count timed out",
    });
    expect(view.error).toContain("connection terminated");
    expect(view.error).toContain("count timed out");
  });
});

describe("settingsReadWarning", () => {
  test("names the cause and both consequences", () => {
    const s = settingsReadWarning("connection terminated");
    expect(s).toContain("connection terminated");
    // "What you see is not yours" and "saving destroys what is stored".
    expect(s).toMatch(/not what you have saved/i);
    expect(s).toMatch(/overwrite/i);
  });

  test("still explains itself when the driver supplied no message", () => {
    const s = settingsReadWarning("");
    expect(s).toContain(UNDESCRIBED_DB_ERROR);
    expect(s).not.toContain("settings — .");
    expect(s).toMatch(/overwrite/i);
  });
});

describe("an undescribed read failure is still a read failure", () => {
  // pg with no DATABASE_URL rejects with an EMPTY message, so a truthiness
  // check drops the banner and the page renders the shipped defaults as the
  // user's saved values — the exact state the banner exists to stop them
  // saving over. Presence, not truthiness.
  test("an empty settingsError still raises the banner", () => {
    const view = buildSettingsView({ ...CLEAN, settingsError: "" });
    expect(view.error).toBeDefined();
    expect(view.error).toContain(UNDESCRIBED_DB_ERROR);
    expect(view.error).toMatch(/overwrite/i);
  });

  test("a described error still raises it, and no error still does not", () => {
    // Pins both sides of the branch, so "always raise the banner" is not a
    // passing implementation.
    expect(buildSettingsView({ ...CLEAN, settingsError: "boom" }).error).toContain("boom");
    expect(buildSettingsView({ ...CLEAN }).error).toBeUndefined();
  });
});

describe("statuses on the settings view", () => {
  test("falls back to the shipped defaults when no row is stored", () => {
    const view = buildSettingsView({ ...CLEAN });
    expect(view.statuses).toEqual(DEFAULT_STATUSES);
  });

  test("reads a stored config off the same snapshot as everything else", () => {
    const view = buildSettingsView({
      ...CLEAN,
      rows: [
        {
          key: JOB_STATUSES_KEY,
          value: [{ key: "Applied", label: "Submitted", bucket: "active", hidden: false }],
        },
      ],
    });
    expect(view.statuses.find((d) => d.key === "Applied")!.label).toBe("Submitted");
  });
});

describe("profile on the settings view", () => {
  test("the view carries the tenant's profile off the same snapshot", () => {
    const view = buildSettingsView({
      ...CLEAN,
      rows: [{ key: PROFILE_KEY, value: { searchSubject: "nursing" } }],
    });
    expect(view.profile.searchSubject).toBe("nursing");
  });

  test("a failed read shows the shipped profile, and the banner explains why", () => {
    const view = buildSettingsView({ ...CLEAN, settingsError: "" });
    expect(view.profile).toEqual(DEFAULT_PROFILE);
    expect(view.error).toBeTruthy();
  });
});
