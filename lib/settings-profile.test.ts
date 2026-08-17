import { describe, expect, test } from "vitest";
import {
  ONBOARDED_AT_KEY,
  PROFILE_KEY,
  SETTING_KEYS,
  onboardedAtFrom,
  profileFrom,
  type SettingRow,
} from "./settings-store";
import { DEFAULT_PROFILE } from "./profile";

describe("the profile keys are STANDALONE", () => {
  test("neither is a member of SETTING_KEYS", () => {
    const values: string[] = Object.values(SETTING_KEYS);
    expect(values).not.toContain(PROFILE_KEY);
    expect(values).not.toContain(ONBOARDED_AT_KEY);
  });

  test("their spellings are pinned — a drift makes every write a silent no-op", () => {
    expect(PROFILE_KEY).toBe("profile");
    expect(ONBOARDED_AT_KEY).toBe("onboarded_at");
  });
});

describe("profileFrom", () => {
  test("no row reads as the shipped profile", () => {
    expect(profileFrom([])).toEqual(DEFAULT_PROFILE);
  });

  test("reads and repairs the stored row", () => {
    const rows: SettingRow[] = [
      { key: PROFILE_KEY, value: { searchSubject: "nursing", querySubject: 5 } },
    ];
    const p = profileFrom(rows);
    expect(p.searchSubject).toBe("nursing");
    expect(p.querySubject).toBe(DEFAULT_PROFILE.querySubject);
  });

  test("ignores every other row", () => {
    const rows: SettingRow[] = [
      { key: SETTING_KEYS.fitBrain, value: "a stored brain" },
      { key: PROFILE_KEY, value: { fitBrain: "the profile's brain" } },
    ];
    expect(profileFrom(rows).fitBrain).toBe("the profile's brain");
  });
});

describe("onboardedAtFrom", () => {
  test("null when the stamp has never been written", () => {
    expect(onboardedAtFrom([])).toBeNull();
  });

  test("reads the stored ISO string", () => {
    expect(
      onboardedAtFrom([{ key: ONBOARDED_AT_KEY, value: "2026-08-17T00:00:00.000Z" }])
    ).toBe("2026-08-17T00:00:00.000Z");
  });

  test("a non-string reads as NEVER, so the gate fails toward onboarding", () => {
    // The safe direction: a hand-edited row that cannot be interpreted sends
    // the user through onboarding again, rather than letting them past the
    // gate with no criteria at all.
    expect(onboardedAtFrom([{ key: ONBOARDED_AT_KEY, value: 1 }])).toBeNull();
    expect(onboardedAtFrom([{ key: ONBOARDED_AT_KEY, value: true }])).toBeNull();
  });
});
