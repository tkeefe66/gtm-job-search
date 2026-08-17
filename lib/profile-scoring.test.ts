import { describe, expect, test } from "vitest";
import { DEFAULT_CRITERIA, scoringInputsFrom } from "./search-criteria";
import { PROFILE_KEY, SETTING_KEYS, type SettingRow } from "./settings-store";
import { DEFAULT_PROFILE } from "./profile";
import { buildFitPrompt } from "./fit-prompt";
import { FIXTURE_ROLE } from "./__fixtures__/fit-prompt-inputs";

describe("scoringInputsFrom, sourced from the profile", () => {
  test("with no profile row it reproduces the shipped scoring text", () => {
    const inputs = scoringInputsFrom(DEFAULT_CRITERIA, []);
    expect(inputs.weakFitTail).toBe(DEFAULT_PROFILE.weakFitTail);
    expect(inputs.moderateTail).toBe(DEFAULT_PROFILE.moderateTail);
    expect(inputs.strongTail).toBe(DEFAULT_PROFILE.strongTail);
    expect(inputs.titleScope).toBe(DEFAULT_PROFILE.titleScope);
    expect(inputs.domainBonus).toBe(DEFAULT_PROFILE.domainBonus);
  });

  test("A STORED PROFILE REACHES THE RENDERED FIT PROMPT", () => {
    // This is phase 2's guard, end to end and in one assertion: a value stored
    // by onboarding must come out the other side of buildFitPrompt. A site
    // that kept passing the GTM constant would compile, type-check, pass every
    // fixture (they ARE the constants) and ship GTM text to a nurse. Only a
    // CHANGED value can tell the two apart.
    //
    // Criteria's fitBrain is forced empty here: DEFAULT_CRITERIA.fitBrain is
    // still the previous user's résumé at this task (a later task empties
    // it), and the criteria row wins over the profile's brain (see Ruling 1
    // in the SDD ledger — the row is what /settings edits, so it must not be
    // permanently shadowed by a non-empty profile brain). An empty criteria
    // brain is the post-onboarding-gate world a later task creates; with
    // today's non-empty default the row would correctly win instead, and this
    // test would not be exercising the profile fallback at all.
    const rows: SettingRow[] = [
      {
        key: PROFILE_KEY,
        value: {
          fitBrain: "SYNTHETIC BRAIN",
          weakFitTail: "SYNTHETIC WEAK",
          moderateTail: "SYNTHETIC MODERATE",
          strongTail: "SYNTHETIC STRONG",
          titleScope: "- SYNTHETIC SCOPE",
          domainBonus: "SYNTHETIC BONUS",
        },
      },
      { key: SETTING_KEYS.compFloor, value: 180000 },
    ];
    const inputs = scoringInputsFrom({ ...DEFAULT_CRITERIA, fitBrain: "" }, rows);
    const prompt = buildFitPrompt(FIXTURE_ROLE, inputs);

    expect(prompt).toContain("SYNTHETIC BRAIN");
    expect(prompt).toContain("SYNTHETIC WEAK");
    expect(prompt).toContain("SYNTHETIC MODERATE");
    expect(prompt).toContain("SYNTHETIC STRONG");
    expect(prompt).toContain("- SYNTHETIC SCOPE");
    expect(prompt).toContain("SYNTHETIC BONUS");

    expect(prompt).not.toContain(DEFAULT_PROFILE.weakFitTail);
    expect(prompt).not.toContain(DEFAULT_PROFILE.moderateTail);
    expect(prompt).not.toContain(DEFAULT_PROFILE.strongTail);
    expect(prompt).not.toContain(DEFAULT_PROFILE.titleScope);
    expect(prompt).not.toContain(DEFAULT_PROFILE.domainBonus);
    // The floor is NOT a profile field and still rides in off its own row.
    expect(prompt).toContain("$180,000");
  });

  test("the criteria row wins over the profile's brain — /settings must not be shadowed", () => {
    // The row is what /settings shows and edits. If the profile won, a user's
    // settings edit would be silently ignored for as long as their profile held
    // any brain at all. See Ruling 1 in the SDD ledger.
    const rows: SettingRow[] = [{ key: PROFILE_KEY, value: { fitBrain: "FROM THE PROFILE" } }];
    expect(
      scoringInputsFrom({ ...DEFAULT_CRITERIA, fitBrain: "EDITED ON SETTINGS" }, rows).fitBrain
    ).toBe("EDITED ON SETTINGS");
  });

  test("an empty criteria row falls back to the profile's brain, not to a career", () => {
    const rows: SettingRow[] = [{ key: PROFILE_KEY, value: { fitBrain: "FROM THE PROFILE" } }];
    expect(scoringInputsFrom({ ...DEFAULT_CRITERIA, fitBrain: "" }, rows).fitBrain).toBe(
      "FROM THE PROFILE"
    );
  });
});
