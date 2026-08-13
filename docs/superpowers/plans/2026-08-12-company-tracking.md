# Company Tracking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user track any company by name and have its careers page crawled on a recurring schedule until they stop tracking it, with newly-found roles auto-added to the Roles table and fit-scored.

**Architecture:** The existing `watchlist` table becomes the tracking store. A crawler tries a plain HTTP fetch of the careers page and extracts roles from the fetched text with a single non-search Claude call; if the page is a JS-rendered ATS shell it falls back to the existing `web_search` path. A Railway cron service calls an authenticated Next route handler daily, which crawls up to 10 due companies. The same `crawlCompany` function backs a manual "Check now" button.

**Tech Stack:** Next.js 14 App Router, TypeScript, Tailwind, Railway Postgres via the hand-rolled query builder in `lib/supabase.ts`, Anthropic SDK, vitest (new).

Spec: `docs/superpowers/specs/2026-08-12-company-tracking-design.md`

## Global Constraints

- **No ATS vendor APIs and no job aggregator APIs.** Careers pages are treated as ordinary web pages. This is a hard product constraint, not a preference.
- **The gate is `npm run build && npm test`.** `npm run build` includes typecheck. **Do NOT run or attempt to fix `npm run lint`** — the repo has no ESLint config and `next lint` blocks on an interactive setup prompt. Adding a config makes `next build` run ESLint, and 3 pre-existing errors then fail the build. Fixing that is out of scope for every task in this plan. Where a task's steps say to run `npm run lint`, run `npm run build && npm test` instead.
- **All backend logic lives in React Server Actions** in `app/actions/`, except the single cron route added by Task 8. There are no other API routes.
- **`lib/supabase.ts` is NOT Supabase** — it is a hand-rolled Supabase-shaped builder over `pg`. Supported surface: `.from .select .insert .update .upsert .delete .eq .neq .order .limit .single .maybeSingle`. There is no `.lt()`, `.gt()`, or `.in()`. Task 2 adds a raw-query escape hatch for anything beyond that surface.
- **Schema truth is `db/schema.sql`**, applied with `DATABASE_URL=postgres://... node db/apply-schema.mjs`. It must stay idempotent — every statement re-runnable.
- **`supabase/migrations/` is legacy.** Do not add migrations there.
- **Deploy target is Railway only**, project `gtm-job-search`, service `web`. Confirm the service before the first deploy.
- **Model constant is `claude-sonnet-4-6`** via `MODEL` in `lib/anthropic.ts`. Do not hardcode model strings elsewhere.
- **Budget `maxTokens` generously on web-search calls** — search narration counts against the budget, and 2000 tokens has truncated responses before the JSON was emitted.
- **Timestamps come back as ISO strings**, not `Date` objects (type parsers in `lib/supabase.ts:19-21`).
- **Never auto-disable tracking.** Only the user stops tracking a company.

---

### Task 1: Vitest harness + shared search criteria

Sets up the test harness and lands the first pure module that uses it: the target titles and location filter currently duplicated across the prompts in `app/actions/roles.ts:56` and `app/actions/discover.ts:81`.

**Files:**
- Create: `vitest.config.ts`
- Create: `lib/search-criteria.ts`
- Create: `lib/search-criteria.test.ts`
- Modify: `package.json` (devDependency + `test` script)
- Modify: `app/actions/roles.ts:10-11,56` (compose prompt from constants)
- Modify: `app/actions/discover.ts:7-8,81` (compose location rule from constant)

**Interfaces:**
- Consumes: nothing.
- Produces: `TARGET_TITLES: string[]`, `GTM_STACK_TERMS: string[]`, `LOCATION_RULE: string`, `ROLE_SEARCH_SYSTEM: string`, `roleExtractionSchema(): string`, `titleListForPrompt(): string`.

- [ ] **Step 1: Install vitest**

```bash
npm install --save-dev vitest@^2.1.0
```

- [ ] **Step 2: Create `vitest.config.ts`**

```ts
import path from "path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["lib/**/*.test.ts"],
  },
  resolve: {
    alias: { "@": path.resolve(__dirname) },
  },
});
```

- [ ] **Step 3: Add the test script to `package.json`**

In the `"scripts"` block, after `"lint": "next lint"`, add:

```json
"test": "vitest run"
```

- [ ] **Step 4: Write the failing test**

Create `lib/search-criteria.test.ts`:

```ts
import { describe, expect, test } from "vitest";
import {
  GTM_STACK_TERMS,
  LOCATION_RULE,
  TARGET_TITLES,
  roleExtractionSchema,
  titleListForPrompt,
} from "./search-criteria";

describe("search criteria", () => {
  test("target titles cover the core GTM systems roles", () => {
    const joined = TARGET_TITLES.join(" | ").toLowerCase();
    expect(joined).toContain("revenue operations");
    expect(joined).toContain("gtm systems");
    expect(joined).toContain("gtm engineer");
    expect(joined).toContain("marketing operations");
  });

  test("titles render as a comma-joined prompt fragment with no trailing comma", () => {
    const rendered = titleListForPrompt();
    expect(rendered).toContain("Revenue Operations");
    expect(rendered.endsWith(",")).toBe(false);
    expect(rendered).not.toContain(",,");
  });

  test("location rule names both the remote and Colorado conditions", () => {
    expect(LOCATION_RULE.toLowerCase()).toContain("remote");
    expect(LOCATION_RULE).toContain("Denver");
    expect(LOCATION_RULE).toContain("Boulder");
  });

  test("stack terms include the GTM tools that identify these roles", () => {
    const joined = GTM_STACK_TERMS.join(" ").toLowerCase();
    expect(joined).toContain("salesforce");
    expect(joined).toContain("clay");
    expect(joined).toContain("gong");
  });

  test("extraction schema names every field the Role type requires", () => {
    const schema = roleExtractionSchema();
    for (const field of [
      "role_title",
      "job_url",
      "location",
      "seniority",
      "salary_range",
      "description_summary",
      "fit_signal",
      "ic_flag",
    ]) {
      expect(schema).toContain(field);
    }
  });
});
```

- [ ] **Step 5: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL — `Failed to resolve import "./search-criteria"`.

- [ ] **Step 6: Create `lib/search-criteria.ts`**

```ts
// Single source of truth for what counts as a target role and an acceptable
// location. These were duplicated across the prompts in app/actions/roles.ts
// and app/actions/discover.ts; the crawler and role search add two more
// callers, so they live here now.

export const TARGET_TITLES = [
  "Head of GTM Systems",
  "VP of GTM Systems",
  "Director of GTM Systems",
  "Head of Revenue Operations",
  "VP of Revenue Operations",
  "Director of Revenue Operations",
  "RevOps Lead",
  "Head of Marketing Operations",
  "Director of Marketing Operations",
  "Head of GTM Strategy",
  "Director of GTM/AI Operations",
  "GTM Engineer",
  "AI-Ops / automation practitioner-builder",
];

// Tools that identify these roles even when the title is idiosyncratic
// (Business Systems Manager, Growth Systems Lead, and similar).
export const GTM_STACK_TERMS = [
  "Salesforce",
  "HubSpot",
  "Clay",
  "Gong",
  "Outreach",
  "Marketo",
  "Salesloft",
  "Looker",
];

export const LOCATION_RULE =
  "Only include roles that are fully remote OR list at least one location in " +
  "Colorado (Denver, Boulder, Colorado Springs, Fort Collins, CO). Exclude " +
  'roles available only in other cities with no remote option. If a role lists ' +
  '"Denver, CO • New York, NY" or is remote-friendly, include it.';

export const ROLE_SEARCH_SYSTEM =
  "You are a recruiting researcher specializing in go-to-market and revenue " +
  "operations roles. Return ONLY valid JSON, no markdown, no preamble.";

export function titleListForPrompt(): string {
  return TARGET_TITLES.join(", ");
}

export function roleExtractionSchema(): string {
  return [
    "Return a JSON array where each object has these exact fields:",
    "role_title (string)",
    "job_url (string or empty)",
    "location (string, list all locations from the posting)",
    'seniority (string, one of: "VP/Head", "Director", "Senior Manager", "Manager/IC")',
    'salary_range (string, exact salary or range from the posting — e.g. "$160,000 - $210,000" — or empty string if not listed)',
    "description_summary (string, 1-2 sentences about the role)",
    "fit_signal (string, 1 sentence on why a GTM Systems / RevOps / Marketing Ops leader and AI practitioner-builder might fit)",
    "ic_flag (boolean — true when the role is an IC / hands-on practitioner role that centers on building GTM systems and agentic AI workflows, OR the function is early/nascent at this company and you would define it from scratch. False for standard leadership roles and for narrow IC roles at mature orgs with no systems/AI-building upside)",
  ].join("\n- ");
}
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `npm test`
Expected: PASS, 5 tests.

- [ ] **Step 8: Rewrite the roles.ts prompt to compose from the constants**

In `app/actions/roles.ts`, replace the `SYSTEM` constant (lines 10-11) with an import and re-export, and rebuild the prompt. Add to the imports at the top:

```ts
import {
  LOCATION_RULE,
  ROLE_SEARCH_SYSTEM,
  roleExtractionSchema,
  titleListForPrompt,
} from "@/lib/search-criteria";
```

Delete the local `const SYSTEM = ...` declaration and replace the `prompt` assignment (line 56) with:

```ts
    const prompt = `Search for open go-to-market and revenue operations roles at "${startup.company}".${hint} Look for these titles: ${titleListForPrompt()}. Visit each job posting URL if available to extract the full details. IMPORTANT location filter: ${LOCATION_RULE}

${roleExtractionSchema()}

If no qualifying roles are found, return a JSON object: {"roles": [], "message": "explanation"}. Otherwise return ONLY the JSON array.`;
```

Then change the `callWithWebSearch` call to pass `system: ROLE_SEARCH_SYSTEM`.

- [ ] **Step 9: Rewrite the discover.ts location rule to use the constant**

In `app/actions/discover.ts`, add to the imports:

```ts
import { LOCATION_RULE } from "@/lib/search-criteria";
```

In the `prompt` template (line 81), replace the sentence beginning `IMPORTANT location rules: prioritize companies that hire remotely` through `...no remote option.` with:

```ts
`IMPORTANT location preference (soft, for ranking — do not hard-exclude): prioritize companies that hire remotely or have a Denver/Colorado presence. For reference, the roles being sought follow this rule: ${LOCATION_RULE}`
```

Discover ranks companies rather than filtering roles, so this stays a soft preference — do not turn it into a hard filter.

- [ ] **Step 10: Verify the build and tests pass**

Run: `npm run build && npm test && npm run lint`
Expected: build succeeds with no type errors, 5 tests pass, lint clean.

- [ ] **Step 11: Commit**

```bash
git add vitest.config.ts package.json package-lock.json lib/search-criteria.ts lib/search-criteria.test.ts app/actions/roles.ts app/actions/discover.ts
git commit -m "feat: add vitest and extract shared search criteria"
```

---

### Task 2: Schema changes and the raw-query escape hatch

**Files:**
- Modify: `db/schema.sql` (append tracking columns and `crawl_runs`)
- Modify: `lib/supabase.ts` (add `rawQuery`)
- Modify: `lib/types.ts` (add `TrackedCompany`, `CrawlStatus`, `CrawlRun`)

**Interfaces:**
- Consumes: nothing.
- Produces: `rawQuery<T>(text: string, values?: unknown[]): Promise<{ data: T[]; error: { message: string } | null }>`; types `CrawlStatus = "ok" | "empty" | "error" | "needs_url"`, `TrackedCompany`, `CrawlRun`.

- [ ] **Step 1: Append tracking columns to `db/schema.sql`**

Add at the end of the file, after the `insights_cache` block:

```sql
-- Tracking: watchlist rows are crawled on a recurring schedule until the user
-- stops tracking them. Untracking sets tracking_enabled = false rather than
-- deleting, so crawl history survives and the company does not resurface in
-- Discover as though newly found.
alter table watchlist add column if not exists tracking_enabled     boolean not null default true;
alter table watchlist add column if not exists crawl_method         text;
alter table watchlist add column if not exists crawl_interval_days  integer not null default 7;
alter table watchlist add column if not exists last_crawl_status    text;
alter table watchlist add column if not exists last_crawl_error     text;
alter table watchlist add column if not exists consecutive_failures integer not null default 0;
alter table watchlist add column if not exists source               text;

-- One row per crawl attempt. Without this, a silently failing crawler is
-- indistinguishable from a company that genuinely is not hiring.
-- role_titles holds the normalized titles seen on that run, so stale-posting
-- closure can compare consecutive successful runs.
create table if not exists crawl_runs (
  id           uuid primary key default gen_random_uuid(),
  company      text not null,
  started_at   timestamptz not null default now(),
  finished_at  timestamptz,
  method       text,
  roles_found  integer not null default 0,
  new_roles    integer not null default 0,
  role_titles  jsonb not null default '[]',
  status       text not null,
  error        text
);
create index if not exists crawl_runs_company_idx on crawl_runs (company, started_at desc);
```

- [ ] **Step 2: Apply the schema**

Run (substituting the real Railway Postgres URL):

```bash
DATABASE_URL=postgres://... node db/apply-schema.mjs
```

Expected: completes with no error. Re-run it once to confirm idempotency — it must succeed a second time too.

- [ ] **Step 3: Add `rawQuery` to `lib/supabase.ts`**

The builder supports only `.eq()` and `.neq()`. Selecting companies due for a crawl needs a timestamp compared against a per-row interval, which the builder cannot express. Add this export at the end of the file, after the `export const supabase` block:

```ts
/**
 * Escape hatch for queries the chainable builder cannot express (interval
 * arithmetic, IN lists, ORDER BY ... NULLS FIRST). Returns the same
 * { data, error } shape as the builder so callers handle errors identically.
 */
export async function rawQuery<T = Row>(
  text: string,
  values: unknown[] = []
): Promise<{ data: T[]; error: { message: string } | null }> {
  try {
    const res = await getPool().query(text, values);
    return { data: res.rows as T[], error: null };
  } catch (e) {
    return {
      data: [],
      error: { message: e instanceof Error ? e.message : String(e) },
    };
  }
}
```

- [ ] **Step 4: Add the tracking types to `lib/types.ts`**

Append at the end of the file:

```ts
export type CrawlStatus = "ok" | "empty" | "error" | "needs_url";
export type CrawlMethod = "fetch" | "search";

export interface TrackedCompany {
  id: string;
  company: string;
  tagline: string | null;
  raised: string | null;
  stage: string | null;
  lead_investor: string | null;
  founded: string | null;
  traction: string | null;
  careers_url: string | null;
  category: string | null;
  headquarters: string | null;
  added_at: string;
  last_checked_at: string | null;
  tracking_enabled: boolean;
  crawl_method: CrawlMethod | null;
  crawl_interval_days: number;
  last_crawl_status: CrawlStatus | null;
  last_crawl_error: string | null;
  consecutive_failures: number;
  source: string | null;
}

export interface CrawlRun {
  id: string;
  company: string;
  started_at: string;
  finished_at: string | null;
  method: CrawlMethod | null;
  roles_found: number;
  new_roles: number;
  role_titles: string[];
  status: CrawlStatus | "running";
  error: string | null;
}
```

- [ ] **Step 5: Verify the build passes**

Run: `npm run build && npm test`
Expected: build succeeds, 5 tests still pass.

- [ ] **Step 6: Commit**

```bash
git add db/schema.sql lib/supabase.ts lib/types.ts
git commit -m "feat: add tracking columns, crawl_runs table, and rawQuery helper"
```

---

### Task 3: Role dedupe key and crawl scheduling math

Two pure modules with no dependencies. Both are consumed by the crawler and by the UI, and both are places where a silent bug produces "no roles found" forever.

**Files:**
- Create: `lib/role-key.ts`
- Create: `lib/role-key.test.ts`
- Create: `lib/crawl-schedule.ts`
- Create: `lib/crawl-schedule.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `normalizeRoleKey(company: string, roleTitle: string): string`, `normalizeTitle(title: string): string`; `nextCheckDue(lastCheckedAt: string | null, intervalDays: number): Date | null`, `isDue(lastCheckedAt: string | null, intervalDays: number, now?: Date): boolean`, `DUE_COMPANIES_SQL: string`, `DEFAULT_BATCH_LIMIT: number`.

- [ ] **Step 1: Write the failing test for the dedupe key**

Create `lib/role-key.test.ts`:

```ts
import { describe, expect, test } from "vitest";
import { normalizeRoleKey, normalizeTitle } from "./role-key";

describe("normalizeTitle", () => {
  test("lowercases and collapses whitespace", () => {
    expect(normalizeTitle("  Director   of  RevOps ")).toBe("director of revops");
  });

  test("treats non-breaking spaces as spaces", () => {
    expect(normalizeTitle("Head of GTM")).toBe("head of gtm");
  });
});

describe("normalizeRoleKey", () => {
  test("same role in different casing produces the same key", () => {
    expect(normalizeRoleKey("Clay", "Head of RevOps")).toBe(
      normalizeRoleKey("clay", "HEAD OF REVOPS")
    );
  });

  test("same title at different companies produces different keys", () => {
    expect(normalizeRoleKey("Clay", "Head of RevOps")).not.toBe(
      normalizeRoleKey("Gong", "Head of RevOps")
    );
  });

  test("company and title cannot bleed across the separator", () => {
    // Without a separator, ("ab","c") and ("a","bc") would collide.
    expect(normalizeRoleKey("ab", "c")).not.toBe(normalizeRoleKey("a", "bc"));
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL — `Failed to resolve import "./role-key"`.

- [ ] **Step 3: Create `lib/role-key.ts`**

```ts
// Dedupe key for roles. Deliberately ignores job status: a role the user
// already marked Rejected or Not Interested must never be re-added as New by
// a later crawl.

export function normalizeTitle(title: string): string {
  return title
    .replace(/[ \s]+/g, " ")
    .trim()
    .toLowerCase();
}

export function normalizeRoleKey(company: string, roleTitle: string): string {
  return `${normalizeTitle(company)}::${normalizeTitle(roleTitle)}`;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Write the failing test for scheduling**

Create `lib/crawl-schedule.test.ts`:

```ts
import { describe, expect, test } from "vitest";
import { DUE_COMPANIES_SQL, isDue, nextCheckDue } from "./crawl-schedule";

const NOW = new Date("2026-08-12T12:00:00.000Z");

describe("nextCheckDue", () => {
  test("returns null for a company never checked", () => {
    expect(nextCheckDue(null, 7)).toBeNull();
  });

  test("adds the interval to the last check", () => {
    const due = nextCheckDue("2026-08-01T12:00:00.000Z", 7);
    expect(due?.toISOString()).toBe("2026-08-08T12:00:00.000Z");
  });
});

describe("isDue", () => {
  test("a company never checked is due", () => {
    expect(isDue(null, 7, NOW)).toBe(true);
  });

  test("a company checked longer ago than its interval is due", () => {
    expect(isDue("2026-08-01T12:00:00.000Z", 7, NOW)).toBe(true);
  });

  test("a company checked within its interval is not due", () => {
    expect(isDue("2026-08-10T12:00:00.000Z", 7, NOW)).toBe(false);
  });

  test("the boundary is inclusive — exactly one interval ago is due", () => {
    expect(isDue("2026-08-05T12:00:00.000Z", 7, NOW)).toBe(true);
  });
});

describe("DUE_COMPANIES_SQL", () => {
  test("filters to tracked companies only", () => {
    expect(DUE_COMPANIES_SQL).toContain("tracking_enabled = true");
  });

  test("puts never-checked companies first so nothing starves", () => {
    expect(DUE_COMPANIES_SQL.toLowerCase()).toContain("nulls first");
  });

  test("takes its limit from a bound parameter, never interpolation", () => {
    expect(DUE_COMPANIES_SQL).toContain("limit $1");
  });
});
```

- [ ] **Step 6: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL — `Failed to resolve import "./crawl-schedule"`.

- [ ] **Step 7: Create `lib/crawl-schedule.ts`**

```ts
// When is a tracked company due for another crawl. The SQL and the pure
// helpers must agree: the SQL drives the cron batch, the helpers drive the
// "next check" display on the Watchlist page.

export const DEFAULT_BATCH_LIMIT = 10;

export const DUE_COMPANIES_SQL = `
  select company,
         careers_url,
         crawl_method,
         crawl_interval_days,
         consecutive_failures,
         last_checked_at
    from watchlist
   where tracking_enabled = true
     and (last_checked_at is null
          or last_checked_at <= now() - (crawl_interval_days || ' days')::interval)
   order by last_checked_at asc nulls first
   limit $1
`;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export function nextCheckDue(
  lastCheckedAt: string | null,
  intervalDays: number
): Date | null {
  if (!lastCheckedAt) return null;
  return new Date(new Date(lastCheckedAt).getTime() + intervalDays * MS_PER_DAY);
}

export function isDue(
  lastCheckedAt: string | null,
  intervalDays: number,
  now: Date = new Date()
): boolean {
  const due = nextCheckDue(lastCheckedAt, intervalDays);
  if (!due) return true;
  return due.getTime() <= now.getTime();
}
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS, all suites green.

- [ ] **Step 9: Commit**

```bash
git add lib/role-key.ts lib/role-key.test.ts lib/crawl-schedule.ts lib/crawl-schedule.test.ts
git commit -m "feat: add role dedupe key and crawl scheduling helpers"
```

---

### Task 4: HTML stripping and JS-shell detection

The fetch tier's gatekeeper. If `isJsShell` breaks, the crawler stops falling back to search and reports "no roles" every week for every company — indistinguishable from a quiet job market. This is the highest-value test target in the plan.

**Files:**
- Create: `lib/page-extract.ts`
- Create: `lib/page-extract.test.ts`
- Create: `lib/robots.ts`
- Create: `lib/robots.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `stripHtml(html: string): ExtractedPage`, `isJsShell(page: ExtractedPage): boolean`, `MAX_PAGE_CHARS: number`, types `PageLink { href: string; text: string }` and `ExtractedPage { text: string; links: PageLink[] }`; `isDisallowed(robotsTxt: string, path: string): boolean`, `robotsUrlFor(pageUrl: string): string`.

- [ ] **Step 1: Write the failing test**

Create `lib/page-extract.test.ts`:

```ts
import { describe, expect, test } from "vitest";
import { isJsShell, MAX_PAGE_CHARS, stripHtml } from "./page-extract";

const REAL_PAGE = `
<html><head><style>.a{color:red}</style><script>var x=1;</script></head>
<body>
  <nav><a href="/about">About us</a></nav>
  <h1>Open roles at Example</h1>
  <p>We are hiring across go-to-market and engineering. ${"Filler sentence about the team and mission. ".repeat(20)}</p>
  <ul>
    <li><a href="/careers/head-of-revops">Head of Revenue Operations</a></li>
    <li><a href="/careers/gtm-engineer">GTM Engineer</a></li>
    <li><a href="/careers/marketing-ops">Marketing Operations Manager</a></li>
    <li><a href="/careers/backend-eng">Backend Engineer</a></li>
  </ul>
  <footer><a href="/privacy">Privacy</a></footer>
</body></html>`;

const ATS_SHELL = `
<html><head><script src="https://boards.greenhouse.io/embed/job_board/js?for=example"></script></head>
<body><div id="grnhse_app"></div></body></html>`;

describe("stripHtml", () => {
  test("removes script and style content from the text", () => {
    const page = stripHtml(REAL_PAGE);
    expect(page.text).not.toContain("var x=1");
    expect(page.text).not.toContain("color:red");
  });

  test("keeps visible body copy", () => {
    expect(stripHtml(REAL_PAGE).text).toContain("Open roles at Example");
  });

  test("drops nav and footer content", () => {
    const page = stripHtml(REAL_PAGE);
    expect(page.text).not.toContain("Privacy");
    expect(page.text).not.toContain("About us");
  });

  test("collects anchors with href and text", () => {
    const page = stripHtml(REAL_PAGE);
    const hrefs = page.links.map((l) => l.href);
    expect(hrefs).toContain("/careers/head-of-revops");
    const revops = page.links.find((l) => l.href === "/careers/head-of-revops");
    expect(revops?.text).toBe("Head of Revenue Operations");
  });

  test("collapses runs of whitespace", () => {
    expect(stripHtml("<p>a   \n\n  b</p>").text).toBe("a b");
  });

  test("decodes the common named entities", () => {
    expect(stripHtml("<p>R&amp;D &nbsp;team</p>").text).toBe("R&D team");
  });

  test("truncates very long pages", () => {
    const huge = `<p>${"word ".repeat(50_000)}</p>`;
    expect(stripHtml(huge).text.length).toBeLessThanOrEqual(MAX_PAGE_CHARS);
  });
});

describe("isJsShell", () => {
  test("an empty ATS embed is a shell", () => {
    expect(isJsShell(stripHtml(ATS_SHELL))).toBe(true);
  });

  test("a populated careers page is not a shell", () => {
    expect(isJsShell(stripHtml(REAL_PAGE))).toBe(false);
  });

  test("long prose with no job links is a shell", () => {
    const page = stripHtml(`<p>${"About our culture and values. ".repeat(40)}</p>`);
    expect(isJsShell(page)).toBe(true);
  });

  test("job links alone are not enough without content", () => {
    const page = stripHtml(
      `<a href="/jobs/1">A</a><a href="/jobs/2">B</a><a href="/jobs/3">C</a>`
    );
    expect(isJsShell(page)).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL — `Failed to resolve import "./page-extract"`.

- [ ] **Step 3: Create `lib/page-extract.ts`**

```ts
// Turns fetched careers-page HTML into text an LLM can extract roles from,
// and decides whether the page had any content at all.
//
// A "JS shell" is a careers page whose HTML contains no jobs because the board
// is rendered client-side by an ATS embed. Those pages must fall back to the
// web_search tier. Erring toward "shell" is safe — the search tier is strictly
// more capable, just more expensive.

export const MAX_PAGE_CHARS = 40_000;
const MIN_CONTENT_CHARS = 500;
const MIN_JOB_LINKS = 3;

export const JOB_LINK_PATTERN =
  /\/job|\/jobs\/|\/careers\/|\/position|\/opening|gh_jid=|\/apply/i;

export interface PageLink {
  href: string;
  text: string;
}

export interface ExtractedPage {
  text: string;
  links: PageLink[];
}

const ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
  "&nbsp;": " ",
};

function decodeEntities(s: string): string {
  return s.replace(/&(amp|lt|gt|quot|#39|apos|nbsp);/g, (m) => ENTITIES[m] ?? m);
}

function collapse(s: string): string {
  return s.replace(/[ \s]+/g, " ").trim();
}

export function stripHtml(html: string): ExtractedPage {
  // Drop chrome and non-content elements wholesale, including their markup.
  const body = html.replace(
    /<(script|style|svg|noscript|nav|footer|header)\b[^>]*>[\s\S]*?<\/\1>/gi,
    " "
  );

  const links: PageLink[] = [];
  const anchor = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match: RegExpExecArray | null;
  while ((match = anchor.exec(body)) !== null) {
    links.push({
      href: decodeEntities(match[1]),
      text: collapse(decodeEntities(match[2].replace(/<[^>]+>/g, " "))),
    });
  }

  const text = collapse(decodeEntities(body.replace(/<[^>]+>/g, " "))).slice(
    0,
    MAX_PAGE_CHARS
  );

  return { text, links };
}

export function isJsShell(page: ExtractedPage): boolean {
  if (page.text.length < MIN_CONTENT_CHARS) return true;
  const jobLinks = page.links.filter((l) => JOB_LINK_PATTERN.test(l.href));
  return jobLinks.length < MIN_JOB_LINKS;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS. If `stripHtml` truncation fails, confirm `MAX_PAGE_CHARS` is applied after collapsing whitespace, not before.

- [ ] **Step 5: Write the failing test for robots.txt**

Spec §3.2 requires the crawler to honor `robots.txt`. Create `lib/robots.test.ts`:

```ts
import { describe, expect, test } from "vitest";
import { isDisallowed, robotsUrlFor } from "./robots";

const ROBOTS = `
User-agent: BadBot
Disallow: /

User-agent: *
Disallow: /admin
Disallow: /internal/
Allow: /careers
`;

describe("robotsUrlFor", () => {
  test("resolves to the host root regardless of path", () => {
    expect(robotsUrlFor("https://example.com/careers/openings?x=1")).toBe(
      "https://example.com/robots.txt"
    );
  });

  test("preserves a non-default port", () => {
    expect(robotsUrlFor("https://example.com:8443/careers")).toBe(
      "https://example.com:8443/robots.txt"
    );
  });
});

describe("isDisallowed", () => {
  test("allows a path no rule covers", () => {
    expect(isDisallowed(ROBOTS, "/careers")).toBe(false);
  });

  test("blocks a path under a Disallow prefix", () => {
    expect(isDisallowed(ROBOTS, "/internal/jobs")).toBe(true);
  });

  test("only reads the wildcard group, not other user-agent groups", () => {
    // "Disallow: /" belongs to BadBot, not to *.
    expect(isDisallowed(ROBOTS, "/anything")).toBe(false);
  });

  test("an empty or missing robots.txt allows everything", () => {
    expect(isDisallowed("", "/careers")).toBe(false);
  });

  test("a bare 'Disallow:' with no value is not a block", () => {
    expect(isDisallowed("User-agent: *\nDisallow:", "/careers")).toBe(false);
  });
});
```

- [ ] **Step 6: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL — `Failed to resolve import "./robots"`.

- [ ] **Step 7: Create `lib/robots.ts`**

```ts
// Minimal robots.txt support for the careers-page fetch tier. Reads only the
// wildcard (User-agent: *) group, which is all this crawler needs — it makes
// one request per company per week and identifies itself honestly.
//
// Erring toward "disallowed" is safe: the crawler falls back to the
// web_search tier, which reads publicly indexed pages instead.

export function robotsUrlFor(pageUrl: string): string {
  const u = new URL(pageUrl);
  return `${u.protocol}//${u.host}/robots.txt`;
}

export function isDisallowed(robotsTxt: string, path: string): boolean {
  if (!robotsTxt.trim()) return false;

  let inWildcardGroup = false;
  const disallowed: string[] = [];

  for (const rawLine of robotsTxt.split(/\r?\n/)) {
    const line = rawLine.split("#")[0].trim();
    if (!line) continue;

    const [rawField, ...rest] = line.split(":");
    const field = rawField.trim().toLowerCase();
    const value = rest.join(":").trim();

    if (field === "user-agent") {
      inWildcardGroup = value === "*";
      continue;
    }
    if (field === "disallow" && inWildcardGroup && value) {
      disallowed.push(value);
    }
  }

  return disallowed.some((prefix) => path.startsWith(prefix));
}
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS.

- [ ] **Step 9: Verify the build**

Run: `npm run build && npm run lint`
Expected: clean.

- [ ] **Step 10: Commit**

```bash
git add lib/page-extract.ts lib/page-extract.test.ts lib/robots.ts lib/robots.test.ts
git commit -m "feat: add careers-page HTML stripping, shell detection, and robots.txt support"
```

---

### Task 5: Shared role ingestion

Extracts the block currently inlined at `app/actions/roles.ts:100-143` so the crawler, Discover, and (later) role search all ingest roles identically — and adds the dedupe step that stops a crawl from re-adding a role the user already rejected.

**Files:**
- Create: `lib/ingest-roles.ts`
- Modify: `app/actions/roles.ts:89-143` (replace the inline block with a call)
- Modify: `lib/anthropic.ts` (add `callStructured`)

**Interfaces:**
- Consumes: `normalizeRoleKey` (Task 3); `checkJobUrl` from `lib/verify-url.ts`; `addJob`/`updateJob` from `app/actions/jobs.ts`; `scoreFit` from `app/actions/parse-role.ts`.
- Produces: `ingestRoles(opts: IngestOptions): Promise<IngestResult>` where `IngestResult = { added: Role[]; skipped: Role[]; seenTitles: string[] }`; `callStructured(opts: { system: string; prompt: string; maxTokens?: number }): Promise<string>`.

- [ ] **Step 1: Add `callStructured` to `lib/anthropic.ts`**

Insert after the `callWithWebSearch` function:

```ts
/**
 * A plain completion with no tools. Used to extract roles from page text that
 * has already been fetched — the fetch tier's cost win comes from not paying
 * for web searches when the page content is already in hand.
 */
export async function callStructured(opts: {
  system: string;
  prompt: string;
  maxTokens?: number;
}): Promise<string> {
  const message = await anthropic.messages.create({
    model: MODEL,
    max_tokens: opts.maxTokens ?? 4000,
    system: opts.system,
    messages: [{ role: "user", content: opts.prompt }],
  });

  report("gtm-job-search", MODEL, message.usage);

  return message.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();
}
```

- [ ] **Step 2: Create `lib/ingest-roles.ts`**

```ts
import { supabase } from "@/lib/supabase";
import { addJob, updateJob } from "@/app/actions/jobs";
import { scoreFit } from "@/app/actions/parse-role";
import { checkJobUrl } from "@/lib/verify-url";
import { normalizeRoleKey, normalizeTitle } from "@/lib/role-key";
import type { Role } from "@/lib/types";

export interface IngestCompanyContext {
  tagline?: string | null;
  traction?: string | null;
  careers_url?: string | null;
  category?: string | null;
  raised?: string | null;
  stage?: string | null;
}

export interface IngestOptions {
  company: string;
  roles: Role[];
  companyContext?: IngestCompanyContext;
  source: string; // 'Discover' | 'Crawl' | 'Role Search'
  dryRun?: boolean;
}

export interface IngestResult {
  added: Role[];
  skipped: Role[];
  seenTitles: string[];
}

/**
 * Dedupes roles against the jobs table, verifies their URLs, inserts the new
 * ones, and fit-scores the live ones.
 *
 * Dedupe deliberately ignores job status. A role the user already marked
 * Rejected or Not Interested must never come back as New on a later crawl.
 */
export async function ingestRoles(opts: IngestOptions): Promise<IngestResult> {
  const { company, roles, source, dryRun = false } = opts;
  const ctx = opts.companyContext ?? {};
  const seenTitles = roles.map((r) => normalizeTitle(r.role_title));

  const { data: existing, error } = await supabase
    .from("jobs")
    .select("role_title, job_url")
    .eq("company", company);

  if (error) {
    throw new Error(`ingestRoles: could not read existing jobs — ${error.message}`);
  }

  const knownKeys = new Set<string>();
  const knownUrls = new Set<string>();
  for (const row of (existing ?? []) as { role_title: string; job_url: string | null }[]) {
    knownKeys.add(normalizeRoleKey(company, row.role_title));
    if (row.job_url) knownUrls.add(row.job_url);
  }

  const added: Role[] = [];
  const skipped: Role[] = [];
  const fresh: Role[] = [];

  for (const role of roles) {
    const isKnown =
      knownKeys.has(normalizeRoleKey(company, role.role_title)) ||
      (!!role.job_url && knownUrls.has(role.job_url));
    if (isKnown) skipped.push(role);
    else fresh.push(role);
  }

  const urlStatuses = await Promise.all(fresh.map((r) => checkJobUrl(r.job_url)));
  console.log(
    `ingestRoles(${company}): ${roles.length} found, ${fresh.length} new, ` +
      `${urlStatuses.filter((s) => s === "dead").length} dead URLs, source=${source}`
  );

  if (dryRun) {
    return { added: fresh, skipped, seenTitles };
  }

  const companyDescription = `${ctx.tagline ?? ""}. ${ctx.traction ?? ""}`.trim();

  await Promise.all(
    fresh.map(async (role, i) => {
      const isDead = urlStatuses[i] === "dead";

      const jobRes = await addJob({
        company,
        role_title: role.role_title,
        status: isDead ? "Posting Closed" : "New",
        seniority: role.seniority || null,
        location: role.location || null,
        job_url: role.job_url || null,
        careers_url: ctx.careers_url || null,
        category: ctx.category || null,
        raised: ctx.raised || null,
        stage: ctx.stage || null,
        traction: ctx.traction || null,
        salary_range: role.salary_range || null,
        fit_summary: role.fit_signal || null,
        ic_flag: role.ic_flag ?? false,
        source,
      });

      if (jobRes.error) {
        console.error(`ingestRoles: addJob failed for ${company} / ${role.role_title} — ${jobRes.error}`);
        return;
      }

      added.push(role);

      if (jobRes.job && !isDead) {
        const scored = await scoreFit({
          company,
          role_title: role.role_title,
          company_description: companyDescription,
          key_skills: role.description_summary,
          fit_summary: role.fit_signal,
          department: "",
          location: role.location,
        });
        if (scored.score > 0) {
          await updateJob(jobRes.job.id, {
            fit_score: scored.score,
            fit_summary: scored.rationale || role.fit_signal || null,
          });
        }
      }
    })
  );

  return { added, skipped, seenTitles };
}
```

- [ ] **Step 3: Replace the inline block in `app/actions/roles.ts`**

Delete lines 89-143 (the URL verification block, the `console.log`, and the `await Promise.all(roles.map(...))` that adds and scores jobs) and replace with:

```ts
    await ingestRoles({
      company: startup.company,
      roles,
      companyContext: {
        tagline: startup.tagline,
        traction: startup.traction,
        careers_url: startup.careers_url,
        category: startup.category,
        raised: startup.raised,
        stage: startup.stage,
      },
      source: "Discover",
    });
```

Add to the imports and remove the now-unused `addJob`, `updateJob`, `scoreFit`, and `checkJobUrl` imports:

```ts
import { ingestRoles } from "@/lib/ingest-roles";
```

- [ ] **Step 4: Verify the build catches any missed import**

Run: `npm run build && npm run lint`
Expected: build succeeds. Lint flags unused imports if any were missed — remove them.

- [ ] **Step 5: Verify the existing Discover flow still works end to end**

Run `npm run dev`, open the Discover tab, and click "Find roles →" on any company that has no cached roles yet. Expected: roles appear in the Roles tab with fit scores, exactly as before. Then click "Find roles →" on the **same** company again with a forced refresh. Expected: no duplicate rows appear in Roles — the dedupe is doing its job.

- [ ] **Step 6: Commit**

```bash
git add lib/ingest-roles.ts lib/anthropic.ts app/actions/roles.ts
git commit -m "feat: extract shared role ingestion with dedupe"
```

---

### Task 6: The crawler

**Files:**
- Create: `lib/crawler.ts`
- Create: `lib/crawler.test.ts`

**Interfaces:**
- Consumes: `stripHtml`/`isJsShell`/`MAX_PAGE_CHARS` (Task 4), `ingestRoles` (Task 5), `callStructured`/`callWithWebSearch`/`parseJson` (`lib/anthropic.ts`), `normalizeTitle` (Task 3), search criteria (Task 1), `rawQuery`/`supabase` (Task 2).
- Produces: `crawlCompany(company: string, opts?: { dryRun?: boolean }): Promise<CrawlOutcome>` where `CrawlOutcome = { company: string; method: CrawlMethod | null; rolesFound: number; newRoles: number; status: CrawlStatus; error?: string }`; `buildExtractionPrompt(company: string, page: ExtractedPage): string`; `titlesToClose(previousRuns: string[][], activeTitles: string[]): string[]`.

- [ ] **Step 1: Write the failing test for the pure crawler helpers**

Create `lib/crawler.test.ts`:

```ts
import { describe, expect, test } from "vitest";
import { buildExtractionPrompt, titlesToClose } from "./crawler";
import { stripHtml } from "./page-extract";

describe("buildExtractionPrompt", () => {
  const page = stripHtml(
    `<p>Open roles</p><a href="/careers/revops">Head of RevOps</a>`
  );

  test("names the company", () => {
    expect(buildExtractionPrompt("Clay", page)).toContain("Clay");
  });

  test("includes the location rule", () => {
    expect(buildExtractionPrompt("Clay", page)).toContain("Denver");
  });

  test("includes the page text and its links", () => {
    const prompt = buildExtractionPrompt("Clay", page);
    expect(prompt).toContain("Open roles");
    expect(prompt).toContain("/careers/revops");
  });

  test("asks for an empty array rather than prose when nothing matches", () => {
    expect(buildExtractionPrompt("Clay", page)).toContain("[]");
  });
});

describe("titlesToClose", () => {
  // runs[0] is the CURRENT run, runs[1] the previous successful one.
  test("closes a title absent from both the current and previous run", () => {
    const runs = [["head of revops"], ["head of revops"]];
    expect(titlesToClose(runs, ["gtm engineer"])).toEqual(["gtm engineer"]);
  });

  test("does not close a title present in the current run", () => {
    const runs = [["gtm engineer"], []];
    expect(titlesToClose(runs, ["gtm engineer"])).toEqual([]);
  });

  test("does not close a role found for the first time today", () => {
    // Regression guard: a role just discovered is in activeTitles but absent
    // from every prior run. Closing it immediately would be wrong.
    const runs = [["gtm engineer"], ["head of revops"]];
    expect(titlesToClose(runs, ["gtm engineer"])).toEqual([]);
  });

  test("does not close after only one successful run", () => {
    expect(titlesToClose([["head of revops"]], ["gtm engineer"])).toEqual([]);
  });

  test("does not close when there are no successful runs at all", () => {
    expect(titlesToClose([], ["gtm engineer"])).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL — `Failed to resolve import "./crawler"`.

- [ ] **Step 3: Create `lib/crawler.ts`**

```ts
import { callStructured, callWithWebSearch, parseJson } from "@/lib/anthropic";
import { ingestRoles } from "@/lib/ingest-roles";
import { isJsShell, stripHtml, type ExtractedPage } from "@/lib/page-extract";
import { isDisallowed, robotsUrlFor } from "@/lib/robots";
import { normalizeTitle } from "@/lib/role-key";
import {
  LOCATION_RULE,
  ROLE_SEARCH_SYSTEM,
  roleExtractionSchema,
  titleListForPrompt,
} from "@/lib/search-criteria";
import { rawQuery, supabase } from "@/lib/supabase";
import type {
  CrawlMethod,
  CrawlStatus,
  Role,
  RolesResult,
  TrackedCompany,
} from "@/lib/types";

const FETCH_TIMEOUT_MS = 10_000;
const USER_AGENT =
  "GTMJobSearchBot/1.0 (personal job-search tool; contact tkeefe66@gmail.com)";

export interface CrawlOutcome {
  company: string;
  method: CrawlMethod | null;
  rolesFound: number;
  newRoles: number;
  status: CrawlStatus;
  error?: string;
}

export function buildExtractionPrompt(
  company: string,
  page: ExtractedPage
): string {
  const links = page.links
    .map((l) => `${l.text || "(no text)"} -> ${l.href}`)
    .join("\n");

  return `Below is the text and link list scraped from the careers page of "${company}".

Identify every open role matching any of these titles or close variants: ${titleListForPrompt()}.

${LOCATION_RULE}

${roleExtractionSchema()}

Use the link list to fill job_url — resolve relative URLs against the careers page where you can, otherwise return the relative path as-is. If no role on the page qualifies, return exactly [] and nothing else. Return ONLY the JSON array.

--- PAGE TEXT ---
${page.text}

--- LINKS ---
${links}`;
}

/**
 * Which previously-seen roles should be marked Posting Closed.
 *
 * `runs` is [currentRunTitles, previousSuccessfulRunTitles]. A role closes
 * only when it is absent from BOTH — that is, two consecutive successful
 * crawls did not list it. Passing fewer than two runs closes nothing, so a
 * company's first successful crawl never closes anything, and a role
 * discovered today (present in the current run) is never closed on the same
 * day it was found.
 *
 * Failed, empty, and needs_url runs are never passed in: a fetch failure must
 * not close a live job.
 */
export function titlesToClose(runs: string[][], activeTitles: string[]): string[] {
  if (runs.length < 2) return [];
  const stillListed = new Set(runs.flat());
  return activeTitles.filter((t) => !stillListed.has(t));
}

async function fetchPage(url: string): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      redirect: "follow",
      signal: controller.signal,
      headers: { "User-Agent": USER_AGENT },
    });
    if (!res.ok) {
      console.warn(`crawler: fetch of ${url} returned ${res.status}`);
      return null;
    }
    return await res.text();
  } catch (err) {
    console.warn(
      `crawler: fetch of ${url} failed — ${err instanceof Error ? err.message : String(err)}`
    );
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function resolveCareersUrl(company: string): Promise<string | null> {
  const raw = await callWithWebSearch({
    system:
      "You find official careers pages. Return ONLY valid JSON, no markdown, no preamble.",
    prompt: `Find the official careers / open-roles page for the company "${company}". Return a JSON object: {"careers_url": "https://..."} — or {"careers_url": ""} if you cannot find one with confidence.`,
    maxTokens: 1500,
  });
  try {
    const parsed = parseJson<{ careers_url: string }>(raw);
    return parsed.careers_url?.trim() || null;
  } catch {
    return null;
  }
}

function rolesFromRaw(raw: string): Role[] {
  const parsed = parseJson<Role[] | RolesResult>(raw);
  if (Array.isArray(parsed)) return parsed;
  if (parsed && typeof parsed === "object" && "roles" in parsed) {
    return parsed.roles ?? [];
  }
  return [];
}

async function fetchAllowed(careersUrl: string): Promise<boolean> {
  const robotsTxt = await fetchPage(robotsUrlFor(careersUrl));
  if (!robotsTxt) return true; // no robots.txt served — allowed
  return !isDisallowed(robotsTxt, new URL(careersUrl).pathname);
}

async function extractViaFetch(
  company: string,
  careersUrl: string
): Promise<Role[] | null> {
  if (!(await fetchAllowed(careersUrl))) {
    console.log(`crawler: robots.txt disallows ${careersUrl}, using search tier`);
    return null;
  }

  const html = await fetchPage(careersUrl);
  if (!html) return null;

  const page = stripHtml(html);
  if (isJsShell(page)) {
    console.log(`crawler: ${company} careers page is a JS shell, using search tier`);
    return null;
  }

  const raw = await callStructured({
    system: ROLE_SEARCH_SYSTEM,
    prompt: buildExtractionPrompt(company, page),
    maxTokens: 4000,
  });
  return rolesFromRaw(raw);
}

async function extractViaSearch(
  company: string,
  careersUrl: string | null
): Promise<Role[]> {
  const hint = careersUrl ? ` Their careers page may be: ${careersUrl}.` : "";
  const raw = await callWithWebSearch({
    system: ROLE_SEARCH_SYSTEM,
    prompt: `Search for open go-to-market and revenue operations roles at "${company}".${hint} Look for these titles: ${titleListForPrompt()}. Visit each job posting URL if available to extract the full details. IMPORTANT location filter: ${LOCATION_RULE}

${roleExtractionSchema()}

If no qualifying roles are found, return a JSON object: {"roles": [], "message": "explanation"}. Otherwise return ONLY the JSON array.`,
    // Search narration counts against the budget; 2000 has truncated the
    // response before the JSON was emitted.
    maxTokens: 8000,
  });
  return rolesFromRaw(raw);
}

/** Titles seen on the single most recent successful run, or [] if there is none. */
async function lastSuccessfulTitles(company: string): Promise<string[][]> {
  const { data } = await rawQuery<{ role_titles: string[] }>(
    `select role_titles from crawl_runs
      where company = $1 and status = 'ok'
      order by started_at desc
      limit 1`,
    [company]
  );
  return (data ?? []).map((r) => r.role_titles ?? []);
}

async function closeStalePostings(
  company: string,
  runs: string[][]
): Promise<void> {
  const { data } = await rawQuery<{ id: string; role_title: string }>(
    `select id, role_title from jobs
      where company = $1
        and status not in ('Posting Closed', 'Rejected', 'Not Interested', 'Passed')`,
    [company]
  );

  const active = (data ?? []).map((r) => ({
    id: r.id,
    key: normalizeTitle(r.role_title),
  }));
  const toClose = titlesToClose(
    runs,
    active.map((a) => a.key)
  );
  if (toClose.length === 0) return;

  const closing = new Set(toClose);
  for (const job of active) {
    if (!closing.has(job.key)) continue;
    await supabase
      .from("jobs")
      .update({ status: "Posting Closed", updated_at: new Date().toISOString() })
      .eq("id", job.id);
    console.log(`crawler: closed stale posting ${company} / ${job.key}`);
  }
}

export async function crawlCompany(
  company: string,
  opts: { dryRun?: boolean } = {}
): Promise<CrawlOutcome> {
  const dryRun = opts.dryRun ?? false;

  const { data: row } = await supabase
    .from("watchlist")
    .select("*")
    .eq("company", company)
    .maybeSingle();

  const tracked = row as TrackedCompany | null;
  if (!tracked) {
    return {
      company,
      method: null,
      rolesFound: 0,
      newRoles: 0,
      status: "error",
      error: `"${company}" is not on the watchlist. Track it before crawling.`,
    };
  }
  if (!tracked.tracking_enabled) {
    return {
      company,
      method: null,
      rolesFound: 0,
      newRoles: 0,
      status: "error",
      error: `Tracking is turned off for "${company}".`,
    };
  }

  const { data: runRows } = await supabase
    .from("crawl_runs")
    .insert({ company, status: "running" })
    .select()
    .single();
  const runId = (runRows as { id: string } | null)?.id ?? null;

  let method: CrawlMethod | null = null;
  let status: CrawlStatus = "error";
  let errorMessage: string | undefined;
  let roles: Role[] = [];
  let newRoles = 0;
  let seenTitles: string[] = [];

  try {
    let careersUrl = tracked.careers_url;
    if (!careersUrl) {
      careersUrl = await resolveCareersUrl(company);
      if (careersUrl) {
        await supabase
          .from("watchlist")
          .update({ careers_url: careersUrl })
          .eq("company", company);
      }
    }

    if (!careersUrl) {
      status = "needs_url";
      errorMessage = `Could not find a careers page for "${company}". Add one manually on the Watchlist page.`;
    } else {
      // A company that previously needed the search tier skips the fetch
      // attempt. A 'fetch' company that now returns a shell re-learns 'search'.
      let fetched: Role[] | null = null;
      if (tracked.crawl_method !== "search") {
        fetched = await extractViaFetch(company, careersUrl);
      }

      if (fetched) {
        method = "fetch";
        roles = fetched;
      } else {
        method = "search";
        roles = await extractViaSearch(company, careersUrl);
      }

      // Read the previous successful run BEFORE this run's row is finalized.
      const previousRun = await lastSuccessfulTitles(company);

      const result = await ingestRoles({
        company,
        roles,
        companyContext: {
          tagline: tracked.tagline,
          traction: tracked.traction,
          careers_url: careersUrl,
          category: tracked.category,
          raised: tracked.raised,
          stage: tracked.stage,
        },
        source: "Crawl",
        dryRun,
      });

      newRoles = result.added.length;
      seenTitles = result.seenTitles;
      status = roles.length > 0 ? "ok" : "empty";

      if (!dryRun && status === "ok") {
        // [current run, previous successful run] — a role closes only when
        // absent from both, so nothing found today is ever closed today.
        await closeStalePostings(company, [seenTitles, ...previousRun]);
      }
    }
  } catch (err) {
    status = "error";
    errorMessage = err instanceof Error ? err.message : String(err);
    console.error(`crawler: ${company} failed — ${errorMessage}`);
  }

  if (!dryRun) {
    if (runId) {
      await supabase
        .from("crawl_runs")
        .update({
          finished_at: new Date().toISOString(),
          method,
          roles_found: roles.length,
          new_roles: newRoles,
          role_titles: seenTitles,
          status,
          error: errorMessage ?? null,
        })
        .eq("id", runId);
    }

    const failed = status === "error" || status === "needs_url";
    await rawQuery(
      `update watchlist
          set last_checked_at = now(),
              crawl_method = coalesce($2, crawl_method),
              last_crawl_status = $3,
              last_crawl_error = $4,
              consecutive_failures = case when $5 then consecutive_failures + 1 else 0 end
        where company = $1`,
      [company, method, status, errorMessage ?? null, failed]
    );
  }

  return {
    company,
    method,
    rolesFound: roles.length,
    newRoles,
    status,
    error: errorMessage,
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS, all suites green.

- [ ] **Step 5: Verify the build**

Run: `npm run build && npm run lint`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add lib/crawler.ts lib/crawler.test.ts
git commit -m "feat: add careers-page crawler with fetch and search tiers"
```

---

### Task 7: Tracking server actions

**Files:**
- Modify: `app/actions/watchlist.ts` (add tracking actions, update `addToWatchlist`)

**Interfaces:**
- Consumes: `crawlCompany` (Task 6), `DUE_COMPANIES_SQL`/`DEFAULT_BATCH_LIMIT` (Task 3), `rawQuery` (Task 2).
- Produces: `trackCompanyByName(name: string)`, `setTracking(company: string, enabled: boolean)`, `setCareersUrl(company: string, url: string)`, `checkCompanyNow(company: string)`, `getTrackedCompanies()`, `getDueCompanies(limit?: number)`.

- [ ] **Step 1: Add the tracking actions to `app/actions/watchlist.ts`**

Add these imports at the top:

```ts
import { crawlCompany, type CrawlOutcome } from "@/lib/crawler";
import { DEFAULT_BATCH_LIMIT, DUE_COMPANIES_SQL } from "@/lib/crawl-schedule";
import { rawQuery } from "@/lib/supabase";
import type { TrackedCompany } from "@/lib/types";
```

Append these actions to the end of the file:

```ts
export async function getTrackedCompanies(): Promise<{
  companies: TrackedCompany[];
  error?: string;
}> {
  const { data, error } = await supabase
    .from("watchlist")
    .select("*")
    .order("added_at", { ascending: false });
  if (error) return { companies: [], error: error.message };
  return { companies: (data ?? []) as TrackedCompany[] };
}

/**
 * Track any company by name, whether or not it ever appeared in Discover.
 * Runs the first crawl immediately so the user sees a result now rather than
 * waiting for the next cron cycle.
 */
export async function trackCompanyByName(
  name: string
): Promise<{ outcome?: CrawlOutcome; error?: string }> {
  const company = name.trim();
  if (!company) return { error: "Enter a company name." };

  const { error } = await supabase.from("watchlist").upsert(
    {
      company,
      source: "manual",
      tracking_enabled: true,
      consecutive_failures: 0,
    },
    { onConflict: "company" }
  );
  if (error) {
    return { error: `Could not track "${company}" — ${error.message}` };
  }

  const outcome = await crawlCompany(company);
  return { outcome };
}

export async function setTracking(
  company: string,
  enabled: boolean
): Promise<{ error?: string }> {
  const patch: Record<string, unknown> = { tracking_enabled: enabled };
  if (enabled) patch.consecutive_failures = 0;
  const { error } = await supabase
    .from("watchlist")
    .update(patch)
    .eq("company", company);
  return { error: error?.message };
}

export async function setCareersUrl(
  company: string,
  url: string
): Promise<{ error?: string }> {
  const trimmed = url.trim();
  if (!/^https?:\/\//i.test(trimmed)) {
    return { error: "Enter a full URL starting with http:// or https://" };
  }
  const { error } = await supabase
    .from("watchlist")
    .update({
      careers_url: trimmed,
      last_crawl_status: null,
      last_crawl_error: null,
      consecutive_failures: 0,
    })
    .eq("company", company);
  return { error: error?.message };
}

export async function checkCompanyNow(company: string): Promise<CrawlOutcome> {
  return crawlCompany(company);
}

export async function getDueCompanies(
  limit: number = DEFAULT_BATCH_LIMIT
): Promise<{ companies: string[]; error?: string }> {
  const { data, error } = await rawQuery<{ company: string }>(DUE_COMPANIES_SQL, [
    limit,
  ]);
  if (error) return { companies: [], error: error.message };
  return { companies: (data ?? []).map((r) => r.company) };
}
```

- [ ] **Step 2: Make `addToWatchlist` re-enable tracking**

`addToWatchlist` upserts on `company`. A company the user previously untracked must start being crawled again when they re-add it from Discover. In `addToWatchlist`, add these three fields to the upsert payload:

```ts
      source: "discover",
      tracking_enabled: true,
      consecutive_failures: 0,
```

The builder's upsert sets `excluded` values for every key present in the payload (`lib/supabase.ts:179-181`), so only the listed columns are overwritten — `careers_url` learned by a previous crawl survives unless Discover supplies a new one.

- [ ] **Step 3: Verify the build**

Run: `npm run build && npm test && npm run lint`
Expected: clean, all tests pass.

- [ ] **Step 4: Commit**

```bash
git add app/actions/watchlist.ts
git commit -m "feat: add tracking server actions"
```

---

### Task 8: Watchlist tracking UI — first user-visible checkpoint

**Files:**
- Modify: `components/Watchlist.tsx`

**Interfaces:**
- Consumes: `getTrackedCompanies`, `trackCompanyByName`, `setTracking`, `setCareersUrl`, `checkCompanyNow` (Task 7); `isDue`, `nextCheckDue` (Task 3).
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Replace `components/Watchlist.tsx`**

This is a full rewrite of the existing 152-line component. It keeps the current
Tailwind idiom (`border-slate`, `text-ink/60`, `rounded-md`, `Tag` from `./ui`,
the warning color `#92400E`) and the existing "Find roles →" and "Careers ↗"
affordances, and adds the tracking controls around them.

```tsx
"use client";

import { useEffect, useState } from "react";
import {
  checkCompanyNow,
  getTrackedCompanies,
  setCareersUrl,
  setTracking,
  trackCompanyByName,
} from "@/app/actions/watchlist";
import { isDue, nextCheckDue } from "@/lib/crawl-schedule";
import type { CrawlOutcome } from "@/lib/crawler";
import type { TrackedCompany } from "@/lib/types";
import { Spinner, Tag } from "./ui";

export default function Watchlist() {
  const [companies, setCompanies] = useState<TrackedCompany[]>([]);
  const [loading, setLoading] = useState(true);
  const [newCompany, setNewCompany] = useState("");
  const [tracking, setTrackingBusy] = useState(false);
  const [checking, setChecking] = useState<string | null>(null);
  const [busyRow, setBusyRow] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [urlDrafts, setUrlDrafts] = useState<Record<string, string>>({});
  const [showUntracked, setShowUntracked] = useState(false);

  useEffect(() => {
    load();
  }, []);

  async function load() {
    setLoading(true);
    const res = await getTrackedCompanies();
    if (res.error) setNotice(`Couldn't load your list: ${res.error}`);
    setCompanies(res.companies);
    setLoading(false);
  }

  function describe(outcome: CrawlOutcome): string {
    if (outcome.status === "error") return outcome.error ?? "Check failed.";
    if (outcome.status === "needs_url") {
      return outcome.error ?? "No careers page found — add one below.";
    }
    if (outcome.status === "empty") return "No matching roles right now.";
    return `${outcome.rolesFound} role${outcome.rolesFound === 1 ? "" : "s"} found, ${outcome.newRoles} new.`;
  }

  async function handleTrack(e: React.FormEvent) {
    e.preventDefault();
    const name = newCompany.trim();
    if (!name) return;
    setTrackingBusy(true);
    setNotice(null);
    const res = await trackCompanyByName(name);
    setTrackingBusy(false);
    if (res.error) setNotice(res.error);
    else if (res.outcome) setNotice(`${name}: ${describe(res.outcome)}`);
    setNewCompany("");
    await load();
  }

  async function handleCheckNow(company: string) {
    setChecking(company);
    setNotice(null);
    const outcome = await checkCompanyNow(company);
    setChecking(null);
    setNotice(`${company}: ${describe(outcome)}`);
    await load();
  }

  async function handleSetTracking(company: string, enabled: boolean) {
    setBusyRow(company);
    const res = await setTracking(company, enabled);
    setBusyRow(null);
    if (res.error) setNotice(res.error);
    await load();
  }

  async function handleSaveUrl(company: string) {
    const url = (urlDrafts[company] ?? "").trim();
    setBusyRow(company);
    const res = await setCareersUrl(company, url);
    setBusyRow(null);
    if (res.error) {
      setNotice(res.error);
      return;
    }
    setUrlDrafts((prev) => ({ ...prev, [company]: "" }));
    await handleCheckNow(company);
  }

  function formatDate(iso: string) {
    return new Date(iso).toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  }

  const tracked = companies.filter((c) => c.tracking_enabled);
  const untracked = companies.filter((c) => !c.tracking_enabled);

  function renderRow(c: TrackedCompany, i: number) {
    const due = nextCheckDue(c.last_checked_at, c.crawl_interval_days);
    const failing = c.consecutive_failures >= 3;

    return (
      <div
        key={c.company}
        className={`flex flex-col gap-2 p-4 sm:flex-row sm:items-start ${
          i > 0 ? "border-t border-slate" : ""
        }`}
      >
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-heading font-semibold">{c.company}</span>
            {c.stage && <Tag>{c.stage}</Tag>}
            {c.raised && <Tag>{c.raised}</Tag>}
            {c.category && <Tag>{c.category}</Tag>}
            {c.source && <Tag>via {c.source}</Tag>}
          </div>

          {c.tagline && (
            <p className="mt-0.5 text-sm text-ink/60 line-clamp-1">{c.tagline}</p>
          )}

          <p className="mt-1 text-xs text-ink/40">
            Added {formatDate(c.added_at)}
            {c.last_checked_at
              ? ` · Last checked ${formatDate(c.last_checked_at)}`
              : " · Never checked"}
            {c.tracking_enabled &&
              (isDue(c.last_checked_at, c.crawl_interval_days)
                ? " · Due now"
                : due
                  ? ` · Next check ${formatDate(due.toISOString())}`
                  : "")}
          </p>

          {c.last_crawl_status === "empty" && (
            <p className="mt-1 text-xs text-ink/40">No matching roles on the last check.</p>
          )}

          {failing && (
            <p className="mt-1 text-xs text-[#92400E]">
              Failing — {c.consecutive_failures} checks in a row.
              {c.last_crawl_error ? ` ${c.last_crawl_error}` : ""}
            </p>
          )}

          {c.last_crawl_status === "needs_url" && (
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <input
                type="text"
                value={urlDrafts[c.company] ?? ""}
                onChange={(e) =>
                  setUrlDrafts((prev) => ({ ...prev, [c.company]: e.target.value }))
                }
                placeholder="https://company.com/careers"
                className="w-72 rounded-md border border-slate px-2 py-1 text-sm"
              />
              <button
                onClick={() => handleSaveUrl(c.company)}
                disabled={busyRow === c.company}
                className="rounded-md border border-ink px-2 py-1 text-xs font-medium transition hover:bg-ink hover:text-white disabled:opacity-50"
              >
                Save careers URL
              </button>
            </div>
          )}
        </div>

        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {c.tracking_enabled ? (
            <>
              <button
                onClick={() => handleCheckNow(c.company)}
                disabled={!!checking}
                className="rounded-md border border-ink px-3 py-1.5 text-sm font-medium transition hover:bg-ink hover:text-white disabled:opacity-50"
              >
                {checking === c.company ? "Checking…" : "Check now"}
              </button>
              {c.careers_url && (
                <a
                  href={c.careers_url}
                  target="_blank"
                  rel="noreferrer"
                  className="text-sm text-ink/50 underline-offset-2 hover:underline"
                >
                  Careers ↗
                </a>
              )}
              <button
                onClick={() => handleSetTracking(c.company, false)}
                disabled={busyRow === c.company}
                className="text-sm text-ink/30 transition hover:text-[#92400E] disabled:opacity-50"
              >
                Stop tracking
              </button>
            </>
          ) : (
            <button
              onClick={() => handleSetTracking(c.company, true)}
              disabled={busyRow === c.company}
              className="rounded-md border border-slate px-3 py-1.5 text-sm font-medium text-ink/60 transition hover:border-ink hover:text-ink disabled:opacity-50"
            >
              Resume
            </button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div>
      <div className="mb-6">
        <h2 className="text-xl font-heading font-semibold">Tracked companies</h2>
        <p className="text-sm text-ink/60">
          Tracked companies have their careers page checked automatically. New roles
          land in Roles, already scored.
        </p>
      </div>

      <form onSubmit={handleTrack} className="mb-6 flex flex-wrap items-center gap-2">
        <input
          type="text"
          value={newCompany}
          onChange={(e) => setNewCompany(e.target.value)}
          disabled={tracking}
          placeholder="Track a company by name…"
          className="w-72 rounded-md border border-slate px-3 py-2 text-sm disabled:opacity-50"
        />
        <button
          type="submit"
          disabled={tracking || !newCompany.trim()}
          className="rounded-md border border-ink bg-ink px-4 py-2 text-sm font-medium text-white transition hover:bg-ink/90 disabled:opacity-50"
        >
          Track
        </button>
      </form>

      {tracking && (
        <div className="mb-4">
          <Spinner label="Tracking and running the first check…" />
        </div>
      )}

      {notice && !tracking && (
        <div className="mb-4 rounded-md border border-slate bg-white p-3 text-sm text-ink/70">
          {notice}
        </div>
      )}

      {loading && <div className="py-12 text-center text-sm text-ink/40">Loading…</div>}

      {!loading && tracked.length === 0 && (
        <div className="rounded-md border border-dashed border-slate p-12 text-center text-sm text-ink/50">
          Nothing tracked yet. Add a company above, or hit &quot;Watch&quot; on any
          company in Discover.
        </div>
      )}

      {!loading && tracked.length > 0 && (
        <div className="overflow-hidden rounded-lg border border-slate bg-white">
          {tracked.map(renderRow)}
        </div>
      )}

      {!loading && untracked.length > 0 && (
        <div className="mt-6">
          <button
            onClick={() => setShowUntracked((v) => !v)}
            className="text-sm text-ink/50 hover:text-ink"
          >
            {showUntracked ? "▾" : "▸"} Not tracked ({untracked.length})
          </button>
          {showUntracked && (
            <div className="mt-2 overflow-hidden rounded-lg border border-slate bg-white opacity-70">
              {untracked.map(renderRow)}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
```

Note what this deliberately drops: the old `handleFindRoles` and `handleMarkChecked`
paths. `checkCompanyNow` supersedes both — it crawls and stamps `last_checked_at`
in one action. `markChecked` and `getWatchlist` remain exported from
`app/actions/watchlist.ts` but are no longer called from this component.

- [ ] **Step 2: Confirm nothing else imports the removed handlers**

Run: `grep -rn "getWatchlist\|markChecked" app components`
Expected: matches only inside `app/actions/watchlist.ts`. If `components/Discover.tsx`
still imports `getWatchedCompanyNames`, leave it — that one is still in use.

- [ ] **Step 3: Verify in the browser**

Run `npm run dev`, open `/watchlist`, and confirm:
1. Typing a company name that is not in the database and submitting adds it and runs a crawl.
2. The row shows last-checked and next-check.
3. **Check now** re-runs and updates the timestamps.
4. **Stop tracking** moves the row to the "Not tracked" section, and **Resume** moves it back.
5. Any role the crawl found appears on the Roles tab with a fit score and `source` of `Crawl`.
6. A company whose careers page cannot be resolved shows the inline URL field; pasting a URL and saving triggers a fresh check.

- [ ] **Step 4: Verify the build**

Run: `npm run build && npm test && npm run lint`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add components/Watchlist.tsx
git commit -m "feat: add tracking controls to the Watchlist page"
```

---

### Task 9: Cron route and Railway scheduling

**Files:**
- Create: `app/api/cron/crawl/route.ts`
- Modify: `CLAUDE.md` (document the route, the secret, and the new test gate)

**Interfaces:**
- Consumes: `DUE_COMPANIES_SQL`/`DEFAULT_BATCH_LIMIT` (Task 3), `rawQuery` (Task 2), `crawlCompany` (Task 6).
- Produces: `GET /api/cron/crawl` returning `{ crawled, results, totals }`.

- [ ] **Step 1: Create the route handler**

```ts
import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { crawlCompany, type CrawlOutcome } from "@/lib/crawler";
import { DEFAULT_BATCH_LIMIT, DUE_COMPANIES_SQL } from "@/lib/crawl-schedule";
import { rawQuery } from "@/lib/supabase";

export const dynamic = "force-dynamic";

// This is the only API route in the app. It both mutates the database and
// spends Anthropic credits, and the app has no auth, so the shared secret is
// the only thing standing between a public URL and unbounded spend.
function authorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const header = req.headers.get("authorization") ?? "";
  const provided = header.startsWith("Bearer ") ? header.slice(7) : "";
  const a = Buffer.from(provided);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function GET(req: Request) {
  if (!authorized(req)) {
    return new NextResponse(null, { status: 401 });
  }

  const url = new URL(req.url);
  const dryRun = url.searchParams.get("dry") === "1";
  const limit = Number(url.searchParams.get("limit")) || DEFAULT_BATCH_LIMIT;

  const { data, error } = await rawQuery<{ company: string }>(
    DUE_COMPANIES_SQL,
    [limit]
  );
  if (error) {
    console.error(`cron/crawl: could not select due companies — ${error.message}`);
    return NextResponse.json(
      { error: `Could not select due companies: ${error.message}` },
      { status: 500 }
    );
  }

  const due = (data ?? []).map((r) => r.company);
  const results: CrawlOutcome[] = [];

  // Sequential on purpose: keeps the request inside normal HTTP timeouts and
  // avoids bursting the Anthropic API. One company failing never aborts the
  // batch.
  for (const company of due) {
    try {
      results.push(await crawlCompany(company, { dryRun }));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`cron/crawl: ${company} threw — ${message}`);
      results.push({
        company,
        method: null,
        rolesFound: 0,
        newRoles: 0,
        status: "error",
        error: message,
      });
    }
  }

  return NextResponse.json({
    dryRun,
    crawled: results.length,
    totals: {
      newRoles: results.reduce((n, r) => n + r.newRoles, 0),
      failed: results.filter((r) => r.status === "error").length,
    },
    results,
  });
}
```

- [ ] **Step 2: Generate and set the secret**

```bash
openssl rand -hex 32
```

Set the value on the `web` service:

```bash
railway variables --service web --set "CRON_SECRET=<value>"
```

- [ ] **Step 3: Verify auth rejects an unauthenticated request locally**

With `npm run dev` running and `CRON_SECRET` set in `.env.local`:

```bash
curl -s -o /dev/null -w "%{http_code}\n" "http://localhost:3000/api/cron/crawl"
```

Expected: `401`.

- [ ] **Step 4: Verify the dry run reports without writing**

```bash
curl -s -H "Authorization: Bearer $CRON_SECRET" \
  "http://localhost:3000/api/cron/crawl?dry=1&limit=2" | head -c 2000
```

Expected: JSON with `"dryRun": true` and per-company results. Confirm in the Roles tab that **no new rows** were added and that `last_checked_at` on the Watchlist page is unchanged.

- [ ] **Step 5: Deploy**

```bash
railway up --service web --detach
```

Confirm the target service is `web` before running this.

- [ ] **Step 6: Verify against the deployed service**

```bash
curl -s -H "Authorization: Bearer $CRON_SECRET" \
  "https://<web-domain>/api/cron/crawl?dry=1&limit=2"
```

Expected: same shape as local. A 401 means `CRON_SECRET` did not reach the deployed service.

- [ ] **Step 7: Create the Railway cron service**

In the `gtm-job-search` project, add a service named `crawler` with a daily cron schedule and this start command:

```bash
curl -fsS -H "Authorization: Bearer $CRON_SECRET" "$WEB_URL/api/cron/crawl"
```

Set `CRON_SECRET` (same value) and `WEB_URL` (the `web` service's public domain) on the `crawler` service.

With `BATCH_LIMIT = 10`, a daily schedule, and the 7-day default interval, this sustains about 70 tracked companies. Beyond that, companies age past their interval and are picked up in `last_checked_at` order — nothing starves, checks just stretch out. `limit` is the lever.

- [ ] **Step 8: Confirm the first scheduled run**

After the first scheduled fire, check the deploy logs:

```bash
railway logs --service crawler
```

Expected: the JSON response body with a non-zero `crawled` count. Then confirm `last_checked_at` advanced on the Watchlist page.

- [ ] **Step 9: Update `CLAUDE.md`**

Add to the Commands block:

```bash
npm test           # vitest — pure logic in the crawl path
```

Change the line "There is no test framework. `npm run build` is the pre-deploy check." to:

```markdown
`npm run build && npm test && npm run lint` is the pre-deploy check. Tests cover
the pure logic in the crawl path only (`lib/*.test.ts`) — Claude calls and live
fetches are verified through the Watchlist "Check now" button and the cron
route's `?dry=1` mode.
```

Add a new Architecture paragraph:

```markdown
**Tracking and the crawler**: `watchlist` rows with `tracking_enabled = true` are
crawled on a recurring schedule (`crawl_interval_days`, default 7).
`lib/crawler.ts` tries a plain HTTP fetch of `careers_url` and extracts roles
from the stripped text with a non-search Claude call; if `lib/page-extract.ts`
detects a JS-rendered ATS shell it falls back to the `web_search` path. The tier
that worked is remembered in `crawl_method`. `app/api/cron/crawl/route.ts` — the
app's only API route, guarded by `CRON_SECRET` — crawls up to 10 due companies
per call and is invoked daily by the Railway `crawler` cron service. ATS vendor
APIs and job aggregator APIs are deliberately not used.
```

- [ ] **Step 10: Commit**

```bash
git add app/api/cron/crawl/route.ts CLAUDE.md
git commit -m "feat: add authenticated cron crawl route and document tracking"
```

---

## Verification checklist

After Task 9, all of the following must hold:

- [ ] `npm run build && npm test && npm run lint` is clean.
- [ ] Typing a company name on `/watchlist` tracks it and returns a crawl result.
- [ ] A tracked company shows last-checked and next-check times.
- [ ] **Check now** re-crawls and updates the row.
- [ ] Roles found by a crawl appear on `/roles` with a fit score and `source` of `Crawl`.
- [ ] Re-crawling the same company adds no duplicate rows.
- [ ] A role previously marked `Rejected` is not re-added as `New`.
- [ ] **Stop tracking** moves a company to "Not tracked" and it is skipped by the cron batch.
- [ ] `GET /api/cron/crawl` with no auth header returns 401.
- [ ] `?dry=1` writes nothing.
- [ ] The Railway `crawler` service fires and advances `last_checked_at`.
