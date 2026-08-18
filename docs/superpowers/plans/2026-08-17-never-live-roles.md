# Never-live roles Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop roles that were already dead when the app first found them from appearing in the `/roles` table or in either tile count, without deleting the rows the dedupe depends on.

**Architecture:** A `never_live` boolean column on `jobs`, written at ingest ONLY when `checkJobUrl` returned a definitive `"dead"`. One pure module decides what that means for a read; `getJobs` applies it and returns the count it removed; `RolesTable` prints that count under the tiles. The user-editable status machinery (`lib/job-statuses.ts`) is not touched at all — that it needs no edit is the evidence the change is contained.

**Tech Stack:** Next.js 14 App Router, TypeScript, Postgres via `pg` (through the hand-rolled `lib/supabase.ts` builder), vitest.

**Spec:** `docs/superpowers/specs/2026-08-17-never-live-roles-design.md`

## Global Constraints

- Verification gate is `npm run build && npm test`. **`npm run lint` is non-functional in this repo — never add it to the gate.**
- `lib/__fixtures__/fit-prompt.no-floor.txt`, `.with-floor.txt` and `.empty-blocks.txt` must stay **byte-identical**. Nothing in this plan touches fit scoring; a diff in any of them means something went wrong.
- `lib/job-statuses.ts` and `lib/job-statuses.test.ts` must NOT be modified by any task in this plan.
- Errors are `{ error?: string }` and the string CAN BE EMPTY. Detect by PRESENCE (`describeWriteFailure(...) !== undefined`), never by truthiness. See `.claude/skills/swallowed-string-errors`.
- `lib/never-live.ts` must not import `lib/supabase.ts` directly or transitively — it is reached from the `"use client"` `RolesTable` via `app/actions/jobs.ts` types, and `supabase` pulls in `pg`.
- Branch: `never-live-roles`. Commit after every task.
- Deploy order is schema-first and non-negotiable (Task 6).

---

### Task 1: The column, the type, and the pure rule

**Files:**
- Modify: `db/schema.sql:91` (after the `source_url` alter)
- Modify: `lib/types.ts:115-119` (inside `interface Job`)
- Create: `lib/never-live.ts`
- Test: `lib/never-live.test.ts`

**Interfaces:**
- Consumes: `Job` from `@/lib/types`.
- Produces: `partitionNeverLive(jobs: Job[]): { visible: Job[]; hiddenCount: number }` — used by Task 3. Also `Job.never_live: boolean`, used by Tasks 2 and 3.

- [ ] **Step 1: Write the failing test**

Create `lib/never-live.test.ts`:

```ts
import { describe, expect, test } from "vitest";
import { partitionNeverLive } from "./never-live";
import type { Job } from "@/lib/types";

// Only the two fields the partition reads. Cast rather than building a full
// 30-field Job: a fixture that big would obscure what each case varies.
const job = (id: string, never_live: unknown): Job =>
  ({ id, company: "Clay", role_title: "RevOps Manager", never_live }) as unknown as Job;

describe("partitionNeverLive", () => {
  test("removes rows flagged never_live and counts them", () => {
    const res = partitionNeverLive([job("a", false), job("b", true), job("c", false)]);

    expect(res.visible.map((j) => j.id)).toEqual(["a", "c"]);
    expect(res.hiddenCount).toBe(1);
  });

  test("keeps rows read before the migration, where the column is undefined", () => {
    // A row selected from a database that has not had the column added yet
    // arrives with no such key. It must stay VISIBLE: failing open shows a row
    // that should have been hidden, failing closed hides a live role with
    // nothing on screen to explain it.
    const res = partitionNeverLive([job("a", undefined), job("b", null)]);

    expect(res.visible.map((j) => j.id)).toEqual(["a", "b"]);
    expect(res.hiddenCount).toBe(0);
  });

  test("preserves the order of the rows it keeps", () => {
    const res = partitionNeverLive([job("a", false), job("b", true), job("c", false), job("d", false)]);

    expect(res.visible.map((j) => j.id)).toEqual(["a", "c", "d"]);
  });

  test("an empty list hides nothing", () => {
    expect(partitionNeverLive([])).toEqual({ visible: [], hiddenCount: 0 });
  });

  test("every row hidden still returns a usable shape", () => {
    const res = partitionNeverLive([job("a", true), job("b", true)]);

    expect(res.visible).toEqual([]);
    expect(res.hiddenCount).toBe(2);
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `npx vitest run lib/never-live.test.ts`
Expected: FAIL — `Failed to resolve import "./never-live"`.

- [ ] **Step 3: Add the column to the schema**

In `db/schema.sql`, immediately after the `source_url` alter (line 91), add:

```sql
-- A role that was ALREADY dead when ingest first saw it — checkJobUrl returned
-- a definitive 404/410 at save time, so it was stored closed and never scored.
-- It is noise, not history: the user never had the option to apply. Hidden from
-- the table and both tiles by getJobs, but never DELETED — ingestRoles dedupes
-- against every row regardless of status, so deleting these makes the next Find
-- Roles run re-find and re-insert them permanently.
--
-- Deliberately narrower than the condition that CLOSES a role: `unlisted` (the
-- employer's guessed board does not list the title) also closes, but does not
-- hide. See lib/ingest-roles.ts.
alter table jobs add column if not exists never_live boolean not null default false;
```

- [ ] **Step 4: Add the field to the Job type**

In `lib/types.ts`, inside `interface Job`, immediately after the `source_url` field and its comment (line 115):

```ts
  /**
   * The role was already dead the first time ingest saw it — a definitive
   * 404/410 from checkJobUrl at save time. Hidden from the table and both
   * tiles; see lib/never-live.ts. Rows read from a database that predates the
   * column arrive without this key, which partitionNeverLive treats as false.
   */
  never_live: boolean;
```

- [ ] **Step 5: Write the module**

Create `lib/never-live.ts`:

```ts
// Which jobs the table never shows.
//
// NO import of lib/supabase.ts, directly or transitively — this is reached from
// the "use client" RolesTable through app/actions/jobs.ts, and supabase pulls
// in `pg`. Same hazard documented at lib/job-statuses.ts.

import type { Job } from "@/lib/types";

/**
 * Splits the rows the table shows from the ones it never does.
 *
 * The check is `=== true`, not truthiness, and that direction is deliberate: a
 * row selected before the column existed arrives with `never_live` undefined,
 * and the failure that shows a row which should have been hidden is far
 * cheaper than the one that hides a live role with nothing on screen to
 * explain where it went.
 *
 * Returns the COUNT rather than the hidden rows themselves. Nothing renders
 * them, and handing back an array invites a caller to start.
 */
export function partitionNeverLive(jobs: Job[]): {
  visible: Job[];
  hiddenCount: number;
} {
  const visible = jobs.filter((j) => j.never_live !== true);
  return { visible, hiddenCount: jobs.length - visible.length };
}
```

- [ ] **Step 6: Run the test and watch it pass**

Run: `npx vitest run lib/never-live.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 7: Run the full gate**

Run: `npm run build && npm test`
Expected: build clean (the typecheck runs inside it), all tests pass. `never_live` is a REQUIRED field on `Job`, and that is expected to compile: the repo contains no full `Job` object literal anywhere — every construction site is either an `as Job[]` cast off a database row (`app/actions/jobs.ts`, `app/actions/link-health.ts`) or a structural `Pick`-shaped parameter (`salaryBucketFor` takes `{ salary_range: string | null }`). **If the build does report a literal missing the field, add `never_live: false` to that literal — do not widen the type to optional to make the error go away.**

- [ ] **Step 8: Commit**

```bash
git add db/schema.sql lib/types.ts lib/never-live.ts lib/never-live.test.ts
git commit -m "feat: never_live column and the pure rule for hiding those rows"
```

---

### Task 2: Record it at ingest, on the definitive signal only

**Files:**
- Modify: `lib/ingest-roles.ts:138-160` (inside the `fresh.map` in `ingestRoles`)
- Test: `lib/ingest-roles.test.ts` (extend the existing harness)

**Interfaces:**
- Consumes: `Job.never_live` from Task 1. `JobInsert` picks the field up automatically through its existing `Partial<Omit<Job, "id" | "created_at" | "updated_at">>`, so no change to `JobInsert` is needed.
- Produces: nothing new. Task 3 depends on the column being written, not on any symbol from here.

**Background the implementer needs.** `ingestRoles` closes a role on two different signals, combined today into one `isDead`:

1. `urlStatuses[i] === "dead"` — `checkJobUrl` got a definitive 404 or 410. (403s and timeouts return `"unknown"` and do NOT count; job boards block bots.)
2. `links[i].unlisted` — `upgradeLink` found the employer's board by GUESSING a slug from the company name, and the board does not list this title.

Only (1) sets `never_live`. `repairJobLinks` (`app/actions/link-health.ts`) already refuses to close a role on signal (2) because a slug collision would kill a live role against a stranger's board; hiding on an inference is worse than closing on one, because `ingestRoles`' dedupe stops the next run re-finding it, so a wrong guess disappears a live role permanently.

- [ ] **Step 1: Make the existing test harness able to vary the two signals**

In `lib/ingest-roles.test.ts`, replace the `vi.hoisted` block and the `verify-url` mock, and add a `resolve-job-link` mock. The existing mock returns the string `"alive"`, which is not a member of `UrlStatus` (`"live" | "dead" | "unknown"`) — it worked only because the mock is untyped. Use the real member.

Replace lines 7-12 (the `vi.hoisted` block):

```ts
const h = vi.hoisted(() => ({
  addJobResult: { job: undefined, error: undefined } as {
    job?: { id: string };
    error?: string;
  },
  // The two independent signals ingestRoles closes a role on. Defaults are the
  // healthy path, so every pre-existing test in this file keeps its meaning.
  urlStatus: "live" as "live" | "dead" | "unknown",
  resolved: null as {
    url: string;
    vendor: string;
    slug: string;
    precision: "posting" | "absent" | "ambiguous";
  } | null,
}));
```

Replace line 28 (the `verify-url` mock) with both mocks:

```ts
vi.mock("@/lib/verify-url", () => ({ checkJobUrl: vi.fn(async () => h.urlStatus) }));
// Not mocked before: ROLE's example.com link classifies as "other", so
// upgradeLink returned early and never reached this module. The unlisted case
// below uses an aggregator link, which does reach it.
vi.mock("@/lib/resolve-job-link", () => ({
  resolveEmployerLink: vi.fn(async () => h.resolved),
}));
```

And extend `beforeEach` (line 51) to reset them:

```ts
beforeEach(() => {
  h.addJobResult = { job: undefined, error: undefined };
  h.urlStatus = "live";
  h.resolved = null;
  vi.clearAllMocks();
});
```

- [ ] **Step 2: Write the failing tests**

Append to `lib/ingest-roles.test.ts`:

```ts
import { addJob } from "@/app/actions/jobs";

/** The payload of the only addJob call this ingest made. */
const insertedRow = () => vi.mocked(addJob).mock.calls[0][0];

// never_live is NARROWER than the condition that closes a role, and the gap is
// the whole point. A guessed board slug is not proof a posting never existed,
// and a hidden row can never come back: ingestRoles' dedupe reads every row
// regardless of status, so the next run skips it as already seen.
describe("never_live records only the definitive death signal", () => {
  test("a role whose URL 404s is stored closed AND flagged never_live", async () => {
    h.addJobResult = { job: { id: "job-1" } };
    h.urlStatus = "dead";

    await ingestRoles(OPTS);

    expect(insertedRow().status).toBe("Posting Closed");
    expect(insertedRow().never_live).toBe(true);
  });

  test("a role missing from the employer's guessed board is closed but NOT flagged", async () => {
    h.addJobResult = { job: { id: "job-1" } };
    h.urlStatus = "live";
    h.resolved = {
      url: "https://job-boards.greenhouse.io/clay",
      vendor: "greenhouse",
      slug: "clay",
      precision: "absent",
    };

    // An aggregator link, so upgradeLink actually consults the board. ROLE's
    // own example.com link classifies as "other" and would return early.
    await ingestRoles({
      ...OPTS,
      roles: [{ ...ROLE, job_url: "https://www.builtin.com/job/12345" }],
    });

    expect(insertedRow().status).toBe("Posting Closed");
    expect(insertedRow().never_live).toBe(false);
  });

  test("a live role is stored New and not flagged", async () => {
    h.addJobResult = { job: { id: "job-1" } };

    await ingestRoles(OPTS);

    expect(insertedRow().status).toBe("New");
    expect(insertedRow().never_live).toBe(false);
  });

  test("a role found dead is still not fit-scored", async () => {
    h.addJobResult = { job: { id: "job-1" } };
    h.urlStatus = "dead";

    await ingestRoles(OPTS);

    expect(vi.mocked(scoreFit)).not.toHaveBeenCalled();
  });
});
```

Add `scoreFit` to the existing imports so the last test can assert on it:

```ts
import { scoreFit } from "@/app/actions/parse-role";
```

- [ ] **Step 3: Run the tests and watch them fail**

Run: `npx vitest run lib/ingest-roles.test.ts`
Expected: the three `never_live` assertions FAIL with `expected undefined to be true` / `to be false`. The `status` and `scoreFit` assertions already pass — they pin behaviour this task must NOT change.

- [ ] **Step 4: Split the two signals at the write site**

In `lib/ingest-roles.ts`, replace the `isDead` line and its comment (lines 138-140):

```ts
      // Two independent ways to already be closed: the link 404s, or the
      // employer's own board does not list the role. The second is what
      // actually catches reseller links, which rarely 404.
      const deadUrl = urlStatuses[i] === "dead";
      const isDead = deadUrl || links[i].unlisted;
```

and add the field to the `addJob` call, immediately after `status` (line 145):

```ts
        status: isDead ? "Posting Closed" : "New",
        // NARROWER than isDead, deliberately. `unlisted` means a board found by
        // GUESSING a slug from the company name did not list this title —
        // link-health already refuses to CLOSE a role on that signal, and
        // hiding on it is worse: the dedupe above reads every row regardless of
        // status, so a hidden row can never be re-found. A wrong guess would
        // disappear a live role permanently, with nothing on screen.
        never_live: deadUrl,
```

- [ ] **Step 5: Run the tests and watch them pass**

Run: `npx vitest run lib/ingest-roles.test.ts`
Expected: PASS, all tests including the four pre-existing insert-failure ones.

- [ ] **Step 6: Run the full gate**

Run: `npm run build && npm test`
Expected: build clean, all tests pass, no fixture diff.

- [ ] **Step 7: Commit**

```bash
git add lib/ingest-roles.ts lib/ingest-roles.test.ts
git commit -m "feat: flag roles found already dead at ingest, on the 404 signal only"
```

---

### Task 3: Hide them at the read boundary, and say how many

**Files:**
- Modify: `app/actions/jobs.ts:11-24` (`getJobs`)
- Modify: `components/RolesTable.tsx:182` (state), `:261` (load), `:746-768` (the funnel block)

**Interfaces:**
- Consumes: `partitionNeverLive` from Task 1.
- Produces: `getJobs(): Promise<{ jobs: Job[]; hiddenCount: number; error?: string }>` — one added field. `RolesTable` is its only caller.

**Why the filter is here and not in SQL.** `getJobs` is the only reader that feeds the table, and `tileCounts` in `RolesTable` derives from the same array, so one partition removes these rows from the table AND both tiles. Partitioning in TypeScript rather than adding `.eq("never_live", false)` gets the count with no second round trip and leaves the query untouched. The other readers of `jobs` already skip these rows for their own reasons: `repairJobLinks` filters `bucketFor(...) !== "terminal"` (`app/actions/link-health.ts:91`), `rescoreAll` selects `fit_score is not null` (`lib/rescore-scope.ts`), and the crawler matches `status = 'New'` in raw SQL.

- [ ] **Step 1: Change getJobs**

In `app/actions/jobs.ts`, add the import:

```ts
import { partitionNeverLive } from "@/lib/never-live";
```

and replace the body of `getJobs` (lines 11-24):

```ts
export async function getJobs(): Promise<{
  jobs: Job[];
  hiddenCount: number;
  error?: string;
}> {
  // Session required. Server Actions are RPC endpoints addressed by an ID that
  // ships in the client bundle, so a page-level check does not cover them.
  await requireActor();
  const { data, error } = await supabase.forTenant(await resolveTenantId())
    .from("jobs")
    .select("*")
    .order("created_at", { ascending: false });

  if (error) {
    console.error("getJobs error:", error);
    return { jobs: [], hiddenCount: 0, error: error.message };
  }
  // Roles that were already dead when ingest first saw them never reach the
  // table or either tile — RolesTable derives tileCounts from this same array.
  // The rows still EXIST; ingestRoles' dedupe depends on it. The count is
  // returned so the page can say how many it dropped rather than leaving
  // "73 in the database, 58 on screen" as a mystery.
  const { visible, hiddenCount } = partitionNeverLive((data as Job[]) ?? []);
  return { jobs: visible, hiddenCount };
}
```

- [ ] **Step 2: Hold the count in RolesTable**

After the `jobs` state declaration (`components/RolesTable.tsx:182`):

```ts
  const [jobs, setJobs] = useState<Job[]>([]);
  // Rows getJobs dropped because they were already dead when found. Set only
  // from a load — the optimistic edits below cannot change it, since none of
  // those rows is in `jobs` to edit.
  const [hiddenCount, setHiddenCount] = useState(0);
```

- [ ] **Step 3: Adopt it only on a successful read**

In `load()`, in the `if (res.ok)` branch, immediately after `setJobs(res.r.jobs)` (line 261):

```ts
        setJobs(res.r.jobs);
        setHiddenCount(res.r.hiddenCount);
```

It belongs inside this branch, next to `setJobs`, for the same reason `setJobs` is here: `res.ok` only means the action returned rather than threw. A connection-level failure returns `jobs: []` with an EMPTY error message, and the line above it already reads that failure by PRESENCE via `describeWriteFailure`. Adopting the count outside this branch would print a stale number over a failed load.

- [ ] **Step 4: Render the line under the tiles**

In the funnel block, after the closing `</div>` of the grid (`components/RolesTable.tsx:768`) and before the controls comment:

```tsx
      </div>

      {hiddenCount > 0 && (
        // Not a tile and not clickable: these rows are not a filter the user
        // can enter. The number exists so the table's total is explicable.
        <p className="-mt-4 mb-6 text-xs text-ink/50">
          {hiddenCount} hidden — found already closed
        </p>
      )}
```

- [ ] **Step 5: Run the full gate**

Run: `npm run build && npm test`
Expected: build clean, all tests pass. The build is what proves `getJobs`' new return shape has no unhandled caller.

- [ ] **Step 6: Commit**

```bash
git add app/actions/jobs.ts components/RolesTable.tsx
git commit -m "feat: hide never-live roles from the table and both tiles"
```

---

### Task 4: The one-shot back-fill script

**Files:**
- Create: `db/backfill-never-live.mjs`

**Interfaces:**
- Consumes: the `never_live` column from Task 1.
- Produces: nothing importable. Run by hand, once, in Task 6.

**Why a script and not a line in `db/schema.sql`.** `schema.sql` is idempotent and re-applied routinely. A back-fill `UPDATE` living there would be re-evaluated against future data forever, re-deciding history under a predicate that was verified against exactly 15 rows on 2026-08-17.

**Why these three conditions.** Verified against production before this plan was written: `status = 'Posting Closed' AND fit_score IS NULL` matches 15 rows, and all 15 independently satisfy `updated_at = created_at` (inserted and never touched again — the ingest signature). The 14 scored `Posting Closed` rows were all touched hours-to-days later, which is the crawler / link-health signature. No row anywhere else in the table carries a null `fit_score`. The timestamp condition is redundant against today's data and kept anyway: it is a second, independent signal, and a back-fill is not re-runnable in any meaningful sense.

**Known limit, deliberate.** Ingest never recorded WHICH signal closed a row, so this hides all 15 under a rule the code no longer applies — 13 are structurally provable 404s (`databricks.com`, `job-boards.greenhouse.io`, `jobs.lever.co`, `themuse.com`; none is in `AGGREGATOR_HOSTS`, so `upgradeLink` returned early and `unlisted` was impossible), and the 2 `builtin.com` rows are ambiguous. Accepted in the spec.

- [ ] **Step 1: Write the script**

Create `db/backfill-never-live.mjs`:

```js
// One-shot back-fill: flags the roles that were already dead when ingest first
// saw them, for rows inserted before the never_live column existed.
//
// Usage (dry run, prints the rows and changes nothing):
//   railway run --service Postgres node db/backfill-never-live.mjs
// Then, to write:
//   railway run --service Postgres node db/backfill-never-live.mjs --apply
//
// `railway run` injects the PRIVATE DATABASE_URL (postgres.railway.internal),
// which is IPv6-only and unreachable from a laptop — hence the PUBLIC url
// first. Reversed, this connects to nothing and the failure is silent.
import pg from "pg";

const url = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;
if (!url) {
  console.error("Set DATABASE_PUBLIC_URL (or DATABASE_URL) before running.");
  process.exit(1);
}

const apply = process.argv.includes("--apply");

// The one definition of "was already dead when we found it", for rows that
// predate the column. Three conditions, two of them independent signals:
// unscored (ingest skips scoring for a dead role) and never touched after
// insert (the crawler and link-health both stamp updated_at when they close a
// role). `never_live = false` makes a re-run a no-op.
const PREDICATE = `
  status = 'Posting Closed'
  and fit_score is null
  and updated_at = created_at
  and never_live = false`;

const client = new pg.Client({
  connectionString: url,
  ssl: /sslmode=require/.test(url) ? { rejectUnauthorized: false } : undefined,
});

// ALWAYS print the error channel, never just the rows: `pg` rejects with an
// AggregateError whose message is the EMPTY STRING when every address of a
// dual-stack host refuses, and four such failures once read as "empty tables".
try {
  await client.connect();
} catch (e) {
  console.error(`Connect failed: name=${e?.name} message=${JSON.stringify(e?.message)}`);
  for (const sub of e?.errors ?? []) {
    console.error(`  cause: ${sub?.code} ${JSON.stringify(sub?.message)}`);
  }
  process.exit(1);
}

try {
  const { rows } = await client.query(
    `select id, company, role_title, source,
            to_char(created_at, 'YYYY-MM-DD HH24:MI') as created
       from jobs where ${PREDICATE} order by created_at`
  );

  console.log(`\n${rows.length} row(s) match:`);
  for (const r of rows) {
    console.log(`  ${r.created}  ${r.company} — ${r.role_title}  (${r.source})`);
  }

  if (!apply) {
    console.log("\nDry run. Nothing written. Re-run with --apply to flag these rows.");
  } else if (rows.length === 0) {
    console.log("\nNothing to do.");
  } else {
    const res = await client.query(`update jobs set never_live = true where ${PREDICATE}`);
    if (res.rowCount !== rows.length) {
      console.error(
        `MISMATCH: selected ${rows.length} rows but updated ${res.rowCount}. ` +
          `Investigate before trusting the tiles.`
      );
      process.exitCode = 1;
    } else {
      console.log(`\nFlagged ${res.rowCount} row(s) never_live.`);
    }
  }
} catch (e) {
  console.error(`Query failed: name=${e?.name} message=${JSON.stringify(e?.message)}`);
  process.exitCode = 1;
} finally {
  await client.end();
}
```

- [ ] **Step 2: Verify it parses without touching the database**

Run: `node --check db/backfill-never-live.mjs`
Expected: no output, exit 0. (It is a one-shot operational script, not application code — it has no unit test, the same as `db/apply-schema.mjs` and `db/backup.mjs`.)

- [ ] **Step 3: Run the full gate**

Run: `npm run build && npm test`
Expected: unchanged from Task 3 — this file is outside the Next.js build and the vitest globs.

- [ ] **Step 4: Commit**

```bash
git add db/backfill-never-live.mjs
git commit -m "chore: one-shot back-fill for never_live rows"
```

---

### Task 5: Document it in CLAUDE.md

**Files:**
- Modify: `CLAUDE.md` (the paragraph beginning "**Job links rot, and half of them were second-hand.**")

**STOP — this task needs the user's explicit confirmation before editing.** The user's global instruction is "Never modify CLAUDE.md without explicit confirmation." Ask, show the paragraph below, and only then write it. If the user declines, skip this task entirely and note it in the handoff.

- [ ] **Step 1: Ask for confirmation, showing the exact text**

- [ ] **Step 2: Add the paragraph after the "Job links rot" section**

```markdown
**A role that was already dead when we found it is hidden, not deleted.**
`ingestRoles` closes a role on two signals — a definitive 404/410 from
`checkJobUrl`, or `unlisted` (the employer's guessed board does not list the
title) — but only the FIRST sets `jobs.never_live`. `partitionNeverLive`
(`lib/never-live.ts`) drops those rows in `getJobs`, which removes them from
the `/roles` table and from BOTH tiles at once, since `tileCounts` derives from
the same array; the count comes back as `hiddenCount` and renders as one muted
line under the tiles. The rows must never be DELETED: `ingestRoles` dedupes
against every existing row for the company regardless of status, so deleting
them makes the next Find Roles run re-find, re-verify and re-insert the same
dead postings permanently. Hiding on `unlisted` was rejected for the same
reason `repairJobLinks` refuses to CLOSE on it — the board is found by guessing
a slug, and a collision would disappear a live role with no way to get it back.
This is deliberately NOT a fourth `SystemStatusKey`: "never live" is a
provenance fact stamped at insert, not a workflow state, and a new system
status would collide with `resolveStatuses`' `hidden: false` rule and force a
third `StatusBucket` through `bucketFor`, `tileCounts`, the Open/Out filters and
`link-health.ts`. Design:
`docs/superpowers/specs/2026-08-17-never-live-roles-design.md`.
```

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: record the never-live hiding rule and why it is not a status"
```

---

### Task 6: Deploy — schema first, then back-fill, then code

**Files:** none. This task runs commands against production.

**STOP — every step here needs the user driving or watching.** Step 2 writes production data and Step 4 ships. Do not run Step 2 or Step 4 without the user saying go.

**Order is load-bearing.** Applying the schema against the running build is inert: the column defaults to `false` and no deployed code reads or writes it. Deploying the CODE first is not — every `addJob` insert would fail against a table with no `never_live` column, breaking all three ingest paths (Find Roles, role search, the crawler).

- [ ] **Step 1: Apply the migration to production**

```bash
railway run --service Postgres node db/migrate.mjs
```

Run the migration runner, not `db/apply-schema.mjs`. `db/schema.sql:82` still
contains `create table if not exists insights_cache`, a table
`db/migrations/006_drop_insights.sql` has since DROPPED — `apply-schema.mjs`
would re-create it with no `tenant_id` column and no `tenant_isolation`
policy, since migration 003's policy loop has already run. `db/migrate.mjs`
applies only the pending, ledgered file (`008_never_live.sql`) and is a no-op
against everything already applied.

Expected: `migrate: pending -> 008_never_live.sql` followed by
`migrate: applying 008_never_live.sql ... ok` and `migrate: done`.

- [ ] **Step 2: Back-fill, dry run first**

```bash
railway run --service Postgres node db/backfill-never-live.mjs
```

Expected: `15 row(s) match:` followed by 9 Databricks rows plus AgentSync,
DaVita, dbt Labs, Groq, Workiva and Wpromote. **If the count is not 15, stop and
show the user before applying** — the predicate was verified against exactly
this data on 2026-08-17.

Then, with the user's go-ahead:

```bash
railway run --service Postgres node db/backfill-never-live.mjs --apply
```

Expected: `Flagged 15 row(s) never_live.`

- [ ] **Step 3: Merge the branch**

Follow `superpowers:finishing-a-development-branch`. `main` must end up carrying
this work: the `web` service rebuilds from `tkeefe66/gtm-job-search` `main` on
every variable change, so a `railway up` that bypassed `main` gets silently
reverted later.

- [ ] **Step 4: Push and confirm what actually deployed**

```bash
git push origin main
railway deployment list --service web --limit 1 --json | grep -i commitHash
git rev-parse origin/main
```

Expected: the two hashes match. **Verify against the DEPLOYED commit, not the
local one** — a rotation was once reported as verified against a build that did
not contain the route it guarded.

- [ ] **Step 5: Verify on the live site**

Load `/roles` (behind the `GATE_TOKEN` password) and confirm:

- Tiles read **23 open / 35 out** (from 23 / 50).
- The line **"15 hidden — found already closed"** sits under them.
- 58 rows in the table with the "All" status filter selected.
- The Out filter shows 21 `Not Interested` plus 14 `Posting Closed`, and none of
  the 14 has an empty fit score — every remaining closed row was scored while it
  was live.

---

## Self-Review

**Spec coverage:** §1 schema → Task 1 Step 3. §2 write site → Task 2. §3 type →
Task 1 Step 4. §4 read boundary → Task 1 (module) + Task 3 Step 1. §5 UI → Task 3
Steps 2-4. §6 back-fill → Task 4 + Task 6 Step 2. §7 tests → Tasks 1 and 2. §8
deploy order → Task 6. Non-goals: no task touches `lib/job-statuses.ts`, the fit
prompt, or `isDead`'s closing condition; no un-hide UI is built.

**Placeholders:** none — every code step carries the literal text to write.

**Type consistency:** `partitionNeverLive(jobs: Job[]) → { visible, hiddenCount }`
is defined in Task 1 and consumed under those exact names in Task 3.
`Job.never_live: boolean` is defined in Task 1 and written in Task 2 through
`JobInsert`'s existing `Partial<Omit<…>>`. `getJobs`' new `hiddenCount` field is
produced in Task 3 Step 1 and read in Task 3 Step 3 under the same name.
