import { describe, expect, test } from "vitest";
import { DEFAULT_CRITERIA, DEFAULT_FIT_BRAIN } from "./search-criteria";
import { buildSettingsView, settingsReadWarning } from "./settings-view";
import { UNDESCRIBED_DB_ERROR } from "./settings-store";

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
    expect(view.error).toBeUndefined();
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
