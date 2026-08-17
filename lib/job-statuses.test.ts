import { describe, expect, it } from "vitest";
import { ACTIVE_STATUSES, JOB_STATUSES, TERMINAL_STATUSES } from "./types";
import {
  DEFAULT_STATUSES,
  SYSTEM_STATUS_KEYS,
  bucketFor,
  compareByConfig,
  labelFor,
  optionsFor,
  resolveStatuses,
  slugify,
  terminalKeys,
  tileCounts,
  type JobStatusDef,
} from "./job-statuses";

const keys = (defs: JobStatusDef[]) => defs.map((d) => d.key);

describe("DEFAULT_STATUSES", () => {
  // Test 7 from the spec. Pinned against lib/types.ts rather than a hand-copied
  // list, so the shipped config is provably a no-op. Task 8 deletes those arrays
  // and this assertion with them — read the note in Task 8 before doing that.
  it("reproduces today's list, order, and buckets exactly", () => {
    expect(keys(DEFAULT_STATUSES)).toEqual(JOB_STATUSES);
    expect(terminalKeys(DEFAULT_STATUSES).sort()).toEqual([...TERMINAL_STATUSES].sort());
    const active = DEFAULT_STATUSES.filter((d) => d.bucket === "active").map((d) => d.key);
    expect(active.sort()).toEqual([...ACTIVE_STATUSES, "New", "Offer"].sort());
  });

  it("labels every status as its own key", () => {
    for (const d of DEFAULT_STATUSES) expect(d.label).toBe(d.key);
  });

  it("marks exactly the three system statuses", () => {
    const system = DEFAULT_STATUSES.filter((d) => d.system).map((d) => d.key);
    expect(system.sort()).toEqual([...SYSTEM_STATUS_KEYS].sort());
  });
});

describe("resolveStatuses", () => {
  it("returns the defaults for a malformed or absent value", () => {
    expect(resolveStatuses(null)).toEqual(DEFAULT_STATUSES);
    expect(resolveStatuses("nonsense")).toEqual(DEFAULT_STATUSES);
    expect(resolveStatuses([])).toEqual(DEFAULT_STATUSES);
    expect(resolveStatuses([{ nope: 1 }])).toEqual(DEFAULT_STATUSES);
  });

  it("re-appends a system key the saved config omits", () => {
    const saved = [{ key: "Offer", label: "Offer", bucket: "active", hidden: false }];
    expect(keys(resolveStatuses(saved))).toEqual(
      expect.arrayContaining(["New", "Applied", "Posting Closed"])
    );
  });

  it("always resolves New", () => {
    expect(keys(resolveStatuses([]))).toContain("New");
    expect(keys(resolveStatuses([{ key: "x", label: "X", bucket: "active", hidden: false }])))
      .toContain("New");
  });

  it("collapses duplicate keys, first wins", () => {
    const saved = [
      { key: "Offer", label: "Won", bucket: "active", hidden: false },
      { key: "Offer", label: "Lost", bucket: "terminal", hidden: false },
    ];
    const out = resolveStatuses(saved).filter((d) => d.key === "Offer");
    expect(out).toHaveLength(1);
    expect(out[0].label).toBe("Won");
  });

  it("repairs an unknown bucket to active and an empty label to the key", () => {
    const saved = [{ key: "Offer", label: "  ", bucket: "sideways", hidden: false }];
    const offer = resolveStatuses(saved).find((d) => d.key === "Offer")!;
    expect(offer.bucket).toBe("active");
    expect(offer.label).toBe("Offer");
  });

  it("refuses to let New be terminal or Posting Closed be active", () => {
    const saved = [
      { key: "New", label: "New", bucket: "terminal", hidden: false },
      { key: "Posting Closed", label: "Closed", bucket: "active", hidden: false },
    ];
    const out = resolveStatuses(saved);
    expect(out.find((d) => d.key === "New")!.bucket).toBe("active");
    expect(out.find((d) => d.key === "Posting Closed")!.bucket).toBe("terminal");
  });

  it("refuses to hide a system status", () => {
    const saved = SYSTEM_STATUS_KEYS.map((k) => ({
      key: k, label: k, bucket: "active", hidden: true,
    }));
    for (const d of resolveStatuses(saved)) {
      if (d.system) expect(d.hidden).toBe(false);
    }
  });

  it("keeps a renamed label while keeping the key", () => {
    const saved = [{ key: "Applied", label: "Submitted", bucket: "active", hidden: false }];
    const applied = resolveStatuses(saved).find((d) => d.key === "Applied")!;
    expect(applied.label).toBe("Submitted");
    expect(applied.key).toBe("Applied");
  });

  it("returns a copy, not the shared DEFAULT_STATUSES constant", () => {
    const result1 = resolveStatuses(null);
    const result2 = resolveStatuses(null);
    expect(result1).toEqual(result2);
    expect(result1).not.toBe(result2); // different array reference
    expect(result1[0]).not.toBe(result2[0]); // different object references

    // Mutating returned result does not change DEFAULT_STATUSES
    const mutated = resolveStatuses(null);
    mutated[0].label = "MUTATED";
    expect(DEFAULT_STATUSES[0].label).toBe("New");
  });
});

describe("slugify", () => {
  it("never collides with an existing key", () => {
    const taken = ["take-home", "take-home-2"];
    expect(taken).not.toContain(slugify("Take Home", taken));
  });

  it("produces a usable key from punctuation-only input", () => {
    expect(slugify("!!!", []).length).toBeGreaterThan(0);
  });
});

describe("labelFor / bucketFor", () => {
  it("returns the label for a known key and the raw key for an unknown one", () => {
    expect(labelFor(DEFAULT_STATUSES, "Offer")).toBe("Offer");
    expect(labelFor(DEFAULT_STATUSES, "Ghosted")).toBe("Ghosted");
  });

  it("buckets an unknown key as active so it stays visible", () => {
    expect(bucketFor(DEFAULT_STATUSES, "Ghosted")).toBe("active");
  });
});

describe("optionsFor", () => {
  it("contains the current value even when it is hidden", () => {
    const defs = resolveStatuses([
      { key: "Offer", label: "Offer", bucket: "active", hidden: true },
    ]);
    expect(optionsFor(defs, "Offer").map((d) => d.key)).toContain("Offer");
  });

  it("contains the current value even when it is in no config entry", () => {
    expect(optionsFor(DEFAULT_STATUSES, "Ghosted").map((d) => d.key)).toContain("Ghosted");
  });

  it("omits a hidden status that is not the current value", () => {
    const defs = resolveStatuses([
      { key: "Offer", label: "Offer", bucket: "active", hidden: true },
    ]);
    expect(optionsFor(defs, "New").map((d) => d.key)).not.toContain("Offer");
  });
});

describe("tileCounts", () => {
  it("puts every job in exactly one tile, including unknown keys", () => {
    const stored = ["New", "Applied", "Rejected", "Posting Closed", "Ghosted"];
    const { open, out } = tileCounts(DEFAULT_STATUSES, stored);
    expect(open + out).toBe(stored.length);
    expect(out).toBe(2); // Rejected, Posting Closed
    expect(open).toBe(3); // New, Applied, Ghosted
  });
});

describe("compareByConfig", () => {
  it("orders by config index, not by label or key", () => {
    const defs = resolveStatuses([
      { key: "Offer", label: "zzz", bucket: "active", hidden: false },
      { key: "New", label: "aaa", bucket: "active", hidden: false },
    ]);
    const cmp = compareByConfig(defs);
    expect(["New", "Offer"].sort(cmp)).toEqual(["Offer", "New"]);
  });

  it("sorts an unknown key last", () => {
    const cmp = compareByConfig(DEFAULT_STATUSES);
    expect(["Ghosted", "New"].sort(cmp)).toEqual(["New", "Ghosted"]);
  });
});

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * tailwind.config.ts scans ./app/** and ./components/** only. An
 * arbitrary-value class written under lib/ is never generated, so the element
 * renders unstyled — through a green build, a green typecheck, and green
 * value-level assertions. No other check in this repo can catch it.
 */
describe("Tailwind content globs", () => {
  it("has no arbitrary-value class anywhere under lib/", () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const path = join(dir, entry);
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.tsx?$/.test(entry) && /\bbg-\[#|\btext-\[#/.test(readFileSync(path, "utf8")))
          offenders.push(path);
      }
    };
    walk("lib");
    expect(offenders).toEqual([]);
  });
});
