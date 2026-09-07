# Saved Résumés Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an admin save role-specific résumés as frozen documents, browse them, edit-and-resave, download them, delete them manually, and have nothing retained past 60 days.

**Architecture:** A new `saved_resumes` table holds sanitized frozen HTML, one row per explicit save, many per role; `tailored_resumes` is untouched and remains the working draft. Retention is enforced three ways — a `CRON_SECRET`-guarded purge route, an opportunistic purge on list, and a read-side filter — with both SQL predicates exported from one module so a mutation to either fails a test. All three UI screens are search-param modes of the existing `/resume` route.

**Tech Stack:** Next.js 14 App Router, TypeScript (typechecked at **ES5**), Postgres via the hand-rolled builder in `lib/supabase.ts`, vitest, `sanitize-html`.

**Spec:** `docs/superpowers/specs/2026-09-07-saved-resumes-design.md` — read it before Task 1. This plan argues from it; where they disagree, the spec wins and the plan is wrong.

## Global Constraints

- **ES5 typecheck.** `tsconfig.json` declares no `target`, so `npm run build` compiles at ES5. In every file this plan touches: **no** `/u` regex flag, **no** `\p{...}` escapes, **no** `for...of` or spread over a `Set`/`Map` (TS2802). Arrays only. `npx tsc --noEmit --target es2017` does **not** reproduce these failures — `npm run build` is the only gate that does.
- **Raw SQL needs the tenant id as `rawQuery`'s third argument.** `runAsTenant` sets an AsyncLocalStorage value, **not** the Postgres GUC. `app_rw` is `nobypassrls`, so a tenant-table query with no tenant set returns **zero rows with no error**. Adding a table to `TENANT_TABLES` protects nothing for raw SQL.
- **The builder has only `.eq`/`.neq`.** No `lt`/`gt`/`lte`/`in`. Anything using `<=`, `>` or `IN` must use `rawQuery`.
- **Errors are `{ error?: string }` and the string can be `""`.** Detect with `!== undefined`, never truthiness. Describe with `describeWriteFailure(msg, "…")` from `lib/write-failure.ts` only where the text is shown.
- **Auth guards are the first statement of every action and are never inside a `try`.** A `try/catch` that swallows the auth throw breaks `app/actions/auth-required.test.ts`, which asserts each export *throws* `/Not authenticated/`.
- **`npm run build && npm test` is the pre-commit gate.** `npm run lint` is non-functional in this repo — do not add it.
- Retention window: **60 days**. Size cap: **512 KB**. Both have exactly one definition in code.

---

### Task 1: Retention predicates and window

**Files:**
- Create: `lib/resume-retention.ts`
- Test: `lib/resume-retention.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `RETENTION_DAYS: number`, `EXPIRED_PREDICATE: string`, `LIVE_PREDICATE: string`, `expiresAtFrom(now: Date): Date`, `isExpired(expiresAt: Date, now: Date): boolean`. Tasks 5, 6 and 7 interpolate the two predicate strings into SQL.

Why the predicates are exported strings rather than typed into each query: with the `<=` and `>` living in SQL literals inside three separate call sites, no vitest test can observe them, and changing the purge's `<=` to `<` would leave every test green. CLAUDE.md records the `compFloor` `>`-not-`>=` rule as a standing two-places hazard; this closes it instead of repeating it.

- [ ] **Step 1: Write the failing test**

```ts
// lib/resume-retention.test.ts
import { describe, expect, test } from "vitest";
import {
  RETENTION_DAYS,
  EXPIRED_PREDICATE,
  LIVE_PREDICATE,
  expiresAtFrom,
  isExpired,
} from "./resume-retention";

describe("retention window", () => {
  test("expiry is exactly RETENTION_DAYS after now", () => {
    const now = new Date("2026-09-07T12:00:00.000Z");
    expect(expiresAtFrom(now).toISOString()).toBe("2026-11-06T12:00:00.000Z");
  });

  test("RETENTION_DAYS is 60", () => {
    expect(RETENTION_DAYS).toBe(60);
  });
});

describe("the boundary bites from both sides", () => {
  const now = new Date("2026-09-07T12:00:00.000Z");

  test("a row expiring exactly now IS expired", () => {
    expect(isExpired(new Date(now), now)).toBe(true);
  });

  test("a row expiring one millisecond later is NOT expired", () => {
    expect(isExpired(new Date(now.getTime() + 1), now)).toBe(false);
  });
});

describe("the two SQL predicates are exact complements", () => {
  // This is the test that catches a mutation in SQL a unit test cannot execute.
  // Both predicates are built from one column and one operator pair, so
  // changing either alone makes the pair stop being complementary.
  const COMPLEMENTS: Array<[string, string]> = [
    ["<=", ">"],
    ["<", ">="],
  ];

  function operatorOf(predicate: string): string {
    const m = predicate.match(/expires_at\s*(<=|>=|<|>)\s*now\(\)/);
    if (!m) throw new Error("predicate is not the expected shape: " + predicate);
    return m[1];
  }

  test("expired uses <= and live uses >", () => {
    expect(operatorOf(EXPIRED_PREDICATE)).toBe("<=");
    expect(operatorOf(LIVE_PREDICATE)).toBe(">");
  });

  test("the operators are a complementary pair", () => {
    const expired = operatorOf(EXPIRED_PREDICATE);
    const live = operatorOf(LIVE_PREDICATE);
    const pair = COMPLEMENTS.filter((p) => p[0] === expired && p[1] === live);
    expect(pair.length).toBe(1);
  });

  test("both predicates name the same column", () => {
    expect(EXPIRED_PREDICATE.indexOf("expires_at")).toBeGreaterThanOrEqual(0);
    expect(LIVE_PREDICATE.indexOf("expires_at")).toBeGreaterThanOrEqual(0);
  });

  test("isExpired agrees with EXPIRED_PREDICATE's operator", () => {
    // If someone changes isExpired to `<` without changing the predicate,
    // this fails: the boundary row would be live in JS and purged in SQL.
    const now = new Date("2026-09-07T12:00:00.000Z");
    const boundaryIsExpired = isExpired(new Date(now), now);
    expect(boundaryIsExpired).toBe(operatorOf(EXPIRED_PREDICATE) === "<=");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run lib/resume-retention.test.ts`
Expected: FAIL — "Failed to resolve import ./resume-retention".

- [ ] **Step 3: Write minimal implementation**

```ts
// lib/resume-retention.ts
//
// The single home of the 60-day window AND of both SQL comparisons.
//
// The predicates are exported as strings, not retyped at each call site, for a
// specific reason: the purge and the two read paths express their comparison in
// SQL, which no vitest test can execute. With `<=` and `>` sitting in three
// separate SQL literals, changing one is invisible to the whole suite. Exported,
// they become values a test can assert are complementary — see
// resume-retention.test.ts. CLAUDE.md records the compFloor `>`-not-`>=` rule as
// a live two-places hazard; this is the same hazard, closed.

export const RETENTION_DAYS = 60;

const COLUMN = "expires_at";
const EXPIRED_OP = "<=";
const LIVE_OP = ">";

/** Rows the purge collects. A row expiring exactly now IS expired. */
export const EXPIRED_PREDICATE = COLUMN + " " + EXPIRED_OP + " now()";

/** Rows reads may show. Exact complement of EXPIRED_PREDICATE. */
export const LIVE_PREDICATE = COLUMN + " " + LIVE_OP + " now()";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export function expiresAtFrom(now: Date): Date {
  return new Date(now.getTime() + RETENTION_DAYS * MS_PER_DAY);
}

/** The JS twin of EXPIRED_PREDICATE. Must agree with it — a test asserts so. */
export function isExpired(expiresAt: Date, now: Date): boolean {
  return expiresAt.getTime() <= now.getTime();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run lib/resume-retention.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Prove the tests bite (mutation check)**

Temporarily change `EXPIRED_OP` to `"<"`. Run the test again.
Expected: FAIL on "expired uses <= and live uses >" **and** on "isExpired agrees with EXPIRED_PREDICATE's operator".
Revert the change and confirm PASS. Do not commit the mutation.

- [ ] **Step 6: Commit**

```bash
git add lib/resume-retention.ts lib/resume-retention.test.ts
git commit -m "feat: retention window with SQL predicates a test can falsify"
```

---

### Task 2: Sanitizer

**Files:**
- Create: `lib/resume-sanitize.ts`
- Create: `lib/__fixtures__/resume-sanitized.html` (generated in Step 5, then checked in)
- Test: `lib/resume-sanitize.test.ts`
- Modify: `package.json` (add `sanitize-html` to dependencies, `@types/sanitize-html` to devDependencies)

**Interfaces:**
- Consumes: nothing.
- Produces: `sanitizeResumeHtml(input: string): { html?: string; error?: string }`, `MAX_HTML_BYTES: number`. Task 5's `saveResume` calls it.

Three facts this task exists to respect, each verified against real code:
1. `lib/resume-render/render.js:155` interpolates bullet text **unescaped** (`'<li>' + b.text + '</li>'`), and `lib/resume-render/content/resume.json` holds **22 `<strong>` tags**. An allowlist without `strong` silently strips every bold run from every archived résumé.
2. The HTML being sanitized is `contentEditable` output, not renderer output — Enter inserts `<br>`, Cmd-B inserts `<b>`. Stripping `<br>` deletes a user's line breaks with no message.
3. `render.js:169` emits `style="margin-bottom:0"` on the last `<section>`, and `content/resume.json` has a non-empty `education` array, so it is on every render today. Stripped, the last section regains its `--gap-section` margin, which at a page boundary is one page versus two.

- [ ] **Step 1: Install the dependency**

```bash
npm install sanitize-html
npm install --save-dev @types/sanitize-html
```

`sanitize-html` v2 ships **no** TypeScript declarations, and `skipLibCheck: true` does not help — the bare import raises TS7016 and `npm run build` typechecks. Both packages are required.

- [ ] **Step 2: Write the failing test**

```ts
// lib/resume-sanitize.test.ts
import { describe, expect, test } from "vitest";
import { sanitizeResumeHtml, MAX_HTML_BYTES } from "./resume-sanitize";

describe("markup the career record and the renderer actually produce", () => {
  test("keeps <strong>, which reaches the output unescaped from resume.json", () => {
    const out = sanitizeResumeHtml('<div class="rsm"><li>Grew <strong>40%</strong></li></div>');
    expect(out.error).toBeUndefined();
    expect(out.html).toContain("<strong>40%</strong>");
  });

  test("keeps the last section's inline margin-bottom:0", () => {
    const out = sanitizeResumeHtml('<div class="rsm"><section style="margin-bottom:0">x</section></div>');
    expect(out.html).toContain("margin-bottom");
  });

  test("keeps rsm-* classes, which every design selector hangs off", () => {
    const out = sanitizeResumeHtml('<div class="rsm"><p class="rsm-role-org">x</p></div>');
    expect(out.html).toContain('class="rsm-role-org"');
  });
});

describe("markup a browser produces when a human edits", () => {
  test("keeps <br>, which Enter inserts", () => {
    const out = sanitizeResumeHtml('<div class="rsm"><p>one<br />two</p></div>');
    expect(out.html).toContain("<br");
  });

  test("keeps <b> and <i>, which execCommand inserts", () => {
    const out = sanitizeResumeHtml('<div class="rsm"><p><b>a</b><i>b</i></p></div>');
    expect(out.html).toContain("<b>a</b>");
    expect(out.html).toContain("<i>b</i>");
  });
});

describe("what must not survive", () => {
  test("strips event handlers", () => {
    const out = sanitizeResumeHtml('<div class="rsm"><img src=x onerror="alert(1)"><p>ok</p></div>');
    expect(out.html).not.toContain("onerror");
    expect(out.html).not.toContain("<img");
  });

  test("strips <script> AND its contents, not just the tag", () => {
    const out = sanitizeResumeHtml('<div class="rsm"><script>alert(1)</script><p>ok</p></div>');
    expect(out.html).not.toContain("alert(1)");
  });

  test("rejects a javascript: href but keeps the link text", () => {
    const out = sanitizeResumeHtml('<div class="rsm"><a href="javascript:alert(1)">t</a></div>');
    expect(out.html).not.toContain("javascript:");
    expect(out.html).toContain("t");
  });

  test("keeps a mailto: href", () => {
    const out = sanitizeResumeHtml('<div class="rsm"><a href="mailto:a@b.com">m</a></div>');
    expect(out.html).toContain("mailto:a@b.com");
  });

  test("drops on-screen page guides, which rsm-page-guides.js appends INSIDE .rsm", () => {
    const guide =
      '<div class="rsm-page-guide"><div class="rsm-page-guide-tick"></div>' +
      '<span class="rsm-page-guide-label">Page 2</span></div>';
    const out = sanitizeResumeHtml('<div class="rsm"><p>keep</p>' + guide + "</div>");
    expect(out.html).not.toContain("rsm-page-guide");
    expect(out.html).not.toContain("Page 2");
    expect(out.html).toContain("keep");
  });
});

describe("refusals", () => {
  test("refuses a document with no .rsm root", () => {
    const out = sanitizeResumeHtml("<p>orphan</p>");
    expect(out.html).toBeUndefined();
    expect(out.error).toMatch(/rsm/i);
  });

  test("refuses oversize input with a stated reason", () => {
    const big = '<div class="rsm"><p>' + "x".repeat(MAX_HTML_BYTES) + "</p></div>";
    const out = sanitizeResumeHtml(big);
    expect(out.html).toBeUndefined();
    expect(out.error).toMatch(/too large|512/i);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run lib/resume-sanitize.test.ts`
Expected: FAIL — cannot resolve `./resume-sanitize`.

- [ ] **Step 4: Write the implementation**

```ts
// lib/resume-sanitize.ts
//
// The allowlist is derived from THREE sources, not one. An earlier design took
// it from renderBody's literal tag output, which is wrong twice:
//
//  1. render.js does not escape bullet text (:155), role title (:149) or the
//     <b> interpolations (:161,:173), and content/resume.json carries 22
//     <strong> tags. A list without `strong` silently strips every bold run
//     from every archived résumé.
//  2. What gets saved is contentEditable output, not renderer output. Enter
//     inserts <br>; execCommand inserts <b>/<i>. Dropping those deletes a
//     user's edits with no message — likelier than the <img onerror> paste
//     this module is built for.
//
// The `style` exception is real too: render.js:169 emits
// style="margin-bottom:0" on the last section on every render, and stripping it
// restores a bottom margin that at a page boundary is one page versus two.
import sanitizeHtml from "sanitize-html";

export const MAX_HTML_BYTES = 512 * 1024;

const ALLOWED_TAGS = [
  "div", "span", "p", "b", "strong", "i", "em", "u", "br",
  "section", "header", "h1", "h2", "h3",
  "ul", "ol", "li", "dl", "dt", "dd", "a",
];

// Matches `rsm` and `rsm-anything`. No /u flag: the build typechecks at ES5.
const RSM_CLASS = /^rsm(-[a-z0-9-]+)?$/;

// rsm-page-guides.js appends its overlay INSIDE the .rsm element (:138) and puts
// the styles in document.head (:59), so the nodes travel with a capture while
// their styling does not. Its @media print hide (:57) is why this never showed
// up in printing.
const PAGE_GUIDE_CLASS = /(^|\s)rsm-page-guide/;

export function sanitizeResumeHtml(input: string): { html?: string; error?: string } {
  const bytes = Buffer.byteLength(input, "utf8");
  if (bytes > MAX_HTML_BYTES) {
    return {
      error:
        "That résumé is too large to save (" +
        Math.round(bytes / 1024) +
        " KB; the limit is 512 KB). Try removing pasted images or formatting.",
    };
  }

  const html = sanitizeHtml(input, {
    allowedTags: ALLOWED_TAGS,
    allowedAttributes: { "*": ["class"], a: ["href"], section: ["style"] },
    allowedClasses: { "*": [RSM_CLASS] },
    allowedStyles: { section: { "margin-bottom": [/^0$/] } },
    allowedSchemes: ["http", "https", "mailto"],
    // nonTextTags is DELIBERATELY not overridden. Its default
    // ['script','style','textarea','option'] is what drops <script>'s CONTENTS
    // rather than only its tag — a "script stripped" test would otherwise pass
    // while the payload survived as visible text.
    exclusiveFilter: (frame) =>
      PAGE_GUIDE_CLASS.test((frame.attribs && frame.attribs.class) || ""),
  });

  // document.css:5 scopes the whole design to `.rsm`. Capturing one level too
  // deep loses that root and the saved résumé renders as unstyled body text —
  // invisible until after the row is written, so it is refused here instead.
  if (!/<div[^>]*class="[^"]*\brsm\b[^"]*"/.test(html)) {
    return { error: "That résumé could not be saved: its document root is missing." };
  }

  return { html };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run lib/resume-sanitize.test.ts`
Expected: PASS, 12 tests.

If "keeps the last section's inline margin-bottom:0" fails, check the `allowedStyles` regex — `sanitize-html` normalises `margin-bottom:0` to `margin-bottom:0`; do not loosen the regex to `/.*/`.

- [ ] **Step 6: Add the fixture round-trip test**

This is the test that catches an upstream change in the vendored renderer or in the career record — the same discipline CLAUDE.md applies to the fit-prompt fixtures. Append to `lib/resume-sanitize.test.ts`:

```ts
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { renderBody } from "./resume-render/render";
import type { CareerRecord } from "./resume-render/render";
import career from "./resume-render/content/resume.json";

describe("the shipped career record survives sanitization unchanged", () => {
  const FIXTURE = join(__dirname, "__fixtures__", "resume-sanitized.html");

  test("sanitizing the full render matches the checked-in fixture", () => {
    const rendered = renderBody(career as CareerRecord);
    const out = sanitizeResumeHtml(rendered);
    expect(out.error).toBeUndefined();
    expect(existsSync(FIXTURE)).toBe(true);
    expect(out.html).toBe(readFileSync(FIXTURE, "utf8"));
  });

  test("every <strong> in the career record survives", () => {
    const rendered = renderBody(career as CareerRecord);
    const before = (rendered.match(/<strong>/g) || []).length;
    const after = ((sanitizeResumeHtml(rendered).html || "").match(/<strong>/g) || []).length;
    expect(before).toBeGreaterThan(0);
    expect(after).toBe(before);
  });
});
```

Generate the fixture once:

```bash
node -e "const {renderBody}=require('./lib/resume-render/render.js');const c=require('./lib/resume-render/content/resume.json');process.stdout.write(renderBody(c))" > /tmp/rendered.html
```

Then write a throwaway `lib/__gen-fixture.test.ts` that imports `sanitizeResumeHtml`, sanitizes `/tmp/rendered.html`, and writes the result to `lib/__fixtures__/resume-sanitized.html` (vitest is needed so the `@/` alias and TS resolve). Run it, **read the generated file's diff**, delete the throwaway test.

Regenerating this fixture later requires reading the diff in the same commit — a commit that touches only the fixture is a red flag, not a routine refresh. That rule is CLAUDE.md's, and it applies here for the same reason.

- [ ] **Step 7: Run the full suite and build**

Run: `npm test && npm run build`
Expected: both PASS. If the build fails with TS7016, `@types/sanitize-html` was not installed.

- [ ] **Step 8: Commit**

```bash
git add package.json package-lock.json lib/resume-sanitize.ts lib/resume-sanitize.test.ts lib/__fixtures__/resume-sanitized.html
git commit -m "feat: résumé HTML sanitizer with an allowlist derived from renderer, content and browser output"
```

---

### Task 3: Migration and tenant-table registration

**Files:**
- Create: `db/migrations/016_saved_resumes.sql`
- Modify: `lib/supabase.ts` (`TENANT_TABLES`, around line 127-142)

**Interfaces:**
- Consumes: nothing.
- Produces: the `saved_resumes` table. Tasks 5 and 6 query it.

- [ ] **Step 1: Write the migration**

```sql
-- db/migrations/016_saved_resumes.sql
-- The résumé ARCHIVE: one row per explicit save, many per job. Distinct from
-- tailored_resumes, which stays the working draft (one per job, upserted by
-- Regenerate, holding {themes, selection}). Two tables because they have
-- different lifetimes and only one expires.
--
-- job_id KEEPS its foreign key, as ON DELETE SET NULL. An earlier design
-- dropped it, reasoning that a referential action against a FORCE RLS table was
-- unsafe to assume — this repo already disproves that: tailored_resumes is
-- force row level security (015:24-25) with job_id ... on delete cascade
-- (015:15), and app/actions/jobs.ts:89 genuinely deletes jobs. Postgres
-- documents RI checks as always bypassing row security. Keeping the FK also
-- makes "is this job gone?" the column `job_id is null` rather than a probe
-- against jobs for every card rendered.
--
-- Same explicit grant as 004 and 015: this is a new table with tenant_id
-- declared inline, so it also needs a manual addition to TENANT_TABLES in
-- lib/supabase.ts (the guard test's regex only sees ALTER TABLE retrofits).

create table if not exists saved_resumes (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references users(id) on delete cascade,
  job_id         uuid references jobs(id) on delete set null,
  role_title     text not null,
  company        text not null,
  label          text,
  html           text not null,
  design_version text not null,
  content_hash   text not null,
  created_at     timestamptz not null default now(),
  expires_at     timestamptz not null
);

-- Both indexes lead with tenant_id because EVERY query against this table is
-- tenant-scoped, the purge included.
create index if not exists saved_resumes_tenant_created_idx
  on saved_resumes (tenant_id, created_at desc);
create index if not exists saved_resumes_tenant_expires_idx
  on saved_resumes (tenant_id, expires_at);

alter table saved_resumes enable row level security;
alter table saved_resumes force row level security;

drop policy if exists tenant_isolation on saved_resumes;

create policy tenant_isolation on saved_resumes
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

grant select, insert, update, delete on saved_resumes to app_rw;
```

- [ ] **Step 2: Register the table**

In `lib/supabase.ts`, inside `TENANT_TABLES` (after `"tailored_resumes"`):

```ts
  // Added by migration 016. Same inline-tenant_id pattern as tailored_resumes
  // above, so likewise invisible to lib/supabase.test.ts's retrofit regex.
  // NOTE: this registration protects the BUILDER only. The purge, both reads
  // and the bulk delete use rawQuery, where the tenant id must be passed as the
  // third argument or the statement runs unscoped and silently matches nothing.
  "saved_resumes",
```

- [ ] **Step 3: Verify the migration applies**

```bash
railway run --service Postgres sh -c 'DATABASE_URL="$DATABASE_PUBLIC_URL" node db/migrate.mjs --dry'
```

Expected: 016 listed as pending. Do **not** apply yet — apply in Task 13 alongside the deploy.

Never apply this by hand and never through `db/apply-schema.mjs`: the former desyncs the `schema_migrations` ledger, the latter re-creates the `insights_cache` table that `006_drop_insights.sql` dropped.

- [ ] **Step 4: Run the guard suite**

Run: `npm test && npm run build`
Expected: PASS, including `lib/supabase.test.ts`.

- [ ] **Step 5: Commit**

```bash
git add db/migrations/016_saved_resumes.sql lib/supabase.ts
git commit -m "feat: saved_resumes table with RLS, tenant-leading indexes and FK to jobs"
```

---

### Task 4: Extract the admin gate

**Files:**
- Create: `lib/require-resume-admin.ts`
- Modify: `app/actions/resume.ts:20-30` (remove the local helper, import instead)
- Test: `app/actions/resume.test.ts` (unchanged — it must still pass)

**Interfaces:**
- Consumes: `requireActor` from `@/lib/require-actor`.
- Produces: `requireResumeAdmin(): Promise<Actor>`. Task 5's actions call it.

This is its own task because it is the single edit most likely to break the admin gate, and it must be provably green before anything is built on it. The move is also *necessary*, not cosmetic: in a `"use server"` file every export becomes a POSTable RPC endpoint addressed by an id in the client bundle, so exporting an auth helper from `resume.ts` would publish it.

- [ ] **Step 1: Run the existing admin test first, to establish a baseline**

Run: `npx vitest run app/actions/resume.test.ts`
Expected: PASS, 3 tests. If this is already failing, stop — something else is wrong.

- [ ] **Step 2: Create the shared helper**

```ts
// lib/require-resume-admin.ts
//
// The admin gate for every résumé surface, in ONE place.
//
// It lives in lib/ rather than in a "use server" file because in such a file
// every export becomes a POSTable RPC endpoint addressed by an id that ships in
// the client bundle — exporting an auth helper there would publish it.
//
// Mirrors app/actions/admin.ts's requireAdmin() exactly, and exists for the
// reason app/actions/auth-required.test.ts's own doc comment gives: a
// hand-written check is one someone forgets when adding the 37th action.
import { requireActor } from "@/lib/require-actor";

export async function requireResumeAdmin() {
  const actor = await requireActor();
  if (!actor.isAdmin) throw new Error("Not authorized");
  return actor;
}
```

- [ ] **Step 3: Use it in `app/actions/resume.ts`**

Delete the local `requireResumeAdmin` function (and its doc comment, which moves to the new file) and add to the imports:

```ts
import { requireResumeAdmin } from "@/lib/require-resume-admin";
```

Leave `import { requireActor } from "@/lib/require-actor";` only if something else in the file still uses it; if not, remove it.

- [ ] **Step 4: Run the admin test again**

Run: `npx vitest run app/actions/resume.test.ts`
Expected: PASS, 3 tests, unchanged. The test mocks `@/lib/require-actor`, which the new module imports, so the mock still reaches it.

- [ ] **Step 5: Run the full suite and build**

Run: `npm test && npm run build`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add lib/require-resume-admin.ts app/actions/resume.ts
git commit -m "refactor: share the résumé admin gate from lib/ instead of a use-server export"
```

---

### Task 5: Saved-résumé actions

**Files:**
- Create: `app/actions/saved-resumes.ts`
- Create: `app/actions/saved-resumes.test.ts`
- Modify: `lib/types.ts` (add `SavedResumeSummary`, `SavedResume`)

**Interfaces:**
- Consumes: `requireResumeAdmin` (Task 4), `sanitizeResumeHtml`/`MAX_HTML_BYTES` (Task 2), `EXPIRED_PREDICATE`/`LIVE_PREDICATE`/`expiresAtFrom` (Task 1), the `saved_resumes` table (Task 3).
- Produces:

```ts
saveResume(input: SaveResumeInput): Promise<{ id?: string; duplicateOf?: string; error?: string }>
listSavedResumes(): Promise<{ resumes: SavedResumeSummary[]; error?: string }>
getSavedResume(id: string): Promise<{ resume: SavedResume | null; error?: string }>
deleteSavedResume(id: string): Promise<{ error?: string }>
deleteSavedResumes(ids: string[]): Promise<{ deleted: number; error?: string }>
getDownloadAssets(): Promise<{ css: string; docPageJs: string; error?: string }>
```

Tasks 10, 11 and 12 call these.

- [ ] **Step 1: Add the types**

In `lib/types.ts`:

```ts
export interface SavedResumeSummary {
  id: string;
  /** null means the tracked role was deleted; the row deliberately survives it. */
  jobId: string | null;
  roleTitle: string;
  company: string;
  label: string | null;
  createdAt: string;
  expiresAt: string;
}

/**
 * `html` is deliberately absent from the summary above: at up to 512 KB per row
 * it would make the archive list ship every document in the tenant. It is
 * fetched on demand by getSavedResume.
 */
export interface SavedResume extends SavedResumeSummary {
  html: string;
  designVersion: string;
}

export interface SaveResumeInput {
  jobId: string;
  html: string;
  /** Snapshotted onto the row so the archive survives the job being deleted. */
  roleTitle: string;
  company: string;
  label?: string | null;
  /** Set by the client after the user confirms an identical re-save. */
  allowDuplicate?: boolean;
}
```

- [ ] **Step 2: Write the failing admin-gate test**

This is the coverage `auth-required.test.ts` cannot provide. `2026-08-24-resume-builder-design.md:543-549` states plainly that the blanket session-less test "passes regardless of whether the `isAdmin` gate is even present."

```ts
// app/actions/saved-resumes.test.ts
//
// Pins what app/actions/auth-required.test.ts structurally cannot: a
// SESSION-HOLDING but non-admin actor must still be refused. Exact mirror of
// app/actions/resume.test.ts.
import { describe, expect, test, vi } from "vitest";

vi.mock("@/lib/require-actor", () => ({
  requireActor: async () => ({
    userId: "u1",
    tenantId: "u1",
    email: "someone@example.com",
    isAdmin: false,
  }),
}));

import {
  saveResume,
  listSavedResumes,
  getSavedResume,
  deleteSavedResume,
  deleteSavedResumes,
  getDownloadAssets,
} from "./saved-resumes";

const ID = "11111111-1111-1111-1111-111111111111";

describe("saved-resumes.ts refuses a non-admin actor", () => {
  test("saveResume", async () => {
    await expect(
      saveResume({ jobId: ID, html: "<div class=\"rsm\"></div>", roleTitle: "t", company: "c" })
    ).rejects.toThrow(/Not authorized/);
  });
  test("listSavedResumes", async () => {
    await expect(listSavedResumes()).rejects.toThrow(/Not authorized/);
  });
  test("getSavedResume", async () => {
    await expect(getSavedResume(ID)).rejects.toThrow(/Not authorized/);
  });
  test("deleteSavedResume", async () => {
    await expect(deleteSavedResume(ID)).rejects.toThrow(/Not authorized/);
  });
  test("deleteSavedResumes", async () => {
    await expect(deleteSavedResumes([ID])).rejects.toThrow(/Not authorized/);
  });
  test("getDownloadAssets", async () => {
    await expect(getDownloadAssets()).rejects.toThrow(/Not authorized/);
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npx vitest run app/actions/saved-resumes.test.ts`
Expected: FAIL — cannot resolve `./saved-resumes`.

- [ ] **Step 4: Write the actions**

```ts
// app/actions/saved-resumes.ts
"use server";

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { requireResumeAdmin } from "@/lib/require-resume-admin";
import { supabase, rawQuery } from "@/lib/supabase";
import { describeWriteFailure } from "@/lib/write-failure";
import { sanitizeResumeHtml } from "@/lib/resume-sanitize";
import { EXPIRED_PREDICATE, LIVE_PREDICATE, expiresAtFrom } from "@/lib/resume-retention";
import { DESIGN_VERSION, TOKEN_CSS_FILES } from "@/lib/resume-download";
import type { SavedResume, SavedResumeSummary, SaveResumeInput } from "@/lib/types";

interface SavedRow {
  id: string;
  job_id: string | null;
  role_title: string;
  company: string;
  label: string | null;
  created_at: string;
  expires_at: string;
  html?: string;
  design_version?: string;
}

function toSummary(r: SavedRow): SavedResumeSummary {
  return {
    id: r.id,
    jobId: r.job_id,
    roleTitle: r.role_title,
    company: r.company,
    label: r.label,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
  };
}

export async function saveResume(
  input: SaveResumeInput
): Promise<{ id?: string; duplicateOf?: string; error?: string }> {
  // FIRST statement, never inside a try — auth-required.test.ts asserts this
  // THROWS, and a top-level catch would turn it into a returned {error}.
  const actor = await requireResumeAdmin();

  const clean = sanitizeResumeHtml(input.html);
  if (clean.error !== undefined) return { error: clean.error };
  const html = clean.html as string;
  const contentHash = createHash("sha256").update(html).digest("hex");

  // Duplicate check against this job's newest saved row. Without it, saving the
  // algorithmic render three times leaves three cards differing only by a
  // timestamp, permanently.
  if (!input.allowDuplicate) {
    const { data, error } = await rawQuery<{ id: string }>(
      "select id from saved_resumes where tenant_id = $1 and job_id = $2 and " +
        LIVE_PREDICATE +
        " order by created_at desc limit 1",
      [actor.tenantId, input.jobId],
      actor.tenantId // <- sets app.tenant_id; without it this matches nothing
    );
    const described = describeWriteFailure(
      error ? error.message : undefined,
      "check for an identical saved résumé"
    );
    if (described !== undefined) return { error: described };
    if (data.length > 0) {
      const dup = await rawQuery<{ id: string }>(
        "select id from saved_resumes where tenant_id = $1 and id = $2 and content_hash = $3",
        [actor.tenantId, data[0].id, contentHash],
        actor.tenantId
      );
      if (dup.data.length > 0) return { duplicateOf: dup.data[0].id };
    }
  }

  const now = new Date();
  const { data, error } = await rawQuery<{ id: string }>(
    "insert into saved_resumes " +
      "(tenant_id, job_id, role_title, company, label, html, design_version, content_hash, expires_at) " +
      "values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning id",
    [
      actor.tenantId,
      input.jobId,
      input.roleTitle,
      input.company,
      input.label ? input.label : null, // "" is stored as null: one unlabelled state, not two
      html,
      DESIGN_VERSION,
      contentHash,
      expiresAtFrom(now).toISOString(),
    ],
    actor.tenantId
  );
  const described = describeWriteFailure(error ? error.message : undefined, "save that résumé");
  if (described !== undefined) return { error: described };
  return { id: data[0].id };
}

export async function listSavedResumes(): Promise<{
  resumes: SavedResumeSummary[];
  error?: string;
}> {
  const actor = await requireResumeAdmin();

  // Opportunistic purge. The promise the user was given is about STORAGE, and
  // CLAUDE.md records this repo's cron route 404-ing nightly for days with
  // nothing surfacing it — so an active user's own retention must not depend on
  // cron uptime. One indexed statement against an index that already exists.
  const purge = await rawQuery(
    "delete from saved_resumes where tenant_id = $1 and " + EXPIRED_PREDICATE,
    [actor.tenantId],
    actor.tenantId
  );
  if (purge.error) console.error("listSavedResumes opportunistic purge failed:", purge.error);

  const { data, error } = await rawQuery<SavedRow>(
    "select id, job_id, role_title, company, label, created_at, expires_at " +
      "from saved_resumes where tenant_id = $1 and " +
      LIVE_PREDICATE +
      " order by created_at desc",
    [actor.tenantId],
    actor.tenantId
  );
  if (error) {
    console.error("listSavedResumes error:", error);
    return { resumes: [], error: describeWriteFailure(error.message, "load your saved résumés") };
  }
  return { resumes: data.map(toSummary) };
}

export async function getSavedResume(
  id: string
): Promise<{ resume: SavedResume | null; error?: string }> {
  const actor = await requireResumeAdmin();

  const { data, error } = await rawQuery<SavedRow>(
    "select id, job_id, role_title, company, label, created_at, expires_at, html, design_version " +
      "from saved_resumes where tenant_id = $1 and id = $2 and " +
      LIVE_PREDICATE,
    [actor.tenantId, id],
    actor.tenantId
  );
  if (error) {
    console.error("getSavedResume error:", error);
    return { resume: null, error: describeWriteFailure(error.message, "load that saved résumé") };
  }
  // null is a genuine "not here" — either never existed or expired. The caller
  // renders a not-found state naming expiry as the likely cause.
  if (data.length === 0) return { resume: null };
  const r = data[0];
  return {
    resume: {
      ...toSummary(r),
      html: r.html as string,
      designVersion: r.design_version as string,
    },
  };
}

export async function deleteSavedResume(id: string): Promise<{ error?: string }> {
  const actor = await requireResumeAdmin();
  // Single id and equality only, so the builder can express it.
  const { error } = await supabase
    .forTenant(actor.tenantId)
    .from("saved_resumes")
    .delete()
    .eq("id", id);
  const described = describeWriteFailure(
    error ? error.message : undefined,
    "delete that saved résumé"
  );
  // Deleting a row that is already gone is the outcome the user wanted: no error.
  if (described !== undefined) return { error: described };
  return {};
}

export async function deleteSavedResumes(
  ids: string[]
): Promise<{ deleted: number; error?: string }> {
  const actor = await requireResumeAdmin();
  if (ids.length === 0) return { deleted: 0 };
  // IN lists are not expressible in the builder — rawQuery, tenant id passed.
  const { data, error } = await rawQuery<{ id: string }>(
    "delete from saved_resumes where tenant_id = $1 and id = any($2::uuid[]) returning id",
    [actor.tenantId, ids],
    actor.tenantId
  );
  const described = describeWriteFailure(
    error ? error.message : undefined,
    "delete those saved résumés"
  );
  if (described !== undefined) return { deleted: 0, error: described };
  return { deleted: data.length };
}

/**
 * The design assets a downloaded file must carry, read from public/ on the
 * server and cached for the process. doc-page.js is NOT optional: its own
 * source says "never write your own @page rule" (:30) and there are no @page
 * rules anywhere in the token CSS — all print geometry lives in the component.
 */
let assetCache: { css: string; docPageJs: string } | null = null;

export async function getDownloadAssets(): Promise<{
  css: string;
  docPageJs: string;
  error?: string;
}> {
  await requireResumeAdmin();
  if (assetCache) return assetCache;
  try {
    const base = join(process.cwd(), "public", "resume-design");
    const css = TOKEN_CSS_FILES.map((f) =>
      readFileSync(join(base, "tokens", f), "utf8")
    ).join("\n");
    const docPageJs = readFileSync(join(base, "doc-page.js"), "utf8");
    assetCache = { css, docPageJs };
    return assetCache;
  } catch (err) {
    // Not a database failure, so UNDESCRIBED_DB_ERROR would name the wrong
    // thing — this substitutes its own fallback at the catch, as the actions
    // whose failure is not the database do.
    console.error("getDownloadAssets error:", err);
    return { css: "", docPageJs: "", error: "Could not assemble the download." };
  }
}
```

- [ ] **Step 5: Run the admin test to verify it passes**

Run: `npx vitest run app/actions/saved-resumes.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 6: Run the blanket session-less test**

Run: `npx vitest run app/actions/auth-required.test.ts`
Expected: PASS — the file globs `app/actions/*.ts`, so the new file is picked up with no edit. If any export FAILS here, the cause is an auth guard that is not the first statement or that sits inside a `try`.

- [ ] **Step 7: Run the full suite and build**

Run: `npm test && npm run build`
Expected: PASS. Task 9 creates `lib/resume-download.ts`; if it does not exist yet, do Task 9 first — the import above needs it.

- [ ] **Step 8: Commit**

```bash
git add app/actions/saved-resumes.ts app/actions/saved-resumes.test.ts lib/types.ts
git commit -m "feat: saved-résumé actions with tenant-scoped raw SQL and an admin-gate test"
```

---

### Task 6: Tenant enumeration and the purge

**Files:**
- Create: `lib/saved-resume-purge.ts`
- Create: `lib/saved-resume-purge.test.ts`
- Modify: `app/actions/admin.ts` (add `listAllTenantIds`, near `listCrawlableTenants` at :127)

**Interfaces:**
- Consumes: `EXPIRED_PREDICATE` (Task 1), `isPlatform` from `@/lib/platform-context`, `rawQuery`.
- Produces: `listAllTenantIds(): Promise<{ tenantIds: string[]; error?: string }>`, `runPurge(deps): Promise<PurgeReport>`. Task 7's route calls both.

- [ ] **Step 1: Add the enumeration**

In `app/actions/admin.ts`, after `listCrawlableTenants`:

```ts
/**
 * EVERY tenant, whatever their account status.
 *
 * Deliberately NOT listCrawlableTenants(), which filters status = 'active'.
 * That filter is right for deciding who to spend money crawling and wrong for a
 * retention guarantee: a suspended or pending user's saved résumés would never
 * be purged, and the promise made to the user is about storage.
 *
 * `users` is not RLS-protected (absent from 003's and 004's table lists), so
 * this needs no tenant scope. The literal "Not authenticated" matters:
 * app/actions/auth-required.test.ts asserts rejects.toThrow(/Not authenticated/),
 * and the sibling idiom in this same feature (requireResumeAdmin) throws
 * "Not authorized", which would not match.
 */
export async function listAllTenantIds(): Promise<{ tenantIds: string[]; error?: string }> {
  if (!isPlatform()) throw new Error("Not authenticated");
  const { data, error } = await rawQuery<{ id: string }>(
    `select id from users order by created_at`
  );
  const described = describeWriteFailure(
    error ? error.message : undefined,
    "list tenants for the résumé purge"
  );
  if (described !== undefined) return { tenantIds: [], error: described };
  return { tenantIds: data.map((r) => r.id) };
}
```

- [ ] **Step 2: Write the failing purge test**

```ts
// lib/saved-resume-purge.test.ts
//
// runPurge takes its dependencies as arguments precisely so these two
// behaviours are pure logic. npm test covers pure logic only; a purge that
// reached the database directly would have no seam and these assertions —
// the two most likely to pass vacuously — could not be written at all.
import { describe, expect, test } from "vitest";
import { runPurge } from "./saved-resume-purge";

describe("runPurge", () => {
  test("purges every tenant the enumerator returns, not just active ones", async () => {
    const seen: string[] = [];
    const report = await runPurge({
      listTenants: async () => ({ tenantIds: ["a", "b", "c"] }),
      purgeTenant: async (id) => {
        seen.push(id);
        return { deleted: 2 };
      },
      oldestSurviving: async () => null,
    });
    expect(seen).toEqual(["a", "b", "c"]);
    expect(report.tenants).toBe(3);
    expect(report.deleted).toBe(6);
    expect(report.failed).toBe(0);
  });

  test("one tenant failing does not abort the others", async () => {
    const seen: string[] = [];
    const report = await runPurge({
      listTenants: async () => ({ tenantIds: ["a", "b", "c"] }),
      purgeTenant: async (id) => {
        seen.push(id);
        if (id === "b") return { deleted: 0, error: "boom" };
        return { deleted: 1 };
      },
      oldestSurviving: async () => null,
    });
    expect(seen).toEqual(["a", "b", "c"]);
    expect(report.deleted).toBe(2);
    expect(report.failed).toBe(1);
  });

  test("an enumeration failure is reported, not swallowed", async () => {
    const report = await runPurge({
      listTenants: async () => ({ tenantIds: [], error: "cannot list" }),
      purgeTenant: async () => ({ deleted: 0 }),
      oldestSurviving: async () => null,
    });
    expect(report.error).toBe("cannot list");
    expect(report.tenants).toBe(0);
  });

  test("dryRun counts without deleting", async () => {
    let deletes = 0;
    const report = await runPurge({
      listTenants: async () => ({ tenantIds: ["a"] }),
      purgeTenant: async () => {
        deletes += 1;
        return { deleted: 1 };
      },
      countTenant: async () => 4,
      oldestSurviving: async () => null,
      dryRun: true,
    });
    expect(deletes).toBe(0);
    expect(report.deleted).toBe(4);
  });

  test("reports the oldest surviving expiry so a stalled purge is detectable", async () => {
    const report = await runPurge({
      listTenants: async () => ({ tenantIds: ["a"] }),
      purgeTenant: async () => ({ deleted: 0 }),
      oldestSurviving: async () => "2026-09-01T00:00:00.000Z",
    });
    expect(report.oldestSurviving).toBe("2026-09-01T00:00:00.000Z");
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npx vitest run lib/saved-resume-purge.test.ts`
Expected: FAIL — cannot resolve `./saved-resume-purge`.

- [ ] **Step 4: Write the purge**

```ts
// lib/saved-resume-purge.ts
//
// The retention purge, with its dependencies injected so the two behaviours
// that matter — enumeration covers every tenant, and one tenant's failure does
// not abort the rest — are testable as pure logic.
//
// THE TRAP THIS MODULE EXISTS TO AVOID: runAsTenant() sets an AsyncLocalStorage
// value, NOT the Postgres GUC. app_rw is nobypassrls, so a tenant-table
// statement with no tenant set matches ZERO ROWS AND RETURNS NO ERROR. The
// tenant id must be passed to rawQuery as its third argument. This follows
// getBudgetOverview (app/actions/admin.ts:159-166, :205-207), which passes it
// straight through and uses no runAsTenant at all — not crawl-next, which needs
// runAsTenant only because it calls server actions that resolve their own
// tenant.
import { rawQuery } from "@/lib/supabase";
import { EXPIRED_PREDICATE } from "@/lib/resume-retention";

export interface PurgeReport {
  deleted: number;
  tenants: number;
  failed: number;
  oldestSurviving: string | null;
  error?: string;
}

export interface PurgeDeps {
  listTenants: () => Promise<{ tenantIds: string[]; error?: string }>;
  purgeTenant: (tenantId: string) => Promise<{ deleted: number; error?: string }>;
  countTenant?: (tenantId: string) => Promise<number>;
  oldestSurviving: () => Promise<string | null>;
  dryRun?: boolean;
}

export async function runPurge(deps: PurgeDeps): Promise<PurgeReport> {
  const listed = await deps.listTenants();
  if (listed.error !== undefined) {
    return { deleted: 0, tenants: 0, failed: 0, oldestSurviving: null, error: listed.error };
  }

  let deleted = 0;
  let failed = 0;
  const ids = listed.tenantIds;
  // Indexed loop, not for...of: the build typechecks at ES5.
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i];
    try {
      if (deps.dryRun) {
        deleted += deps.countTenant ? await deps.countTenant(id) : 0;
      } else {
        const res = await deps.purgeTenant(id);
        if (res.error !== undefined) {
          // One tenant's failure is logged and skipped, never fatal to the
          // others — the rule crawl-next applies to a failed candidate read.
          console.error("saved-resume purge failed for a tenant:", res.error);
          failed += 1;
        } else {
          deleted += res.deleted;
        }
      }
    } catch (err) {
      console.error("saved-resume purge threw for a tenant:", err);
      failed += 1;
    }
  }

  return {
    deleted,
    tenants: ids.length,
    failed,
    oldestSurviving: await deps.oldestSurviving(),
  };
}

/** The real dependencies. Every one passes the tenant id to rawQuery. */
export function liveDeps(
  listTenants: PurgeDeps["listTenants"],
  dryRun: boolean
): PurgeDeps {
  return {
    listTenants,
    dryRun,
    purgeTenant: async (tenantId) => {
      const { data, error } = await rawQuery<{ id: string }>(
        "delete from saved_resumes where tenant_id = $1 and " +
          EXPIRED_PREDICATE +
          " returning id",
        [tenantId],
        tenantId
      );
      if (error) return { deleted: 0, error: error.message };
      return { deleted: data.length };
    },
    countTenant: async (tenantId) => {
      const { data } = await rawQuery<{ n: string }>(
        "select count(*)::text as n from saved_resumes where tenant_id = $1 and " +
          EXPIRED_PREDICATE,
        [tenantId],
        tenantId
      );
      return data.length > 0 ? parseInt(data[0].n, 10) : 0;
    },
    // Deliberately unscoped and therefore expected to return nothing under RLS;
    // it is a diagnostic, not a read of anyone's data. Reported as null when the
    // policy filters it, which is correct: the platform cannot see tenant rows.
    oldestSurviving: async () => {
      const { data } = await rawQuery<{ oldest: string | null }>(
        "select min(expires_at)::text as oldest from saved_resumes"
      );
      return data.length > 0 ? data[0].oldest : null;
    },
  };
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run lib/saved-resume-purge.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 6: Prove the tests bite**

Temporarily change the loop to `if (res.error !== undefined) return { ...report, failed: 1 }` (an early return instead of continue). Run again.
Expected: FAIL on "one tenant failing does not abort the others". Revert.

- [ ] **Step 7: Run the full suite and build**

Run: `npm test && npm run build`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add lib/saved-resume-purge.ts lib/saved-resume-purge.test.ts app/actions/admin.ts
git commit -m "feat: retention purge over every tenant, with the tenant id passed to rawQuery"
```

---

### Task 7: Purge cron route

**Files:**
- Create: `app/api/cron/purge-resumes/route.ts`

**Interfaces:**
- Consumes: `cronAuthorized`, `runAsPlatform`, `listAllTenantIds` (Task 6), `runPurge`/`liveDeps` (Task 6).
- Produces: `GET` returning `{ deleted, tenants, failed, oldestSurviving }`.

- [ ] **Step 1: Write the route**

```ts
// app/api/cron/purge-resumes/route.ts
import { NextResponse } from "next/server";
import { cronAuthorized } from "@/lib/cron-auth";
import { runAsPlatform } from "@/lib/platform-context";
import { listAllTenantIds } from "@/app/actions/admin";
import { runPurge, liveDeps } from "@/lib/saved-resume-purge";

export const dynamic = "force-dynamic";

/**
 * Deletes saved résumés past their 60-day window, for every tenant.
 *
 * This is the PRIMARY retention mechanism. Two others back it: listSavedResumes
 * purges the calling tenant opportunistically (so an active user's retention
 * survives this route being down — CLAUDE.md records the crawl route 404-ing
 * nightly for days with nothing surfacing it), and both reads filter
 * LIVE_PREDICATE so an unpurged expired row is never shown.
 *
 * `oldestSurviving` is reported so a STALLED purge is detectable from the
 * route's own output rather than from someone noticing an old row.
 */
export async function GET(req: Request) {
  if (!cronAuthorized(req)) {
    return new NextResponse(null, { status: 401 });
  }
  // Deliberately INSIDE the authorization check: the platform identity is
  // granted by CRON_SECRET, never by reaching this file.
  return runAsPlatform(async () => {
    const url = new URL(req.url);
    // Same doctrine as both crawl routes: any presence of `dry` means dry-run
    // unless explicitly disabled, so an unrecognised spelling fails toward not
    // writing.
    const dryParam = url.searchParams.get("dry");
    const dryRun = dryParam !== null && dryParam !== "0" && dryParam !== "false";

    const report = await runPurge(liveDeps(listAllTenantIds, dryRun));

    console.log(
      `cron/purge-resumes: dryRun=${dryRun} deleted=${report.deleted} ` +
        `tenants=${report.tenants} failed=${report.failed} ` +
        `oldestSurviving=${report.oldestSurviving ?? "none"}`
    );

    if (report.error !== undefined) {
      return NextResponse.json({ ...report }, { status: 500 });
    }
    // A run that reports {deleted: n} while half the tenants errored is the
    // silent-success shape .claude/skills/swallowed-string-errors exists for.
    return NextResponse.json({ ...report }, { status: report.failed > 0 ? 500 : 200 });
  });
}
```

- [ ] **Step 2: Verify the auth test still passes**

Run: `npx vitest run app/actions/auth-required.test.ts`
Expected: PASS. Route handlers are not in `app/actions/`, so nothing new is scanned; this confirms `listAllTenantIds` did not break the existing scan.

- [ ] **Step 3: Run the full suite and build**

Run: `npm test && npm run build`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add app/api/cron/purge-resumes/route.ts
git commit -m "feat: CRON_SECRET-guarded résumé purge route reporting failures and oldest survivor"
```

---

### Task 8: Download assembly

**Files:**
- Create: `lib/resume-download.ts`
- Test: `lib/resume-download.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `DESIGN_VERSION: string`, `TOKEN_CSS_FILES: string[]`, `buildDownloadHtml(args): string`, `downloadFilename(roleTitle, company, createdAt): string`. Task 5 imports the first two; Tasks 11 and 12 call the last two.

Do this task **before** Task 5 if executing in order — Task 5 imports from here.

- [ ] **Step 1: Write the failing test**

```ts
// lib/resume-download.test.ts
import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { TOKEN_CSS_FILES, buildDownloadHtml, downloadFilename } from "./resume-download";

describe("the inlined CSS list cannot drift from styles.css", () => {
  // styles.css is nothing but @import lines. Hardcoding the list here is a
  // second place that must not drift — the same hazard the retention
  // predicates close, applied to the stylesheet.
  test("TOKEN_CSS_FILES equals styles.css's @import order", () => {
    const css = readFileSync(
      join(process.cwd(), "public", "resume-design", "styles.css"),
      "utf8"
    );
    const imports: string[] = [];
    const re = /@import\s+"tokens\/([a-z-]+\.css)"/g;
    let m = re.exec(css);
    while (m !== null) {
      imports.push(m[1]);
      m = re.exec(css);
    }
    expect(imports.length).toBeGreaterThan(0);
    expect(TOKEN_CSS_FILES).toEqual(imports);
  });
});

describe("buildDownloadHtml", () => {
  const args = {
    markup: '<div class="rsm"><p>hello</p></div>',
    css: ".rsm{color:red}",
    docPageJs: "/* doc-page */",
    title: "Résumé — VP Sales at Acme",
  };

  test("is a complete standalone document", () => {
    const out = buildDownloadHtml(args);
    expect(out).toContain("<!doctype html>");
    expect(out).toContain("</html>");
  });

  test("inlines the CSS and the markup", () => {
    const out = buildDownloadHtml(args);
    expect(out).toContain(".rsm{color:red}");
    expect(out).toContain("<p>hello</p>");
  });

  test("inlines doc-page.js, which owns ALL print geometry", () => {
    // doc-page.js:30 says never write your own @page rule, and there are no
    // @page rules in the token CSS at all. A JS-free file has no geometry.
    const out = buildDownloadHtml(args);
    expect(out).toContain("/* doc-page */");
    expect(out).toContain("<doc-page");
  });

  test("escapes the title so a company name cannot inject markup", () => {
    const out = buildDownloadHtml({ ...args, title: 'a<script>alert(1)</script>' });
    expect(out).not.toContain("<script>alert(1)</script>");
  });
});

describe("downloadFilename", () => {
  test("is readable and filesystem-safe", () => {
    expect(downloadFilename("VP Sales", "Acme Corp", "2026-09-07T12:00:00.000Z")).toBe(
      "resume-acme-corp-vp-sales-2026-09-07.html"
    );
  });

  test("collapses punctuation rather than emitting it", () => {
    expect(downloadFilename("Head of GTM/RevOps", "N/A Inc.", "2026-09-07T12:00:00.000Z")).toBe(
      "resume-n-a-inc-head-of-gtm-revops-2026-09-07.html"
    );
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run lib/resume-download.test.ts`
Expected: FAIL — cannot resolve `./resume-download`.

- [ ] **Step 3: Write the implementation**

```ts
// lib/resume-download.ts
//
// A downloaded résumé is a standalone document that must print like the app
// prints. That is why doc-page.js is inlined rather than omitted: its own source
// says "never write your own @page rule or hard-code paper dimensions in the
// content" (:30), and there are NO @page rules anywhere in the token CSS — all
// print geometry lives in the component, which at print injects
// @page { margin: 0 } to deny Chrome its header/footer margin box and moves the
// visual margin onto the sheet's own padding (:118-120). spacing.css:10 also
// records that --rail: 132px was sized against doc-page.js's global
// text-wrap:balance on headings, so a file without it wraps section labels
// differently — the exact defect that forced 96px -> 132px.
//
// NOT self-contained in one respect: tokens/fonts.css @imports Newsreader and
// JetBrains Mono from Google Fonts, so a file opened offline falls back to the
// declared Georgia/Times and system-mono stacks.

/**
 * Bumped BY HAND whenever anything in public/resume-design/tokens/ changes.
 * Stamped onto every saved row so a résumé authored against an older design is
 * identifiable rather than merely suspect — the row stores markup, and its
 * appearance comes from those files at view time.
 */
export const DESIGN_VERSION = "2026-08-28";

/** Must equal styles.css's @import order. A test asserts it. */
export const TOKEN_CSS_FILES = [
  "fonts.css",
  "colors.css",
  "typography.css",
  "spacing.css",
  "elevation.css",
  "document.css",
];

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function buildDownloadHtml(args: {
  markup: string;
  css: string;
  docPageJs: string;
  title: string;
}): string {
  return (
    "<!doctype html>\n" +
    '<html lang="en">\n<head>\n<meta charset="utf-8">\n' +
    "<title>" +
    escapeHtml(args.title) +
    "</title>\n<style>\n" +
    args.css +
    "\n</style>\n</head>\n<body>\n" +
    '<doc-page margin="0.68in">' +
    args.markup +
    "</doc-page>\n<script>\n" +
    args.docPageJs +
    "\n</script>\n</body>\n</html>\n"
  );
}

/**
 * No \p{L} and no /u flag: the build typechecks at ES5, where both are errors.
 * The ASCII fallback truncates non-ASCII company names, which is acceptable for
 * a filename (lib/role-key.ts's NAME_SEPARATORS exists because it was NOT
 * acceptable for an identity key).
 */
export function downloadFilename(roleTitle: string, company: string, createdAt: string): string {
  const slug = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
  const day = createdAt.slice(0, 10);
  return "resume-" + slug(company) + "-" + slug(roleTitle) + "-" + day + ".html";
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run lib/resume-download.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add lib/resume-download.ts lib/resume-download.test.ts
git commit -m "feat: standalone résumé download that inlines doc-page.js for real print geometry"
```

---

### Task 9: Capture helper and Save on the draft screen

**Files:**
- Modify: `components/resume/ResumeDocument.tsx` (expose a ref, add a dirty callback)
- Modify: `components/resume/TailorPanel.tsx`
- Create: `components/resume/useResumeCapture.ts`

**Interfaces:**
- Consumes: `saveResume` (Task 5).
- Produces: `captureResumeHtml(docPageEl: HTMLElement): string`, used by Tasks 11 and 12 too.

- [ ] **Step 1: Write the capture helper**

```ts
// components/resume/useResumeCapture.ts
"use client";

/**
 * Serializes the live document for saving.
 *
 * TWO things here are load-bearing and both are invisible until after a row is
 * written:
 *
 *  1. It captures docPageEl.innerHTML, NOT the .rsm div's innerHTML.
 *     document.css:5 scopes the entire design to `.rsm`, and that wrapper is
 *     emitted by renderBody (render.js:127). One level deeper loses the root
 *     every selector hangs off and the saved résumé renders as unstyled text.
 *  2. It removes the on-screen page guides first. rsm-page-guides.js appends
 *     them INSIDE the .rsm element (:138) while their styles go to
 *     document.head (:59), so they travel with a capture and their styling does
 *     not — they would freeze stale break markers into the row and show as
 *     literal "Page 2" text in a downloaded file. Its @media print hide (:57)
 *     is why this never showed up in printing.
 *
 * The sanitizer drops them again server-side; this is the belt, that is the
 * braces.
 */
export function captureResumeHtml(docPageEl: HTMLElement): string {
  const clone = docPageEl.cloneNode(true) as HTMLElement;
  const guides = clone.querySelectorAll(".rsm-page-guide");
  for (let i = 0; i < guides.length; i++) {
    const g = guides[i];
    if (g.parentNode) g.parentNode.removeChild(g);
  }
  return clone.innerHTML;
}
```

- [ ] **Step 2: Let `ResumeDocument` expose its element and report edits**

In `components/resume/ResumeDocument.tsx`, extend the props and attach a ref plus an input handler. Replace the `<doc-page ...>` element with:

```tsx
      <doc-page
        ref={docPageRef as React.RefObject<HTMLElement>}
        margin="0.68in"
        contentEditable
        suppressContentEditableWarning
        onInput={onEdit}
        dangerouslySetInnerHTML={{ __html: html }}
      />
```

and add to the props interface:

```ts
  /** Set by TailorPanel so it can capture the live document on Save. */
  docPageRef?: React.RefObject<HTMLElement>;
  /** Fires on the first and every subsequent edit, so Save can be armed. */
  onEdit?: () => void;
```

Update the comment above the element: edits are still not captured into React state on every keystroke — `onEdit` only sets a dirty flag; the document itself is read once, on Save.

- [ ] **Step 3: Add Save, the label field, the dirty marker and the Regenerate confirm to `TailorPanel`**

Add state and handlers:

```tsx
  const docPageRef = useRef<HTMLElement>(null);
  const [dirty, setDirty] = useState(false);
  const [label, setLabel] = useState("");
  const [saved, setSaved] = useState<{ id: string } | null>(null);

  // beforeunload covers tab close and external navigation ONLY. It does not
  // fire for Regenerate (a React state change that re-sets
  // dangerouslySetInnerHTML) or for window.print() — Regenerate gets its own
  // confirm below.
  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirty]);

  function save(allowDuplicate = false) {
    const el = docPageRef.current;
    if (!el) return;
    setError(null);
    const html = captureResumeHtml(el);
    startTransition(async () => {
      const res = await saveResume({
        jobId,
        html,
        roleTitle,
        company,
        label: label.trim() ? label.trim() : null,
        allowDuplicate,
      });
      if (res.error !== undefined) {
        setError(res.error || UNDESCRIBED_DB_ERROR);
      } else if (res.duplicateOf) {
        if (window.confirm("This is identical to the version you already saved. Save anyway?")) {
          save(true);
        }
      } else {
        setDirty(false);
        setSaved({ id: res.id as string });
      }
    });
  }
```

Change `regenerate` to respect the dirty flag:

```tsx
  function regenerate() {
    // Regenerate is not a navigation, so beforeunload never fires for it.
    const warning = dirty
      ? "You have unsaved edits. Regenerate and discard them?"
      : "Regenerate this tailored resume? The current version will be replaced.";
    if (!window.confirm(warning)) return;
    tailor();
  }
```

Add to the button row, before "Print / Export PDF":

```tsx
        <input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="Label (optional)"
          className="rounded border border-slate px-2 py-1.5 text-sm"
        />
        <button
          onClick={() => save()}
          disabled={isPending}
          className="rounded border border-slate px-3 py-1.5 text-sm hover:border-ink disabled:opacity-50"
        >
          {isPending ? "Saving…" : "Save"}
        </button>
        {dirty && <span className="text-xs text-[#92400E]">Unsaved edits</span>}
        {saved && (
          <a href={`/resume?savedId=${saved.id}`} className="text-xs underline underline-offset-2">
            Saved — view it
          </a>
        )}
```

Pass `docPageRef` and `onEdit={() => setDirty(true)}` to `<ResumeDocument>`, and take `roleTitle`/`company` as new props on `TailorPanel` (supplied by the page, which already loads them via `getJobContext`).

- [ ] **Step 4: Verify by hand**

```bash
npm run dev
```

Open `/resume?jobId=<a tracked job id>`, tailor, edit a bullet, confirm "Unsaved edits" appears, click Save, confirm the "Saved — view it" link appears and the marker clears. Click Save again unchanged and confirm the duplicate prompt.

- [ ] **Step 5: Build and commit**

```bash
npm run build && npm test
git add components/resume/useResumeCapture.ts components/resume/ResumeDocument.tsx components/resume/TailorPanel.tsx app/resume/page.tsx
git commit -m "feat: save the tailored résumé, with a dirty marker and guide-stripped capture"
```

---

### Task 10: The archive screen

**Files:**
- Modify: `app/resume/page.tsx`
- Create: `components/resume/SavedResumeList.tsx`

**Interfaces:**
- Consumes: `listSavedResumes`, `deleteSavedResume`, `deleteSavedResumes` (Task 5).
- Produces: the `/resume` (no params) screen.

- [ ] **Step 1: Replace the dead-end branch in `app/resume/page.tsx`**

The current `if (!jobId)` branch renders a pointer at Roles. Replace it with the archive, keeping that copy as the empty state:

```tsx
  const savedId = searchParams.savedId;
  const jobId = searchParams.jobId;

  // savedId wins when both are present: it names one specific document, which
  // is more specific than "the draft for this job".
  if (savedId) return <SavedResumeScreen id={savedId} />;

  if (!jobId) {
    const { resumes, error } = await listSavedResumes();
    return (
      <div className="mx-auto max-w-3xl p-8">
        <h1 className="text-xl font-semibold">Saved résumés</h1>
        {error !== undefined && <p className="mt-2 text-sm text-[#92400E]">{error}</p>}
        {resumes.length === 0 ? (
          <p className="mt-2 text-sm text-ink/70">
            Nothing saved yet. Tailor a résumé from a tracked role — open{" "}
            <Link href="/roles" className="underline underline-offset-2">Roles</Link>{" "}
            and click "Tailor resume" on the one you want.
          </p>
        ) : (
          <SavedResumeList resumes={resumes} />
        )}
      </div>
    );
  }
```

- [ ] **Step 2: Write `SavedResumeList`**

A client component. Requirements, all of which come from the spec:

- Show a count above the list.
- Group by role: key on `jobId` when non-null, else `roleTitle + "|" + company`. Order groups by their newest save; within a group, newest first (`listSavedResumes` already returns newest-first overall, so a stable grouping preserves it).
- Each card shows role title @ company, the save date, the label if present, and `expires in N days` computed from `expiresAt` — emphasised (amber, `text-[#92400E]`) when under 7.
- Each card has **Open** (a link to `?savedId=`) and **Delete**. There is deliberately **no** Print or Download on the card: both need the row's HTML mounted in a `<doc-page>` for any print geometry, and printing one card would require hiding every other — a harder version of the `print:hidden` scoping CLAUDE.md already warns about for any new `window.print()` surface.
- A checkbox per card, and a **Delete selected (N)** button that appears only once more than one is checked.
- Both delete paths confirm, naming the count and saying it cannot be undone: `window.confirm("Delete 3 saved résumés? This cannot be undone.")`.
- Errors use presence, not truthiness: `if (res.error !== undefined) setError(res.error || UNDESCRIBED_DB_ERROR)`.
- After a successful delete, `router.refresh()`.
- When a card's `jobId` is null, show "role no longer tracked" instead of a link to it; when non-null, link to `/resume?jobId=<id>`.

- [ ] **Step 3: Verify by hand**

Open `/resume`. Confirm: the count, the grouping, the expiry line, a single delete, a bulk delete, and that the empty state appears when everything is deleted.

- [ ] **Step 4: Build and commit**

```bash
npm run build && npm test
git add app/resume/page.tsx components/resume/SavedResumeList.tsx
git commit -m "feat: saved-résumé archive at /resume with grouping, expiry and bulk delete"
```

---

### Task 11: The saved-résumé screen

**Files:**
- Create: `components/resume/SavedResumeScreen.tsx`
- Create: `components/resume/SavedResumePanel.tsx`

**Interfaces:**
- Consumes: `getSavedResume`, `saveResume`, `deleteSavedResume`, `getDownloadAssets` (Task 5), `buildDownloadHtml`/`downloadFilename` (Task 8), `captureResumeHtml` (Task 9).
- Produces: the `/resume?savedId=…` screen.

- [ ] **Step 1: Write the server component**

`SavedResumeScreen` calls `getSavedResume(id)` and renders three distinct states, which must not collapse:

- `error !== undefined` → the sentence verbatim.
- `resume === null` → "That saved résumé isn't here — it may have been deleted, or it may have passed the 60-day limit." Naming expiry matters: the read filters `LIVE_PREDICATE`, so an expired-but-unpurged row lands here and the user deserves the likely reason.
- otherwise → `<SavedResumePanel resume={resume} />`, plus the design stylesheet `<link rel="stylesheet" href="/resume-design/styles.css" />` exactly as the draft screen does.

- [ ] **Step 2: Write the client panel**

- Mounts `resume.html` inside `<doc-page margin="0.68in" contentEditable>` with the same `next/script` tags `ResumeDocument` uses (`doc-page.js`, `rsm-page-guides.js`). Do **not** re-render from `renderBody` — this is a frozen document.
- **Save as new version** captures via `captureResumeHtml`, then calls `saveResume` with the row's own `jobId`, `roleTitle` and `company`, and `allowDuplicate: false`. It never overwrites the opened row. On success, navigate to the new `?savedId=`.
- **Print** is `window.print()`, with the same `print:hidden` scoping the draft screen uses on its chrome.
- **Download** calls `getDownloadAssets()`, then `buildDownloadHtml({ markup: resume.html, css, docPageJs, title })` and triggers a `Blob` download named by `downloadFilename(resume.roleTitle, resume.company, resume.createdAt)`.
- **Delete** confirms, calls `deleteSavedResume`, then navigates to `/resume`.
- A muted line shows the save date, the label, `expires in N days`, and — when `resume.designVersion !== DESIGN_VERSION` — "saved against an earlier document design", which is the whole reason that column exists.

- [ ] **Step 3: Verify by hand**

Open a saved résumé. Confirm: it renders styled (if it renders as plain text, the capture in Task 9 grabbed the wrong node); Print produces the same output as the draft screen; the downloaded file opens in a browser and prints identically; select-all-copy into Google Docs keeps formatting; editing and "Save as new version" creates a second row and leaves the first untouched.

- [ ] **Step 4: Build and commit**

```bash
npm run build && npm test
git add components/resume/SavedResumeScreen.tsx components/resume/SavedResumePanel.tsx app/resume/page.tsx
git commit -m "feat: view, re-save, print, download and delete one saved résumé"
```

---

### Task 12: Documentation and deploy

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Amend the public-surface list**

In the paragraph beginning "**What replaced it is per-surface, not global**", change "the two cron routes `app/api/cron/crawl-next` and `app/api/cron/crawl`" to name **three**, adding `app/api/cron/purge-resumes`. No test enumerates public routes — only review catches an unamended list, which is why this is a step and not an afterthought.

- [ ] **Step 2: Extend the résumé section**

After the "Résumé tailoring" paragraph, add a paragraph covering: `saved_resumes` versus `tailored_resumes` (archive versus draft); that edits are captured only on Save and the capture is `docPageEl.innerHTML` with page guides stripped; that both retention predicates live in `lib/resume-retention.ts` and must not be retyped; that `runAsTenant` does not set `app.tenant_id` and raw SQL needs the tenant id as `rawQuery`'s third argument; that `DESIGN_VERSION` is bumped by hand when `public/resume-design/tokens/` changes; and what 60 days does **not** cover (the non-expiring draft row, Railway backups, downloaded files).

- [ ] **Step 3: Apply the migration**

```bash
railway run --service Postgres sh -c 'DATABASE_URL="$DATABASE_PUBLIC_URL" node db/migrate.mjs --dry'
railway run --service Postgres sh -c 'DATABASE_URL="$DATABASE_PUBLIC_URL" node db/migrate.mjs'
```

- [ ] **Step 4: Confirm the role assumption**

```bash
railway run --service Postgres sh -c 'psql "$DATABASE_PUBLIC_URL" -c "select current_user, rolsuper, rolbypassrls from pg_roles where rolname = current_user"'
```

If this reports a superuser or `rolbypassrls = true`, RLS is being bypassed in production and the per-tenant purge is merely correct rather than necessary. Record the answer in the spec either way — a whole section's reasoning rests on it.

- [ ] **Step 5: Deploy and verify against the deployed commit**

```bash
git push origin main
railway deployment list --service web --limit 1 --json   # compare meta.commitHash to git rev-parse origin/main
```

- [ ] **Step 6: Add the purge to the crawler loop**

Add one call to `$WEB_URL/api/cron/purge-resumes` (bearer `CRON_SECRET`) in the `crawler` service's start command, after the crawl loop. Verify first with `?dry=1` and confirm the JSON reports a plausible `tenants` count.

- [ ] **Step 7: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: record saved-résumé retention, capture and tenant-scoping rules"
```

---

## Self-Review

**Spec coverage.** Data model → Task 3. What "frozen" means / `design_version` → Tasks 8, 11. Retention predicates → Task 1. Per-tenant purge and enumeration → Task 6. Three retention mechanisms → Tasks 5 (opportunistic), 6+7 (cron), 5 (hide-on-read). Cron route → Task 7. Capture → Task 9. Sanitizer → Task 2. Actions and error states → Task 5. UI, three screens → Tasks 9, 10, 11. Download → Tasks 8, 11. Auth invariants → Tasks 4, 5, 12. Testing → Tasks 1, 2, 6, 8 plus the admin gate in 5. Deployment → Task 12.

**Ordering note.** Task 5 imports `DESIGN_VERSION` and `TOKEN_CSS_FILES` from `lib/resume-download.ts`, which Task 8 creates. Execute **Task 8 before Task 5**, or stub the two constants and let Task 8 replace them. The task numbering otherwise follows dependency order.

**Not covered by automated tests, by design.** The three screens, the print output, the downloaded file, and the live database behaviour of RLS. These are hand-verified in Tasks 9, 10, 11 and 12. The pure logic — predicates, sanitizer, purge control flow, download assembly — carries the tests, matching this repo's stated scope for `npm test`.
