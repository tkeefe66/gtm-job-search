# Role-First Discovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Find roles by job title and by GTM tool stack independently of funding news, surface the companies behind them, and let the user track any of those companies with one click.

**Architecture:** Two query families — title queries and stack queries — are built from the shared criteria module and run through `callWithWebSearch`. Results carry a company name and route through the same `ingestRoles` path the crawler uses. Companies not already on the watchlist are returned as suggestions with a Track button. Results are cached per query family in a new `role_searches` table, following the caching pattern already used by Discover, Roles, and Insights.

**Tech Stack:** Next.js 14 App Router, TypeScript, Tailwind, Railway Postgres via `lib/supabase.ts`, Anthropic SDK with the `web_search` server tool, vitest.

Spec: `docs/superpowers/specs/2026-08-12-company-tracking-design.md` §5 and §6.2

**Prerequisite:** `docs/superpowers/plans/2026-08-12-company-tracking.md` must be complete through Task 7. This plan consumes `lib/search-criteria.ts`, `lib/ingest-roles.ts`, and the tracking actions in `app/actions/watchlist.ts`.

## Global Constraints

- **No ATS vendor APIs and no job aggregator APIs.** Discovery happens through `web_search` against publicly indexed pages. Hard product constraint.
- **`npm run build && npm test && npm run lint` is the pre-deploy gate.**
- **No API routes.** The only API route in the app is the cron route from the tracking plan. User-facing backend entry points are React Server Actions in `app/actions/`; shared backend machinery lives in `lib/`.
- **`lib/supabase.ts` is NOT Supabase** — hand-rolled builder over `pg`, supporting `.from .select .insert .update .upsert .delete .eq .neq .order .limit .single .maybeSingle`. Use `rawQuery` for anything else.
- **Schema truth is `db/schema.sql`**, applied with `DATABASE_URL=postgres://... node db/apply-schema.mjs`, and must stay idempotent.
- **Budget `maxTokens` generously on web-search calls** — search narration counts against the budget, and 2000 tokens has truncated responses before the JSON was emitted.
- **Cache before calling.** Every Claude-backed feature in this app serves cached results on re-query and only hits the API on a new search or a forced refresh.

---

### Task 1: Query builders and the results cache

**Files:**
- Modify: `lib/search-criteria.ts` (add query builders)
- Modify: `lib/search-criteria.test.ts` (add tests)
- Modify: `db/schema.sql` (add `role_searches`)
- Modify: `lib/types.ts` (add `RoleMatch`, `RoleSearchFamily`)

**Interfaces:**
- Consumes: `TARGET_TITLES`, `GTM_STACK_TERMS`, `LOCATION_RULE` from `lib/search-criteria.ts` (tracking plan, Task 1).
- Produces: `titleQueries(): string[]`, `stackQueries(): string[]`, `LOCATION_TERMS: string[]`; types `RoleSearchFamily = "title" | "stack"` and `RoleMatch extends Role { company: string }`.

- [ ] **Step 1: Write the failing tests**

Append to `lib/search-criteria.test.ts`:

```ts
import { LOCATION_TERMS, stackQueries, titleQueries } from "./search-criteria";

describe("titleQueries", () => {
  test("produces one query per title and location term", () => {
    expect(titleQueries().length).toBe(TARGET_TITLES.length * LOCATION_TERMS.length);
  });

  test("quotes the title so search engines match the phrase", () => {
    expect(titleQueries().some((q) => q.includes('"Revenue Operations"') || q.includes('"Head of Revenue Operations"'))).toBe(true);
  });

  test("every query carries a location term", () => {
    for (const q of titleQueries()) {
      expect(LOCATION_TERMS.some((t) => q.includes(t))).toBe(true);
    }
  });
});

describe("stackQueries", () => {
  test("pairs tool names with hiring language", () => {
    const queries = stackQueries();
    expect(queries.some((q) => q.includes("Clay"))).toBe(true);
    expect(queries.every((q) => q.toLowerCase().includes("hiring"))).toBe(true);
  });

  test("every query carries a location term", () => {
    for (const q of stackQueries()) {
      expect(LOCATION_TERMS.some((t) => q.includes(t))).toBe(true);
    }
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL — `titleQueries is not a function`.

- [ ] **Step 3: Add the query builders to `lib/search-criteria.ts`**

Append:

```ts
// Search-engine queries. Title queries catch roles named the way the user
// expects. Stack queries catch roles with idiosyncratic titles — Business
// Systems Manager, Growth Systems Lead — that title search structurally
// misses. Titles in this function vary wildly; the tooling does not.

export const LOCATION_TERMS = ["Denver", "Colorado", "remote"];

export function titleQueries(): string[] {
  const queries: string[] = [];
  for (const title of TARGET_TITLES) {
    for (const place of LOCATION_TERMS) {
      queries.push(`"${title}" ${place} job opening`);
    }
  }
  return queries;
}

export function stackQueries(): string[] {
  const queries: string[] = [];
  for (const tool of GTM_STACK_TERMS) {
    for (const place of LOCATION_TERMS) {
      queries.push(`"${tool}" revenue operations hiring ${place}`);
    }
  }
  return queries;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Add the cache table to `db/schema.sql`**

Append:

```sql
-- Cached role-first search results per (family, search_term). Same
-- cache-first pattern as discovered_startups and insights_cache.
create table if not exists role_searches (
  id          uuid primary key default gen_random_uuid(),
  family      text not null,          -- 'title' | 'stack'
  search_term text not null default '',
  roles       jsonb not null default '[]',
  fetched_at  timestamptz default now(),
  unique (family, search_term)
);
```

- [ ] **Step 6: Apply the schema**

```bash
DATABASE_URL=postgres://... node db/apply-schema.mjs
```

Expected: succeeds, and succeeds again on a second run.

- [ ] **Step 7: Add the types to `lib/types.ts`**

Append:

```ts
export type RoleSearchFamily = "title" | "stack";

export interface RoleMatch extends Role {
  company: string;
}
```

- [ ] **Step 8: Verify the build**

Run: `npm run build && npm test && npm run lint`
Expected: clean.

- [ ] **Step 9: Commit**

```bash
git add lib/search-criteria.ts lib/search-criteria.test.ts db/schema.sql lib/types.ts
git commit -m "feat: add role search query builders and results cache table"
```

---

### Task 2: Role search server action

**Files:**
- Create: `app/actions/role-search.ts`

**Interfaces:**
- Consumes: `titleQueries`/`stackQueries`/`LOCATION_RULE`/`ROLE_SEARCH_SYSTEM`/`roleExtractionSchema` (Task 1), `callWithWebSearch`/`parseJson` (`lib/anthropic.ts`), `ingestRoles` (tracking plan Task 5), `supabase` (`lib/supabase.ts`).
- Produces: `findRolesByCriteria(family: RoleSearchFamily, force?: boolean)`, `getCachedRoleSearch(family: RoleSearchFamily)`, both returning `{ matches: RoleMatch[]; untrackedCompanies: string[]; fetchedAt: string | null; error?: string }`.

- [ ] **Step 1: Create `app/actions/role-search.ts`**

```ts
"use server";

import { callWithWebSearch, parseJson } from "@/lib/anthropic";
import { ingestRoles } from "@/lib/ingest-roles";
import {
  LOCATION_RULE,
  ROLE_SEARCH_SYSTEM,
  roleExtractionSchema,
  stackQueries,
  titleQueries,
} from "@/lib/search-criteria";
import { supabase } from "@/lib/supabase";
import type { RoleMatch, RoleSearchFamily } from "@/lib/types";

export interface RoleSearchResult {
  matches: RoleMatch[];
  untrackedCompanies: string[];
  fetchedAt: string | null;
  error?: string;
}

const FAMILY_INTRO: Record<RoleSearchFamily, string> = {
  title:
    "Search job boards and company careers pages for currently-open roles matching these searches",
  stack:
    "Search job boards and company careers pages for currently-open go-to-market / revenue operations roles that mention these tools. Titles vary — include Business Systems Manager, Growth Systems Lead, Revenue Systems, and similar, not just the obvious RevOps titles. Use these searches",
};

function buildPrompt(family: RoleSearchFamily): string {
  const queries = family === "title" ? titleQueries() : stackQueries();
  return `${FAMILY_INTRO[family]}:

${queries.map((q) => `- ${q}`).join("\n")}

Run as many of these searches as you can and combine the results. Prioritize postings from the last 60 days. ${LOCATION_RULE}

${roleExtractionSchema()}
- company (string, the hiring company name — REQUIRED, never empty)

Return up to 25 roles. Deduplicate identical postings. Return ONLY the JSON array.`;
}

async function readCache(family: RoleSearchFamily) {
  return supabase
    .from("role_searches")
    .select("roles, fetched_at")
    .eq("family", family)
    .eq("search_term", "")
    .order("fetched_at", { ascending: false })
    .limit(1)
    .maybeSingle();
}

async function untrackedFrom(matches: RoleMatch[]): Promise<string[]> {
  const { data } = await supabase.from("watchlist").select("company");
  const tracked = new Set(
    ((data ?? []) as { company: string }[]).map((r) => r.company.toLowerCase().trim())
  );
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of matches) {
    const key = m.company?.toLowerCase().trim();
    if (!key || tracked.has(key) || seen.has(key)) continue;
    seen.add(key);
    out.push(m.company);
  }
  return out;
}

export async function getCachedRoleSearch(
  family: RoleSearchFamily
): Promise<RoleSearchResult> {
  const { data, error } = await readCache(family);
  if (error) {
    return { matches: [], untrackedCompanies: [], fetchedAt: null, error: error.message };
  }
  if (!data) return { matches: [], untrackedCompanies: [], fetchedAt: null };

  const matches = (data.roles ?? []) as RoleMatch[];
  return {
    matches,
    untrackedCompanies: await untrackedFrom(matches),
    fetchedAt: data.fetched_at,
  };
}

export async function findRolesByCriteria(
  family: RoleSearchFamily,
  force = false
): Promise<RoleSearchResult> {
  if (!force) {
    const cached = await getCachedRoleSearch(family);
    if (cached.matches.length > 0) return cached;
  }

  try {
    const raw = await callWithWebSearch({
      system: ROLE_SEARCH_SYSTEM,
      prompt: buildPrompt(family),
      // Many searches per call; search narration counts against the budget.
      maxTokens: 8000,
    });

    const parsed = parseJson<RoleMatch[]>(raw);
    const matches = (Array.isArray(parsed) ? parsed : []).filter(
      (m) => m.company && m.role_title
    );

    const fetchedAt = new Date().toISOString();
    await supabase.from("role_searches").upsert(
      { family, search_term: "", roles: matches, fetched_at: fetchedAt },
      { onConflict: "family,search_term" }
    );

    // Ingest per company so dedupe, URL verification, and fit scoring run
    // through the same path the crawler uses.
    const byCompany = new Map<string, RoleMatch[]>();
    for (const m of matches) {
      const list = byCompany.get(m.company) ?? [];
      list.push(m);
      byCompany.set(m.company, list);
    }

    for (const [company, roles] of byCompany) {
      try {
        await ingestRoles({ company, roles, source: "Role Search" });
      } catch (err) {
        console.error(
          `findRolesByCriteria: ingest failed for ${company} — ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }

    return {
      matches,
      untrackedCompanies: await untrackedFrom(matches),
      fetchedAt,
    };
  } catch (err) {
    console.error("findRolesByCriteria error:", err);
    return {
      matches: [],
      untrackedCompanies: [],
      fetchedAt: null,
      error:
        err instanceof Error
          ? err.message
          : "Failed to search for roles. Check your ANTHROPIC_API_KEY.",
    };
  }
}
```

- [ ] **Step 2: Verify the build**

Run: `npm run build && npm test && npm run lint`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add app/actions/role-search.ts
git commit -m "feat: add role-first search by title and GTM stack"
```

---

### Task 3: Discover two modes and the funding window fix

**Files:**
- Modify: `app/actions/discover.ts:10-17,81` (add the `6-18m` range, fix label grammar)
- Create: `components/RoleSearchPanel.tsx` (role mode, self-contained)
- Modify: `components/Discover.tsx` (mode toggle, new default range)

`Discover.tsx` is already 229 lines. Role mode goes in its own component rather than
growing that file — `Discover.tsx` gains only a toggle and a branch.

**Interfaces:**
- Consumes: `findRolesByCriteria`/`getCachedRoleSearch` (Task 2), `trackCompanyByName` (tracking plan Task 7).
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Add the `6-18m` range to `app/actions/discover.ts`**

Replace the `DateRange` type and labels (lines 10-17) with:

```ts
export type DateRange = "7d" | "30d" | "3m" | "6m" | "6-18m";

// Labels are grammatical continuations of "announced ..." in the prompt.
const DATE_RANGE_LABELS: Record<DateRange, string> = {
  "7d": "in the past 7 days",
  "30d": "in the past 30 days",
  "3m": "in the past 3 months",
  "6m": "in the past 6 months",
  "6-18m": "between 6 and 18 months ago",
};
```

- [ ] **Step 2: Fix the prompt to match the new labels**

In the `prompt` template (line 81), change `announced in ${period}` to `announced ${period}`. The four search-string interpolations later in the same template (`"Series B funding ${period}"` and friends) read correctly with the new labels and need no change.

- [ ] **Step 3: Add a note explaining why the new range exists**

Directly above `DATE_RANGE_LABELS`, add:

```ts
// The 6-18m window is the default because a company that closed a round last
// week has no RevOps req yet — the company hiring GTM systems people today
// raised 6-18 months ago. The shorter ranges remain for scanning fresh news.
```

- [ ] **Step 4: Add the new range to the selector and make it the default**

In `components/Discover.tsx`, add to `DATE_RANGE_OPTIONS` (lines 11-16) as the **first** entry:

```ts
  { value: "6-18m", label: "6–18 mo" },
```

Change the state initializer on line 24 from `useState<DateRange>("7d")` to:

```ts
  const [dateRange, setDateRange] = useState<DateRange>("6-18m");
```

- [ ] **Step 5: Create `components/RoleSearchPanel.tsx`**

```tsx
"use client";

import { useCallback, useEffect, useState } from "react";
import {
  findRolesByCriteria,
  getCachedRoleSearch,
} from "@/app/actions/role-search";
import { trackCompanyByName } from "@/app/actions/watchlist";
import type { RoleMatch, RoleSearchFamily } from "@/lib/types";
import { Spinner, Tag } from "./ui";

const FAMILIES: { value: RoleSearchFamily; label: string }[] = [
  { value: "title", label: "Titles" },
  { value: "stack", label: "GTM stack" },
];

export default function RoleSearchPanel() {
  const [family, setFamily] = useState<RoleSearchFamily>("title");
  const [matches, setMatches] = useState<RoleMatch[]>([]);
  const [untracked, setUntracked] = useState<Set<string>>(new Set());
  const [fetchedAt, setFetchedAt] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [trackingCompany, setTrackingCompany] = useState<string | null>(null);
  const [justTracked, setJustTracked] = useState<Set<string>>(new Set());

  const loadCached = useCallback(async (f: RoleSearchFamily) => {
    setLoading(true);
    setError(null);
    const res = await getCachedRoleSearch(f);
    if (res.error) setError(res.error);
    setMatches(res.matches);
    setUntracked(new Set(res.untrackedCompanies));
    setFetchedAt(res.fetchedAt);
    setLoading(false);
  }, []);

  useEffect(() => {
    loadCached(family);
  }, [family, loadCached]);

  async function runSearch() {
    setSearching(true);
    setError(null);
    const res = await findRolesByCriteria(family, true);
    if (res.error) setError(res.error);
    setMatches(res.matches);
    setUntracked(new Set(res.untrackedCompanies));
    setFetchedAt(res.fetchedAt);
    setSearching(false);
  }

  async function handleTrack(company: string) {
    setTrackingCompany(company);
    const res = await trackCompanyByName(company);
    setTrackingCompany(null);
    if (res.error) {
      setError(res.error);
      return;
    }
    setJustTracked((prev) => new Set(prev).add(company));
  }

  function formatFetchedAt(iso: string) {
    return new Date(iso).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  }

  const byCompany = new Map<string, RoleMatch[]>();
  for (const m of matches) {
    const list = byCompany.get(m.company) ?? [];
    list.push(m);
    byCompany.set(m.company, list);
  }

  const busy = loading || searching;

  return (
    <div>
      <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="text-sm text-ink/60">
            Roles found by searching job boards directly — no funding news required.
            {fetchedAt && !busy && (
              <span className="ml-2 text-ink/40">
                · Last searched {formatFetchedAt(fetchedAt)}
              </span>
            )}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex overflow-hidden rounded-md border border-slate">
            {FAMILIES.map((f) => (
              <button
                key={f.value}
                onClick={() => setFamily(f.value)}
                disabled={busy}
                className={`px-3 py-1.5 text-sm transition ${
                  family === f.value
                    ? "bg-ink text-white"
                    : "bg-white text-ink hover:bg-canvas"
                }`}
              >
                {f.label}
              </button>
            ))}
          </div>
          <button
            onClick={runSearch}
            disabled={busy}
            className="rounded-md border border-ink bg-ink px-4 py-2 text-sm font-medium text-white transition hover:bg-ink/90 disabled:opacity-50"
          >
            {searching ? "Searching…" : "Search roles"}
          </button>
        </div>
      </div>

      {busy && (
        <div className="py-12">
          <Spinner
            label={searching ? "Searching job boards…" : "Loading saved results…"}
          />
        </div>
      )}

      {error && !busy && (
        <div className="rounded-md border border-slate bg-white p-4 text-sm text-[#92400E]">
          {error}
        </div>
      )}

      {!busy && !error && byCompany.size === 0 && (
        <div className="rounded-md border border-dashed border-slate p-12 text-center text-sm text-ink/50">
          No cached role search yet. Click &quot;Search roles&quot; to run one.
        </div>
      )}

      {!busy && byCompany.size > 0 && (
        <div className="overflow-hidden rounded-lg border border-slate bg-white">
          {Array.from(byCompany.entries()).map(([company, roles], i) => (
            <div key={company} className={i > 0 ? "border-t border-slate p-4" : "p-4"}>
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-heading font-semibold">{company}</span>
                <Tag>
                  {roles.length} role{roles.length === 1 ? "" : "s"}
                </Tag>
                {justTracked.has(company) ? (
                  <span className="text-sm text-ink/40">Tracking ✓</span>
                ) : (
                  untracked.has(company) && (
                    <button
                      onClick={() => handleTrack(company)}
                      disabled={!!trackingCompany}
                      className="rounded-md border border-slate px-2 py-1 text-xs font-medium text-ink/60 transition hover:border-ink hover:text-ink disabled:opacity-50"
                    >
                      {trackingCompany === company ? "…" : "Track"}
                    </button>
                  )
                )}
              </div>
              <ul className="mt-2 space-y-1">
                {roles.map((r, j) => (
                  <li key={`${r.role_title}-${j}`} className="text-sm text-ink/70">
                    {r.job_url ? (
                      <a
                        href={r.job_url}
                        target="_blank"
                        rel="noreferrer"
                        className="underline-offset-2 hover:underline"
                      >
                        {r.role_title}
                      </a>
                    ) : (
                      r.role_title
                    )}
                    {r.location && <span className="text-ink/40"> · {r.location}</span>}
                    {r.salary_range && (
                      <span className="text-ink/40"> · {r.salary_range}</span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 6: Add the mode toggle to `components/Discover.tsx`**

Add the import:

```tsx
import RoleSearchPanel from "./RoleSearchPanel";
```

Add the state beside the existing `useState` calls:

```tsx
  const [mode, setMode] = useState<"company" | "role">("company");
```

Insert this toggle as the first child of the outer `<div>` in the returned JSX,
immediately before the existing header block:

```tsx
      <div className="mb-6 flex overflow-hidden rounded-md border border-slate sm:w-fit">
        {(
          [
            { value: "company", label: "By company (funding)" },
            { value: "role", label: "By role (title/stack)" },
          ] as const
        ).map((m) => (
          <button
            key={m.value}
            onClick={() => setMode(m.value)}
            className={`px-3 py-1.5 text-sm transition ${
              mode === m.value ? "bg-ink text-white" : "bg-white text-ink hover:bg-canvas"
            }`}
          >
            {m.label}
          </button>
        ))}
      </div>

      {mode === "role" && <RoleSearchPanel />}
```

Then wrap the entire existing body — the header block through the results list —
in `{mode === "company" && ( … )}` so company mode and role mode are mutually
exclusive.

- [ ] **Step 7: Verify in the browser**

Run `npm run dev`, open `/discover`, and confirm:
1. Company mode still works and now defaults to the `6–18 mo` range.
2. Running a `6–18 mo` discovery returns companies (this range starts with an empty cache).
3. Role mode with `Titles` returns roles grouped by company.
4. Role mode with `GTM stack` returns a different set.
5. Reloading the page shows the cached role results without a new API call.
6. Clicking `Track` on a company adds it to `/watchlist` and runs its first crawl.
7. Roles found appear on `/roles` with `source` of `Role Search` and a fit score.

- [ ] **Step 8: Verify the build**

Run: `npm run build && npm test && npm run lint`
Expected: clean.

- [ ] **Step 9: Update `CLAUDE.md`**

Add to the Architecture section:

```markdown
**Role-first discovery**: `app/actions/role-search.ts` searches for roles by title
and by GTM tool stack (`titleQueries` / `stackQueries` in `lib/search-criteria.ts`)
rather than by company, so companies that never appear in funding news still
surface. Results cache in `role_searches` per family and route through the same
`lib/ingest-roles.ts` path as the crawler. The Discover tab has two modes:
by company (funding) and by role.
```

Also update the Find Roles pipeline paragraph to note that the URL-verification and fit-scoring block now lives in `lib/ingest-roles.ts` rather than inline in `app/actions/roles.ts`.

- [ ] **Step 10: Deploy**

```bash
railway up --service web --detach
```

- [ ] **Step 11: Commit**

```bash
git add app/actions/discover.ts components/Discover.tsx components/RoleSearchPanel.tsx CLAUDE.md
git commit -m "feat: add role-first discovery mode and 6-18m funding window"
```

---

## Verification checklist

- [ ] `npm run build && npm test && npm run lint` is clean.
- [ ] Discover defaults to the `6–18 mo` range and returns companies for it.
- [ ] Role mode returns roles grouped by company for both families.
- [ ] Cached role results load without spending an API call.
- [ ] `Track` on a discovered company adds it to the watchlist and crawls it.
- [ ] Roles from role search appear on `/roles` with `source` of `Role Search`.
- [ ] Running the same role search twice adds no duplicate rows to `/roles`.
