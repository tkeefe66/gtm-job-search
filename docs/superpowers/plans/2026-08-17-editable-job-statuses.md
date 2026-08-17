# Editable Job Statuses Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user reorder, rename, hide, add, and delete the job statuses on `/roles` from `/settings`, without breaking the three statuses that code reads and writes by name.

**Architecture:** A status becomes `{ key, label, bucket, hidden, system? }`. The **key is immutable and is what `jobs.status` stores**; the label is presentation only. The whole array lives in one `app_settings` row under a standalone `JOB_STATUSES_KEY`. A new pure module `lib/job-statuses.ts` owns the type, the shipped defaults, and every derived question (which keys are terminal, what does this key display as, what order, which tile). `lib/crawler.ts` and `lib/ingest-roles.ts` need no change at all, because they write system keys and system keys never change.

**Tech Stack:** Next.js 14 App Router, TypeScript, Tailwind 3, Postgres via `lib/supabase.ts`, vitest (`environment: "node"`).

**Spec:** `docs/superpowers/specs/2026-08-15-editable-job-statuses-design.md` (revision 4)

## Global Constraints

- **Verification gate is `npm run build && npm test`.** `npm run lint` is non-functional in this repo — never add it.
- **Keys are immutable. Labels are editable.** `jobs.status` stores keys. Never write a label to the database.
- **`SYSTEM_STATUS_KEYS` is exactly three:** `"New"`, `"Applied"`, `"Posting Closed"`. They cannot be deleted, cannot be hidden, and their keys cannot change.
- **`New` may never be `terminal`; `Posting Closed` may never be `active`.**
- **`New` is never a reassignment target** — `lib/crawler.ts:430` and `lib/removed-titles.ts:69` key on `status = 'New'`, so moving rows into it re-arms automated stale-posting closure against rows the user has triaged.
- **Tailwind arbitrary-value classes (`bg-[#...]`) may only appear under `app/` or `components/`.** `tailwind.config.ts:4-7` does not scan `lib/`. A class string in `lib/` compiles, type-checks, tests green, and renders unstyled.
- **Error contract** (`.claude/skills/swallowed-string-errors`): actions return `{ error?: string }`; the string **can be empty**. Branch on **presence** (`describeWriteFailure(...) !== undefined`), never truthiness. Transports pass the driver's message verbatim.
- **Raw SQL must carry a tenant.** Pass `tenantId` explicitly to `rawQuery`. RLS is a backstop only — a denial returns **zero rows, not an error**.
- **Two buckets only:** `"active"` and `"terminal"`. No `neutral`.
- **A stored status matching no config entry** renders verbatim, buckets `active`, and is never rewritten.

---

### Task 1: The pure status module

**Files:**
- Create: `lib/job-statuses.ts`
- Create: `lib/job-statuses.test.ts`

**Interfaces:**
- Consumes: `ACTIVE_STATUSES`, `TERMINAL_STATUSES`, `JOB_STATUSES` from `lib/types.ts` (test-only, for the parity assertion — Task 8 deletes them).
- Produces: `JobStatusDef`, `StatusBucket`, `SystemStatusKey`, `SYSTEM_STATUS_KEYS`, `DEFAULT_STATUSES`, `resolveStatuses`, `slugify`, `labelFor`, `bucketFor`, `terminalKeys`, `optionsFor`, `tileCounts`, `compareByConfig`.

- [ ] **Step 1: Write the failing tests**

Create `lib/job-statuses.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run lib/job-statuses.test.ts`
Expected: FAIL — `Failed to resolve import "./job-statuses"`.

- [ ] **Step 3: Write the module**

Create `lib/job-statuses.ts`:

```ts
// The pure half of user-editable job statuses.
//
// NO import of lib/supabase.ts, directly or transitively — this module is
// imported by "use client" components, and supabase pulls in `pg`. The read of
// the app_settings row lives in lib/settings-store.ts, which already imports it.
// Same hazard documented at components/Settings.tsx and lib/bulk-status.ts.
//
// NO Tailwind class strings either. tailwind.config.ts scans ./app/** and
// ./components/** only, so an arbitrary-value class written here would never be
// generated and the badge would render unstyled through a green build. The
// STATUS_STYLES map stays in components/RolesTable.tsx. Pinned by a test.

export type StatusBucket = "active" | "terminal";

/**
 * The statuses that code writes or reads BY NAME, not merely displays.
 *
 * They are why `jobs.status` stores keys rather than labels. Two of these are
 * matched in raw SQL that no settings page can reach —
 * `STALE_POSTING_CANDIDATES_SQL` (lib/crawler.ts) and `CRAWL_TITLE_MATCH_SQL`
 * (lib/removed-titles.ts) both say `status = 'New'` — and `db/schema.sql` makes
 * `'New'` the column default. A rename that rewrote rows would leave all three
 * matching nothing, silently disabling stale-posting closure.
 */
export type SystemStatusKey = "New" | "Applied" | "Posting Closed";

export const SYSTEM_STATUS_KEYS: SystemStatusKey[] = [
  "New",
  "Applied",
  "Posting Closed",
];

export interface JobStatusDef {
  /** Immutable. What jobs.status stores. */
  key: string;
  /** Displayed. Freely editable. */
  label: string;
  bucket: StatusBucket;
  hidden: boolean;
  /** Present iff this is a system status. */
  system?: SystemStatusKey;
}

/**
 * The shipped config, which must be a NO-OP against the pre-feature app.
 *
 * `active` is everything the old `"Open"` filter showed and link-health checked
 * — the seven in ACTIVE_STATUSES plus New and Offer, which were in neither
 * array. `terminal` is the four in TERMINAL_STATUSES. A test pins this against
 * lib/types.ts rather than trusting this comment.
 */
export const DEFAULT_STATUSES: JobStatusDef[] = [
  { key: "New", label: "New", bucket: "active", hidden: false, system: "New" },
  { key: "Applied", label: "Applied", bucket: "active", hidden: false, system: "Applied" },
  { key: "Recruiter Outreach", label: "Recruiter Outreach", bucket: "active", hidden: false },
  { key: "Phone / Intro Screen", label: "Phone / Intro Screen", bucket: "active", hidden: false },
  { key: "Hiring Manager", label: "Hiring Manager", bucket: "active", hidden: false },
  { key: "Panel Interviews", label: "Panel Interviews", bucket: "active", hidden: false },
  { key: "Exec Presentation", label: "Exec Presentation", bucket: "active", hidden: false },
  { key: "Reference Check", label: "Reference Check", bucket: "active", hidden: false },
  { key: "Offer", label: "Offer", bucket: "active", hidden: false },
  { key: "Not Interested", label: "Not Interested", bucket: "terminal", hidden: false },
  { key: "Rejected", label: "Rejected", bucket: "terminal", hidden: false },
  { key: "Passed", label: "Passed", bucket: "terminal", hidden: false },
  {
    key: "Posting Closed",
    label: "Posting Closed",
    bucket: "terminal",
    hidden: false,
    system: "Posting Closed",
  },
];

/** The bucket a system key is pinned to, or null if it may be either. */
const SYSTEM_BUCKET: Record<SystemStatusKey, StatusBucket | null> = {
  New: "active",
  Applied: null,
  "Posting Closed": "terminal",
};

const isBucket = (v: unknown): v is StatusBucket => v === "active" || v === "terminal";

/**
 * Turns whatever is in the jsonb row into a config the app can run on.
 *
 * REPAIRS rather than rejects, because rejecting means falling back to the
 * defaults wholesale — which silently un-hides statuses and reverts renames the
 * user made. A repaired config is used, never written back: the write happens
 * only when the user saves.
 */
export function resolveStatuses(raw: unknown): JobStatusDef[] {
  if (!Array.isArray(raw)) return DEFAULT_STATUSES;

  const byKey = new Map<string, JobStatusDef>();
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) continue;
    const e = entry as Record<string, unknown>;
    const key = typeof e.key === "string" ? e.key.trim() : "";
    if (!key) continue;
    if (byKey.has(key)) continue; // first wins

    const system = SYSTEM_STATUS_KEYS.find((k) => k === key);
    const label = typeof e.label === "string" && e.label.trim() ? e.label.trim() : key;
    const pinned = system ? SYSTEM_BUCKET[system] : null;
    const bucket = pinned ?? (isBucket(e.bucket) ? e.bucket : "active");

    byKey.set(key, {
      key,
      label,
      bucket,
      // A system status can never be hidden: db/schema.sql defaults the column
      // to "New" and two form defaults seed it in state, so hiding it would let
      // a form save a status the user never picked.
      hidden: system ? false : e.hidden === true,
      ...(system ? { system } : {}),
    });
  }

  if (byKey.size === 0) return DEFAULT_STATUSES;

  // Any system key the saved config dropped comes back, in its shipped position
  // relative to the others rather than appended blindly.
  for (const def of DEFAULT_STATUSES) {
    if (def.system && !byKey.has(def.key)) byKey.set(def.key, def);
  }

  return [...byKey.values()];
}

/** A key for a new status, derived from its label and unique against `taken`. */
export function slugify(label: string, taken: Iterable<string>): string {
  const base =
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "status";
  const used = new Set(taken);
  if (!used.has(base)) return base;
  let n = 2;
  while (used.has(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

/**
 * What to DISPLAY for a stored status value.
 *
 * An unrecognised key returns itself rather than a placeholder: it means a
 * hand-edited or legacy row, and showing the user what the database actually
 * holds is more useful than "Unknown".
 */
export function labelFor(defs: JobStatusDef[], key: string): string {
  return defs.find((d) => d.key === key)?.label ?? key;
}

/**
 * Which tile a stored status counts in.
 *
 * An unrecognised key is `active`, deliberately. The default "Open" filter hides
 * terminal rows, so bucketing it the other way would make a row that plainly
 * exists in the database vanish from the table with nothing to explain it.
 */
export function bucketFor(defs: JobStatusDef[], key: string): StatusBucket {
  return defs.find((d) => d.key === key)?.bucket ?? "active";
}

export function terminalKeys(defs: JobStatusDef[]): string[] {
  return defs.filter((d) => d.bucket === "terminal").map((d) => d.key);
}

/**
 * The options a <select> must render, given what the row currently holds.
 *
 * `current` is ALWAYS included, even when hidden or absent from the config. A
 * `<select value={v}>` whose value matches no `<option>` renders the FIRST
 * option instead — so without this, hiding a status would make every row
 * holding it display something else while the database disagreed.
 */
export function optionsFor(defs: JobStatusDef[], current: string): JobStatusDef[] {
  const visible = defs.filter((d) => !d.hidden || d.key === current);
  if (visible.some((d) => d.key === current)) return visible;
  return [...visible, { key: current, label: current, bucket: "active", hidden: false }];
}

/**
 * The two tile counts. Every stored value lands in exactly one of them, for any
 * config and any value — that is what makes the sum invariant true by
 * construction rather than by test.
 */
export function tileCounts(
  defs: JobStatusDef[],
  stored: string[]
): { open: number; out: number } {
  let open = 0;
  let out = 0;
  for (const s of stored) {
    if (bucketFor(defs, s) === "terminal") out++;
    else open++;
  }
  return { open, out };
}

/** Sorts stored status values into config order. Unknown keys sort last. */
export function compareByConfig(defs: JobStatusDef[]): (a: string, b: string) => number {
  const index = new Map(defs.map((d, i) => [d.key, i]));
  const rank = (k: string) => index.get(k) ?? Number.MAX_SAFE_INTEGER;
  return (a, b) => rank(a) - rank(b);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run lib/job-statuses.test.ts`
Expected: PASS, all cases.

- [ ] **Step 5: Run the full gate**

Run: `npm run build && npm test`
Expected: both green. Nothing imports the new module yet, so this only proves it compiles.

- [ ] **Step 6: Commit**

```bash
git add lib/job-statuses.ts lib/job-statuses.test.ts
git commit -m "feat: pure job-status config module, defaults pinned to today's behavior"
```

---

### Task 2: Storage and the settings view

**Files:**
- Modify: `lib/settings-store.ts` (add `JOB_STATUSES_KEY`, widen `upsertSetting`'s key union, add `writeJobStatuses` + `jobStatusesFrom`)
- Modify: `lib/settings-view.ts` (add `statuses` to `SettingsView`, resolve it in `buildSettingsView`)
- Modify: `lib/settings-view.test.ts`

**Interfaces:**
- Consumes: `resolveStatuses`, `DEFAULT_STATUSES`, `JobStatusDef` from Task 1.
- Produces: `JOB_STATUSES_KEY`, `jobStatusesFrom(rows): JobStatusDef[]`, `writeJobStatuses(defs): Promise<{error?: string}>`, `SettingsView.statuses`.

> **Why `JOB_STATUSES_KEY` is NOT in `SETTING_KEYS`:** `SETTING_KEYS` members go through `mergeSettings`, which is shape-guarded for list/text/number values and would have to grow a fourth group for an array of objects. The repo already has the right precedent for a key that does not merge — `CRITERIA_CHANGED_AT_KEY` and `COMP_SCORING_RESCORED_AT_KEY`. Following it means **zero edits to `lib/settings-store.test.ts`** and **zero edits to `lib/settings-effects.ts`**, whose two records are typed `Record<SettingKey, string[]>` and therefore cannot hold this key at all.

- [ ] **Step 1: Write the failing test**

Add to `lib/settings-view.test.ts`:

```ts
import { DEFAULT_STATUSES } from "./job-statuses";
import { JOB_STATUSES_KEY } from "./settings-store";

describe("statuses on the settings view", () => {
  it("falls back to the shipped defaults when no row is stored", () => {
    const view = buildSettingsView({
      rows: [],
      settingsError: undefined,
      scoredJobCount: 0,
      countError: undefined,
    });
    expect(view.statuses).toEqual(DEFAULT_STATUSES);
  });

  it("reads a stored config off the same snapshot as everything else", () => {
    const view = buildSettingsView({
      rows: [
        {
          key: JOB_STATUSES_KEY,
          value: [{ key: "Applied", label: "Submitted", bucket: "active", hidden: false }],
        },
      ],
      settingsError: undefined,
      scoredJobCount: 0,
      countError: undefined,
    });
    expect(view.statuses.find((d) => d.key === "Applied")!.label).toBe("Submitted");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run lib/settings-view.test.ts`
Expected: FAIL — `JOB_STATUSES_KEY` is not exported, and `view.statuses` does not exist.

- [ ] **Step 3: Add the key and writer to `lib/settings-store.ts`**

Add next to `COMP_SCORING_RESCORED_AT_KEY`:

```ts
/**
 * Where the user's job-status config lives.
 *
 * A standalone key, deliberately NOT a member of SETTING_KEYS, for the same
 * reason the two stamps above are not: it does not go through mergeSettings.
 * Its value is an array of objects, and mergeSettings is shape-guarded for the
 * list/text/number values that ARE criteria fields. Putting it in SETTING_KEYS
 * would force a fourth shape group and edits to two currently-green tests, to
 * buy a merge this value never uses.
 */
export const JOB_STATUSES_KEY = "jobStatuses";
```

Widen `upsertSetting`'s key union (the comment there says "Add a literal per stamp; never `string`" — this is that):

```ts
async function upsertSetting(
  key:
    | SettingKey
    | typeof CRITERIA_CHANGED_AT_KEY
    | typeof COMP_SCORING_RESCORED_AT_KEY
    | typeof JOB_STATUSES_KEY,
  value: unknown
): Promise<{ error?: string }> {
```

Add the reader and writer at the end of the file:

```ts
/**
 * The status config out of rows ALREADY read — pure, for the reason
 * compScoringRescoredFrom is: the settings page takes ONE snapshot of
 * app_settings and everything it shows must come out of that same snapshot,
 * or a concurrent save can split the page across two versions of the settings.
 */
export function jobStatusesFrom(rows: SettingRow[]): JobStatusDef[] {
  return resolveStatuses(rows.find((r) => r.key === JOB_STATUSES_KEY)?.value ?? null);
}

/**
 * Stores the whole array. Lives here, next to the key, for the reason spelled
 * out on writeCriteriaChangedAt: a writer in another module would have to widen
 * upsertSetting's key type to reach it, reopening the typo hazard the constant
 * closes.
 */
export async function writeJobStatuses(
  defs: JobStatusDef[]
): Promise<{ error?: string }> {
  return upsertSetting(JOB_STATUSES_KEY, defs);
}
```

Add the import at the top of the file:

```ts
import { resolveStatuses, type JobStatusDef } from "@/lib/job-statuses";
```

- [ ] **Step 4: Add `statuses` to the settings view**

In `lib/settings-view.ts`, add to the `SettingsView` interface:

```ts
  /** The user's pipeline statuses, resolved from the same snapshot as the rest. */
  statuses: JobStatusDef[];
```

Import `jobStatusesFrom` from `./settings-store` and `type JobStatusDef` from `./job-statuses`, then add to the object `buildSettingsView` returns:

```ts
    statuses: jobStatusesFrom(input.rows),
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run lib/settings-view.test.ts lib/settings-store.test.ts`
Expected: PASS. `settings-store.test.ts` must pass **unedited** — if it fails, `JOB_STATUSES_KEY` was added to `SETTING_KEYS` by mistake.

- [ ] **Step 6: Run the full gate and commit**

Run: `npm run build && npm test`

```bash
git add lib/settings-store.ts lib/settings-view.ts lib/settings-view.test.ts
git commit -m "feat: store the job-status config in app_settings under a standalone key"
```

---

### Task 3: Server actions

**Files:**
- Modify: `app/actions/jobs.ts` (add `getJobStatuses`)
- Modify: `app/actions/settings.ts` (add `saveJobStatuses`, `countJobsByStatus`, `reassignStatus`)

**Interfaces:**
- Consumes: `resolveStatuses`, `JobStatusDef` (Task 1); `JOB_STATUSES_KEY`, `writeJobStatuses` (Task 2).
- Produces:
  - `getJobStatuses(): Promise<{ statuses: JobStatusDef[]; error?: string }>`
  - `saveJobStatuses(defs: JobStatusDef[]): Promise<{ error?: string }>`
  - `countJobsByStatus(): Promise<{ counts: Record<string, number>; error?: string }>`
  - `reassignStatus(fromKey: string, toKey: string): Promise<{ moved: number; error?: string }>`

> **Both reads carry an error channel, and this is not optional.** `getJobStatuses` falling back to `DEFAULT_STATUSES` on a failed read would silently un-hide statuses, revert renames, and let the user write a status their config does not contain. `countJobsByStatus` reading `0` on failure silently unlocks the delete guard. Same argument `getJobs()` already makes.

- [ ] **Step 1: Add `getJobStatuses` to `app/actions/jobs.ts`**

```ts
import { resolveStatuses, type JobStatusDef } from "@/lib/job-statuses";
import { JOB_STATUSES_KEY } from "@/lib/settings-store";
import { rawQuery } from "@/lib/supabase";

/**
 * The user's status config, for the client components that render statuses.
 *
 * Carries an error channel on purpose. Returning DEFAULT_STATUSES on a failed
 * read would show the user a config that is not theirs — un-hiding statuses and
 * reverting renames — and then let them write a status their config forbids.
 * The caller must be able to tell "your config" from "the database is down".
 */
export async function getJobStatuses(): Promise<{
  statuses: JobStatusDef[];
  error?: string;
}> {
  await requireActor();
  const tenantId = await resolveTenantId();
  const { data, error } = await rawQuery<{ value: unknown }>(
    `select value from app_settings where tenant_id = $1 and key = $2`,
    [tenantId, JOB_STATUSES_KEY],
    tenantId
  );
  // Verbatim, empty string included — presence is the signal.
  if (error) return { statuses: resolveStatuses(null), error: error.message };
  return { statuses: resolveStatuses(data?.[0]?.value ?? null) };
}
```

- [ ] **Step 2: Add the three settings actions to `app/actions/settings.ts`**

```ts
/**
 * Replaces the whole status config.
 *
 * Whole-array replace, last-write-wins across tabs — accepted, and the reason
 * there is no merge is that reorder and delete have no sensible per-field merge.
 *
 * Clears no cache and revalidates no path, and both are decisions rather than
 * omissions. Statuses do not change what any search returns, so no cached search
 * result goes stale. /roles renders compFloor server-side but fetches statuses
 * client-side, so there is nothing server-rendered to invalidate.
 */
export async function saveJobStatuses(
  defs: JobStatusDef[]
): Promise<{ error?: string }> {
  await requireActor();
  // Resolved before storing, never after: repairs (a dropped system key, New
  // forced back to active) belong in the stored value, not re-applied on every
  // read of a config the user believes they saved.
  return writeJobStatuses(resolveStatuses(defs));
}

/**
 * How many jobs hold each status key.
 *
 * Carries an error channel because a failed count reading as an empty record is
 * indistinguishable from "nothing uses this status", which silently unlocks the
 * delete guard.
 */
export async function countJobsByStatus(): Promise<{
  counts: Record<string, number>;
  error?: string;
}> {
  await requireActor();
  const tenantId = await resolveTenantId();
  const { data, error } = await rawQuery<{ status: string; n: string }>(
    `select status, count(*) n from jobs where tenant_id = $1 group by status`,
    [tenantId],
    tenantId
  );
  if (error) return { counts: {}, error: error.message };
  const counts: Record<string, number> = {};
  for (const row of data ?? []) counts[row.status] = Number(row.n);
  return { counts };
}

/**
 * Moves every job on `fromKey` to `toKey`.
 *
 * Explicitly tenant-scoped. This is raw SQL, so QueryBuilder's tenant-table
 * registry does not see it, and rawQuery's own docs say the tenantId argument is
 * the only thing that puts a policy in front of it. RLS is a backstop, not a
 * substitute: a policy denial returns zero rows rather than an error, so an
 * unscoped update would report success having moved nothing.
 *
 * `New` is rejected as a target. lib/crawler.ts and lib/removed-titles.ts both
 * match `status = 'New'` to decide which rows automated stale-posting closure
 * may touch, so moving hand-triaged rows into it re-arms that automation against
 * them — a larger footgun than any bucket change.
 */
export async function reassignStatus(
  fromKey: string,
  toKey: string
): Promise<{ moved: number; error?: string }> {
  await requireActor();
  if (toKey === "New") {
    return {
      moved: 0,
      error:
        'Roles cannot be moved into "New". The crawler treats New roles as ' +
        "un-triaged and may close them automatically.",
    };
  }
  const tenantId = await resolveTenantId();
  const { data, error } = await rawQuery<{ id: string }>(
    `update jobs set status = $2, updated_at = now()
      where tenant_id = $3 and status = $1
      returning id`,
    [fromKey, toKey, tenantId],
    tenantId
  );
  if (error) return { moved: 0, error: error.message };
  return { moved: (data ?? []).length };
}
```

Add the imports this needs at the top of `app/actions/settings.ts`:

```ts
import { resolveStatuses, type JobStatusDef } from "@/lib/job-statuses";
import { writeJobStatuses } from "@/lib/settings-store";
```

- [ ] **Step 3: Run the gate**

Run: `npm run build && npm test`
Expected: both green. These actions have no callers yet.

- [ ] **Step 4: Commit**

```bash
git add app/actions/jobs.ts app/actions/settings.ts
git commit -m "feat: server actions to read, save, count and reassign job statuses"
```

---

### Task 4: Delete dead code and pin the Tailwind constraint

**Files:**
- Modify: `components/ui.tsx`
- Modify: `lib/job-statuses.test.ts`

> `StatusBadge`, `SeniorityBadge`, and `Stars` in `components/ui.tsx` have **zero callers repo-wide**. `StatusBadge`'s map is also wrong — it lists `Reviewing`, which is not a status, and gives different colors than `RolesTable` for names they share. Deleting it is not a lossy simplification; verify the zero-caller claim yourself before deleting.

- [ ] **Step 1: Verify the three exports are unused**

Run:
```bash
grep -rn "StatusBadge\|SeniorityBadge\|Stars" app components lib | grep -v "^components/ui.tsx:"
```
Expected: no output. If anything prints, stop and keep that export.

- [ ] **Step 2: Write the failing guard test**

Add to `lib/job-statuses.test.ts`:

```ts
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
```

- [ ] **Step 3: Run it to verify it passes now and would fail later**

Run: `npx vitest run lib/job-statuses.test.ts -t "Tailwind"`
Expected: PASS (nothing in `lib/` has such a class today). To confirm the test can actually fail, temporarily add `const x = "bg-[#fff]";` to `lib/job-statuses.ts`, re-run, see it FAIL, then remove the line.

- [ ] **Step 4: Delete the three dead exports**

In `components/ui.tsx`, delete `STATUS_STYLES`, `StatusBadge`, `SeniorityBadge`, and `Stars`, plus the now-unused `import type { JobStatus, Seniority } from "@/lib/types";`. Keep `Spinner` and anything else with callers.

- [ ] **Step 5: Run the gate and commit**

Run: `npm run build && npm test`

```bash
git add components/ui.tsx lib/job-statuses.test.ts
git commit -m "chore: delete unused ui.tsx badges; pin the Tailwind content-glob constraint"
```

---

### Task 5: Make `/roles` config-driven

**Files:**
- Modify: `lib/applied-date.ts` (widen the parameter, keep the typed constant)
- Modify: `lib/applied-date.test.ts`
- Modify: `components/RolesTable.tsx`

**Interfaces:**
- Consumes: everything from Task 1; `getJobStatuses` from Task 3.
- Produces: nothing new — this is the consumer switch.

> **Order matters:** `lib/types.ts` still exports the three arrays after this task. `RolesTable` simply stops importing them. Task 8 deletes them once nothing imports them, which keeps every commit's build green.

- [ ] **Step 1: Write the failing applied-date test**

`handleStatus` will start passing arbitrary config keys, so `appliedDatePatch`'s parameter must widen to `string`. The safety it was written for must survive that. Add to `lib/applied-date.test.ts`:

```ts
it("still stamps when Applied has been renamed, because the KEY is what is stored", () => {
  // The user renamed "Applied" to "Submitted" on /settings. The label changed;
  // the key did not, and the key is what reaches this function.
  expect(appliedDatePatch("Applied", null, "2026-08-17")).toEqual({
    applied_date: "2026-08-17",
  });
});

it("does not stamp for a custom status the user added", () => {
  expect(appliedDatePatch("take-home", null, "2026-08-17")).toEqual({});
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run lib/applied-date.test.ts`
Expected: FAIL — `Argument of type '"take-home"' is not assignable to parameter of type 'JobStatus'`.

- [ ] **Step 3: Widen the parameter, keep the constant typed**

In `lib/applied-date.ts`, change the import and the two signatures:

```ts
import type { SystemStatusKey } from "@/lib/job-statuses";

/**
 * The status this rule keys on, named rather than inlined.
 *
 * The PARAMETER is now `string`, because the user can add statuses and this
 * function must be reachable with any of their keys. The safety did not move
 * far: `APPLIED` is still typed, now as SystemStatusKey, so dropping "Applied"
 * from the system set is still a compile error here. And the hazard the old
 * `JobStatus` parameter guarded — a RENAME silently stopping the stamp — cannot
 * happen any more by construction: renaming edits the label, never the key, and
 * the key is what jobs.status stores and what arrives here.
 */
const APPLIED: SystemStatusKey = "Applied";

export function appliedDatePatch(
  status: string,
  existing: string | null,
  today: string
): { applied_date?: string } {
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run lib/applied-date.test.ts`
Expected: PASS.

- [ ] **Step 5: Load the config in `RolesTable`**

Replace the `lib/types.ts` status import at `components/RolesTable.tsx:6` with:

```ts
import { type Job } from "@/lib/types";
import {
  DEFAULT_STATUSES,
  bucketFor,
  compareByConfig,
  labelFor,
  optionsFor,
  tileCounts,
  type JobStatusDef,
} from "@/lib/job-statuses";
import { getJobStatuses } from "@/app/actions/jobs";
```

Add state beside the existing `jobs` state, and fetch it in the existing `load()`:

```ts
  const [statuses, setStatuses] = useState<JobStatusDef[]>(DEFAULT_STATUSES);
  const [statusError, setStatusError] = useState<string | undefined>(undefined);
```

Inside `load()`, alongside the `getJobs()` call:

```ts
    const cfg = await getJobStatuses();
    setStatuses(cfg.statuses);
    // Presence, not truthiness: the message can be empty.
    setStatusError(cfg.error !== undefined
      ? describeWriteFailure(cfg.error, "load your status settings")
      : undefined);
```

- [ ] **Step 6: Replace the filter state, counts, tiles, and chips**

Change the filter state at `:59` from a string union to a tagged one, which removes the need for any reserved-key blacklist:

```ts
  type StatusFilter =
    | { kind: "sentinel"; key: "All" | "Open" | "Out" }
    | { kind: "status"; key: string };
  const [statusFilter, setStatusFilter] = useState<StatusFilter>({
    kind: "sentinel",
    key: "Open",
  });
```

Replace the `counts` memo (`:184-191`) and `FUNNEL` (`:212-217`) with two config-driven tiles:

```ts
  const counts = useMemo(
    () => tileCounts(statuses, jobs.map((j) => j.status)),
    [jobs, statuses]
  );

  const FUNNEL: { label: string; key: "Open" | "Out"; count: number }[] = [
    { label: "Open", key: "Open", count: counts.open },
    { label: "Out", key: "Out", count: counts.out },
  ];
```

Update the tile grid at `:530` to `sm:grid-cols-2` and render from the new shape:

```tsx
      <div className="mb-6 grid grid-cols-2 gap-3">
        {FUNNEL.map((f) => (
          <button
            key={f.key}
            onClick={() =>
              setStatusFilter(
                statusFilter.kind === "sentinel" && statusFilter.key === f.key
                  ? { kind: "sentinel", key: "Open" }
                  : { kind: "sentinel", key: f.key }
              )
            }
            className={`rounded-lg border p-4 text-left transition ${
              statusFilter.kind === "sentinel" && statusFilter.key === f.key
                ? "border-ink"
                : "border-slate hover:border-ink/30"
            } bg-white`}
          >
            <div className="text-2xl font-heading font-semibold">{f.count}</div>
            <div className="text-xs text-ink/60">{f.label}</div>
          </button>
        ))}
      </div>
```

Replace the chip row at `:554` so it renders labels and carries keys:

```tsx
        <div className="flex flex-wrap gap-2">
          {([{ kind: "sentinel", key: "Open" }, { kind: "sentinel", key: "All" }] as StatusFilter[])
            .concat(statuses.filter((d) => !d.hidden).map((d) => ({ kind: "status", key: d.key })))
            .map((f) => (
              <button
                key={`${f.kind}:${f.key}`}
                onClick={() => setStatusFilter(f)}
                className={`rounded-full border px-3 py-1 text-xs font-medium transition ${
                  statusFilter.kind === f.kind && statusFilter.key === f.key
                    ? "border-ink bg-ink text-white"
                    : "border-slate bg-white hover:border-ink"
                }`}
              >
                {f.kind === "sentinel" ? f.key : labelFor(statuses, f.key)}
              </button>
            ))}
        </div>
```

Replace the filter predicate at `:226-234`:

```ts
      if (statusFilter.kind === "status") {
        if (j.status !== statusFilter.key) return false;
      } else if (statusFilter.key === "Open") {
        if (bucketFor(statuses, j.status) === "terminal") return false;
      } else if (statusFilter.key === "Out") {
        if (bucketFor(statuses, j.status) !== "terminal") return false;
      }
      // "All" falls through and shows everything.
```

Add `statuses` to the `filtered` memo's dependency array.

- [ ] **Step 7: Update the three `<select>` sites and the status sort**

`StatusSelect` at `:978`:

```tsx
function StatusSelect({
  value,
  statuses,
  onChange,
}: {
  value: string;
  statuses: JobStatusDef[];
  onChange: (s: string) => void;
}) {
  const style = STATUS_STYLES[value] ?? "bg-[#F3F4F6] text-[#6B7280]";
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className={`rounded-full border-0 px-2.5 py-1 text-xs font-medium outline-none cursor-pointer ${style}`}
    >
      {optionsFor(statuses, value).map((d) => (
        <option key={d.key} value={d.key}>{d.label}</option>
      ))}
    </select>
  );
}
```

Pass `statuses` at its call site (`:745`). Use `optionsFor(statuses, form.status)` at the add form (`:1205`) for the same reason as `StatusSelect` — it renders a real stored value.

The bulk dropdown (`:653`) is the exception and does **not** use `optionsFor`:

```tsx
                  {statuses.filter((d) => !d.hidden).map((d) => (
                    <option key={d.key} value={d.key}>{d.label}</option>
                  ))}
```

`optionsFor` injects the current value so a `<select>` can never render a status the row does not hold. That hazard does not exist here: this select's value is always `""` (it resets after each pick so choosing the same status twice still fires `onChange`), and the explicit `<option value="">Set status…</option>` already covers the empty value. Passing `""` as `current` would inject a *second*, blank option beside the placeholder, because `optionsFor` appends any `current` it cannot find — and `""` is never in the config.

Retype `handleStatus(job: Job, status: string)` and `handleBulkStatus(status: string)`, and change the banner text at `:280` to use the label:

```ts
    await commitWrite(`move ${job.company} to "${labelFor(statuses, status)}"`, () =>
```

Change the `status` case in the sort comparator so the column sorts in pipeline order rather than alphabetically — "Applied" before "Offer" because that is the order the user arranged, not because A precedes O:

```ts
      if (sortKey === "status") {
        const cmp = compareByConfig(statuses)(a.status, b.status);
        return sortDir === "asc" ? cmp : -cmp;
      }
```

In `handleBulkStatus`, the summary sentence takes the label too — `summarizeBulkStatus`'s parameter is already `string`, so `lib/bulk-status.ts` needs no change:

```ts
    const summary = summarizeBulkStatus(results, labelFor(statuses, status));
```

Change `status: "New" as JobStatus` to `status: "New"` in `EMPTY_ADD` (`:1038`), and **delete `EMPTY_FORM` at `:1032` entirely** — its only reference is its own definition.

Render `statusError` next to the existing load-error banner.

- [ ] **Step 8: Run the gate**

Run: `npm run build && npm test`
Expected: both green.

- [ ] **Step 9: Verify in the browser**

Run `npm run dev`, open `/roles`, and confirm: two tiles reading Open and Out whose counts sum to the total row count; the chip row still lists every status; clicking a chip filters; the per-row dropdown still writes.

- [ ] **Step 10: Commit**

```bash
git add lib/applied-date.ts lib/applied-date.test.ts components/RolesTable.tsx
git commit -m "feat: /roles reads the status config — two tiles, config-driven chips and selects"
```

---

### Task 6: `RecruiterPanel` and link health

**Files:**
- Modify: `components/RecruiterPanel.tsx`
- Modify: `app/actions/link-health.ts:79`

- [ ] **Step 1: Wire `RecruiterPanel`**

Replace the `JOB_STATUSES` import with `optionsFor`, `DEFAULT_STATUSES`, and `type JobStatusDef` from `@/lib/job-statuses`, plus `getJobStatuses` from `@/app/actions/jobs`. Add state and load it on mount:

```ts
  const [statuses, setStatuses] = useState<JobStatusDef[]>(DEFAULT_STATUSES);
  useEffect(() => {
    void getJobStatuses().then((r) => setStatuses(r.statuses));
  }, []);
```

Change `status: "New" as JobStatus` at `:37` to `status: "New"`, drop the now-unused `JobStatus` import, and replace the `<select>` body at `:266`:

```tsx
                    {optionsFor(statuses, form.status).map((d) => (
                      <option key={d.key} value={d.key}>{d.label}</option>
                    ))}
```

- [ ] **Step 2: Switch link health to the config**

`app/actions/link-health.ts` decides which roles cost a liveness check. Replace the `TERMINAL_STATUSES` import with `resolveStatuses`/`bucketFor` and read the config once per pass, before the filter at `:79`:

```ts
  const { statuses } = await getJobStatuses();
  ...
    (j) => j.job_url && bucketFor(statuses, j.status) !== "terminal"
```

Leave the two `updateJob(job.id, { status: "Posting Closed" })` calls at `:140` and `:164` exactly as they are — `"Posting Closed"` is an immutable system key.

- [ ] **Step 3: Run the gate**

Run: `npm run build && npm test`

- [ ] **Step 4: Commit**

```bash
git add components/RecruiterPanel.tsx app/actions/link-health.ts
git commit -m "feat: recruiter panel and link health read the status config"
```

---

### Task 7: The editor on `/settings`

**Files:**
- Create: `components/StatusEditor.tsx`
- Modify: `components/Settings.tsx` (render it)

> **It does NOT join the `Draft` machinery.** `components/Settings.tsx` is 852 lines built on a section-keyed model — a `Section` union, `LABELS`, `Draft`, `EMPTY_DRAFT`, `draftFrom`, and `syncSection`'s exhaustive switch with no `default`, so a new `Section` member is a compile error. `Draft` is all `string`/`boolean` and cannot hold a `JobStatusDef[]`. The editor is its own component with its own local state, rendered inside `Settings.tsx` but outside that machinery, saving through `saveJobStatuses` directly.
>
> **Reorder is up/down buttons, not drag.** `package.json` has no drag-and-drop dependency and this plan does not add one.

- [ ] **Step 1: Build the editor**

Create `components/StatusEditor.tsx`:

```tsx
"use client";

import { useState } from "react";
import { countJobsByStatus, reassignStatus, saveJobStatuses } from "@/app/actions/settings";
import { slugify, type JobStatusDef } from "@/lib/job-statuses";
import { describeWriteFailure } from "@/lib/write-failure";
import { Spinner } from "./ui";

/** The row being deleted, and what we know about it. */
type Pending = { key: string; label: string; count: number; to: string };

export default function StatusEditor({ initial }: { initial: JobStatusDef[] }) {
  const [defs, setDefs] = useState<JobStatusDef[]>(initial);
  const [newLabel, setNewLabel] = useState("");
  const [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const patch = (key: string, next: Partial<JobStatusDef>) =>
    setDefs((prev) => prev.map((d) => (d.key === key ? { ...d, ...next } : d)));

  function move(index: number, delta: number) {
    const to = index + delta;
    if (to < 0 || to >= defs.length) return;
    const next = [...defs];
    [next[index], next[to]] = [next[to], next[index]];
    setDefs(next);
  }

  function addStatus() {
    const label = newLabel.trim();
    if (!label) return;
    const key = slugify(label, defs.map((d) => d.key));
    setDefs([...defs, { key, label, bucket: "active", hidden: false }]);
    setNewLabel("");
  }

  /** Reassignment may never target New — see the confirm copy below. */
  const targetsFor = (key: string) =>
    defs.filter((d) => d.key !== key && d.key !== "New");

  async function beginDelete(def: JobStatusDef) {
    setBusy(true);
    setError(null);
    const { counts, error: countError } = await countJobsByStatus();
    setBusy(false);
    // Presence, not truthiness: a failed count reading as 0 would silently
    // unlock this guard and delete a status with rows still on it.
    if (countError !== undefined) {
      // `?? null` because describeWriteFailure returns string | undefined and
      // this state is string | null — the same shape RolesTable.tsx:104 uses.
      setError(describeWriteFailure(countError, "check how many roles use that status") ?? null);
      return;
    }
    const count = counts[def.key] ?? 0;
    if (count === 0) {
      setDefs((prev) => prev.filter((d) => d.key !== def.key));
      return;
    }
    const targets = targetsFor(def.key);
    if (targets.length === 0) {
      setError("There is no other status to move those roles to.");
      return;
    }
    setPending({ key: def.key, label: def.label, count, to: targets[0].key });
  }

  /**
   * Reassign FIRST, then save.
   *
   * A failure between the two leaves rows on a key that is still in the list —
   * consistent and recoverable. The reverse order orphans them. But consistent
   * is not harmless: the UPDATE lands, the save fails, the banner reads "save
   * failed", and the user takes that to mean nothing happened while N rows of
   * hand-entered triage have been relabeled with no undo and no backups. Hence
   * the row count and the irreversibility in the confirm, and the moved count
   * in the result.
   */
  async function confirmDelete() {
    if (!pending) return;
    setBusy(true);
    setError(null);
    const { moved, error: moveError } = await reassignStatus(pending.key, pending.to);
    if (moveError !== undefined) {
      setBusy(false);
      setError(describeWriteFailure(moveError, "move those roles") ?? null);
      return;
    }
    const next = defs.filter((d) => d.key !== pending.key);
    const { error: saveError } = await saveJobStatuses(next);
    setBusy(false);
    if (saveError !== undefined) {
      // The rows ALREADY moved. Say so first — this is the half-applied case the
      // ordering comment above is about, and "save failed" alone would read as
      // "nothing happened".
      const detail = describeWriteFailure(saveError, "save your statuses") ?? "";
      setError(
        `${moved} role${moved === 1 ? "" : "s"} moved, but the status list did not save. ${detail}`
      );
      return;
    }
    setDefs(next);
    setPending(null);
    setNote(`Moved ${moved} role${moved === 1 ? "" : "s"} and deleted “${pending.label}”.`);
  }

  async function save() {
    setBusy(true);
    setError(null);
    setNote(null);
    const { error: saveError } = await saveJobStatuses(defs);
    setBusy(false);
    if (saveError !== undefined) {
      setError(describeWriteFailure(saveError, "save your statuses") ?? null);
      return;
    }
    setNote("Saved.");
  }

  return (
    <div className="rounded-lg border border-slate bg-white p-5">
      <h3 className="mb-1 font-heading text-sm font-semibold">Pipeline statuses</h3>
      <p className="mb-4 text-xs text-ink/60">
        Rename, reorder, hide, add or remove the statuses on your roles table.
        “Out” statuses are hidden by the table’s default filter and are skipped
        when you check links. New, Applied and Posting Closed are written by the
        app itself — you can rename them, but not remove them.
      </p>

      <div className="flex flex-col gap-2">
        {defs.map((d, i) => (
          <div key={d.key} className="flex items-center gap-2">
            <div className="flex flex-col">
              <button onClick={() => move(i, -1)} disabled={i === 0}
                className="px-1 text-xs disabled:opacity-25" aria-label="Move up">▲</button>
              <button onClick={() => move(i, 1)} disabled={i === defs.length - 1}
                className="px-1 text-xs disabled:opacity-25" aria-label="Move down">▼</button>
            </div>
            <input
              value={d.label}
              onChange={(e) => patch(d.key, { label: e.target.value })}
              className="flex-1 rounded-md border border-slate px-2 py-1 text-sm outline-none focus:border-ink"
            />
            <select
              value={d.bucket}
              // New must stay Open and Posting Closed must stay Out: the crawler
              // and the link-health pass both key off that split.
              disabled={d.key === "New" || d.key === "Posting Closed"}
              onChange={(e) =>
                patch(d.key, { bucket: e.target.value as JobStatusDef["bucket"] })
              }
              className="rounded-md border border-slate px-2 py-1 text-xs disabled:opacity-50"
            >
              <option value="active">Open</option>
              <option value="terminal">Out</option>
            </select>
            <label className="flex items-center gap-1 text-xs text-ink/60">
              <input
                type="checkbox"
                checked={d.hidden}
                disabled={Boolean(d.system)}
                onChange={(e) => patch(d.key, { hidden: e.target.checked })}
              />
              Hide
            </label>
            {d.system ? (
              <span className="w-16 text-center text-xs text-ink/30">system</span>
            ) : (
              <button onClick={() => void beginDelete(d)} disabled={busy}
                className="w-16 rounded px-2 py-1 text-xs text-[#991B1B] hover:bg-slate disabled:opacity-50">
                Delete
              </button>
            )}
          </div>
        ))}
      </div>

      {pending && (
        <div className="mt-4 rounded-md border border-[#991B1B]/40 p-3 text-sm">
          <p className="mb-2">
            Move {pending.count} role{pending.count === 1 ? "" : "s"} to{" "}
            <select
              value={pending.to}
              onChange={(e) => setPending({ ...pending, to: e.target.value })}
              className="rounded border border-slate px-1 py-0.5 text-sm"
            >
              {targetsFor(pending.key).map((t) => (
                <option key={t.key} value={t.key}>{t.label}</option>
              ))}
            </select>{" "}
            and delete “{pending.label}”?
          </p>
          <p className="mb-3 text-xs text-ink/60">
            This rewrites {pending.count} row{pending.count === 1 ? "" : "s"} and
            cannot be undone.
          </p>
          <div className="flex gap-2">
            <button onClick={() => void confirmDelete()} disabled={busy}
              className="rounded-md border border-ink bg-ink px-3 py-1 text-xs text-white disabled:opacity-50">
              Move and delete
            </button>
            <button onClick={() => setPending(null)} disabled={busy}
              className="rounded-md border border-slate px-3 py-1 text-xs">
              Cancel
            </button>
          </div>
        </div>
      )}

      <div className="mt-4 flex items-center gap-2">
        <input
          value={newLabel}
          onChange={(e) => setNewLabel(e.target.value)}
          placeholder="Add a status…"
          className="flex-1 rounded-md border border-slate px-2 py-1 text-sm outline-none focus:border-ink"
        />
        <button onClick={addStatus} disabled={!newLabel.trim()}
          className="rounded-md border border-slate px-3 py-1 text-xs disabled:opacity-50">
          Add
        </button>
      </div>

      <div className="mt-4 flex items-center gap-3">
        <button onClick={() => void save()} disabled={busy}
          className="rounded-md border border-ink bg-ink px-4 py-2 text-sm text-white disabled:opacity-50">
          Save statuses
        </button>
        {busy && <Spinner label="Saving…" />}
        {note && <span className="text-xs text-ink/60">{note}</span>}
      </div>

      {error && (
        <div className="mt-3 rounded-md border border-slate p-3 text-sm text-[#92400E]">
          {error}
        </div>
      )}
    </div>
  );
}
```

> **Ordering is deliberate and the confirm copy is load-bearing.** Reassign-then-save means a failure in between leaves rows on a key still in the list — consistent, and recoverable. The reverse order orphans them. But "consistent" is not "harmless": the `UPDATE` lands, the save fails, the banner says "save failed", and the user reads that as *nothing happened* while N rows of hand-entered triage have been relabeled with no undo and no backups. `jobs.status` is the only user-authored column in this app. So the confirm must state the row count and the irreversibility, and the result must report how many rows actually moved.

Error handling throughout: branch on **presence**, and render `describeWriteFailure(err, "save your statuses")`.

- [ ] **Step 2: Render it in `Settings.tsx`**

Add `<StatusEditor initial={view.statuses} />` as its own card, after the existing sections. It reads `view.statuses` (Task 2) and touches no `Draft` field.

- [ ] **Step 3: Run the gate**

Run: `npm run build && npm test`

- [ ] **Step 4: Verify the whole feature by hand**

With `npm run dev`:
1. Rename "Applied" to "Submitted", save, go to `/roles` — the chip and dropdown read "Submitted"; move a role onto it and confirm `applied_date` still stamps in the expanded row.
2. Hide "Exec Presentation", save — it leaves the chip row and the dropdown, but a role already on it still displays it.
3. Add "Take-home" with bucket Open, save — it appears in the dropdown and the chip row.
4. Delete a status holding rows — confirm the count is named, the replacement list does **not** offer "New", and the reported moved-count matches.
5. Confirm the bucket select is disabled for New and Posting Closed.

- [ ] **Step 5: Commit**

```bash
git add components/StatusEditor.tsx components/Settings.tsx
git commit -m "feat: status editor on /settings — rename, reorder, hide, add, delete"
```

---

### Task 8: Retire the constants

**Files:**
- Modify: `lib/types.ts`
- Modify: `lib/job-statuses.test.ts`

> **Read this before deleting.** The parity test in Task 1 asserts `DEFAULT_STATUSES` against `JOB_STATUSES` / `ACTIVE_STATUSES` / `TERMINAL_STATUSES`. Deleting those arrays removes the independent source that test checks against. That is the "regenerating a fixture blesses whatever the code emits" hazard CLAUDE.md warns about, so do it in this order: **run the parity test and see it pass first**, then delete the arrays, then replace only the parity assertion with the frozen literal below. The remaining twelve tests are unaffected.

- [ ] **Step 1: Confirm nothing still imports the arrays**

Run:
```bash
grep -rn "JOB_STATUSES\|ACTIVE_STATUSES\|TERMINAL_STATUSES" app components lib | grep -v job-statuses
```
Expected: only `lib/types.ts` itself and `lib/job-statuses.test.ts`. Anything else means Task 5 or 6 is incomplete — stop.

- [ ] **Step 2: Run the parity test one last time**

Run: `npx vitest run lib/job-statuses.test.ts -t "reproduces today's list"`
Expected: PASS. This is the last moment the assertion has an independent source.

- [ ] **Step 3: Freeze the parity assertion**

Replace that one test in `lib/job-statuses.test.ts`:

```ts
  // Frozen 2026-08-17. Until this commit these three lists were imported from
  // lib/types.ts and compared against the real thing; that source is now gone,
  // so this literal is the record of what the app did before statuses became
  // editable. Do NOT regenerate it from DEFAULT_STATUSES — that would bless
  // whatever the code currently emits, which is the whole point of the pin.
  const SHIPPED_ORDER = [
    "New", "Applied", "Recruiter Outreach", "Phone / Intro Screen",
    "Hiring Manager", "Panel Interviews", "Exec Presentation",
    "Reference Check", "Offer", "Not Interested", "Rejected", "Passed",
    "Posting Closed",
  ];
  const SHIPPED_TERMINAL = ["Not Interested", "Rejected", "Passed", "Posting Closed"];

  it("reproduces the pre-feature list, order, and buckets exactly", () => {
    expect(keys(DEFAULT_STATUSES)).toEqual(SHIPPED_ORDER);
    expect(terminalKeys(DEFAULT_STATUSES).sort()).toEqual([...SHIPPED_TERMINAL].sort());
  });
```

Remove the `import { ACTIVE_STATUSES, JOB_STATUSES, TERMINAL_STATUSES } from "./types";` line.

- [ ] **Step 4: Narrow the union and delete the arrays**

In `lib/types.ts`, delete `JOB_STATUSES`, `ACTIVE_STATUSES`, and `TERMINAL_STATUSES`, and replace the thirteen-member `JobStatus` union with:

```ts
/**
 * The statuses code reads and writes BY NAME. No longer the full list — the
 * user's list lives in app_settings and is resolved by lib/job-statuses.ts.
 * `Job.status` below is `string` because it can hold any key the user defined.
 */
export type JobStatus = SystemStatusKey;
```

Import `SystemStatusKey` from `@/lib/job-statuses`. Leave `Job.status` as-is (`JobStatus | string` already permits any key). Leave `PipelineStatus` alone — it is unrelated and has zero consumers.

- [ ] **Step 5: Run the gate**

Run: `npm run build && npm test`
Expected: both green.

- [ ] **Step 6: Commit**

```bash
git add lib/types.ts lib/job-statuses.test.ts
git commit -m "refactor: retire the hardcoded status arrays; JobStatus is now the system keys"
```

---

### Task 9: Correct CLAUDE.md

**Files:**
- Modify: `CLAUDE.md`

> CLAUDE.md's "Status/filter machinery is constant-driven" paragraph becomes **actively wrong** with Task 8, including its instruction "to add a status: extend the union + arrays + the `STATUS_STYLES` badge map". That is the instruction a future session will follow. It must be corrected in the same branch, not later.

- [ ] **Step 1: Replace the paragraph**

```markdown
**Status/filter machinery is USER-EDITABLE**, stored as one `app_settings` row
under `JOB_STATUSES_KEY` and resolved by `resolveStatuses` in
`lib/job-statuses.ts`. To change the list, edit it on `/settings` — do not touch
code. `jobs.status` stores the **key**, which is immutable; the label is
presentation only, so a rename rewrites no rows. `JobStatus` in `lib/types.ts`
is now just `SystemStatusKey` — the three statuses code reads or writes by name
(`New`, `Applied`, `Posting Closed`), two of which are matched in raw SQL
(`lib/crawler.ts`, `lib/removed-titles.ts`) and one of which is the column
default in `db/schema.sql`. Those three cannot be renamed, hidden, or deleted,
and `New` is never a reassignment target. The `STATUS_STYLES` badge map lives in
`components/RolesTable.tsx` and **must stay under `components/`**:
`tailwind.config.ts` scans `./app/**` and `./components/**` only, so an
arbitrary-value class in `lib/` is never generated and renders unstyled through
a green build. A test pins that.
```

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: CLAUDE.md's status paragraph now describes the editable config"
```

---

## Verification

Full gate after every task: `npm run build && npm test`.

Before deploying, re-run the scale check the spec asks for, because the "no data migration required" claim rests on it:

```sql
select status, count(*) from jobs group by status order by count(*) desc;
```

Every value returned must appear in `SHIPPED_ORDER`. Anything else is a legacy or hand-edited row — it will render verbatim and bucket Open, which is intended, but you should know it exists before shipping.
