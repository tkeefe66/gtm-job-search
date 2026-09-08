# Résumé Chat, Coverage, and Ordering — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give `/resume?jobId=…` a conversational agent that can change the tailored résumé by selection, by text, and by document design — plus the coverage panel that makes its reasoning visible and the bullet-ordering fix that makes its first answer defensible.

**Architecture:** One server-side `effectiveCareer()` function merges the shipped career record with a per-tenant overlay and per-document text overrides, and everything downstream — `selectBullets`, `renderBody`, `coverage` — operates on that single record, so the renderer never learns about overrides. A chat turn is one constrained model call returning `{ reply, operations[] }`; operations are validated server-side against the effective record and applied atomically by re-running selection and render. Design changes are allowlisted CSS custom properties emitted as an inline `style` on the `.rsm` root, which rides inside the existing Save capture.

**Tech Stack:** Next.js 14 App Router, TypeScript, Postgres via `lib/supabase.ts`, vitest, `sanitize-html`, Anthropic through `lib/model-call.ts` + `lib/providers/`.

**Spec:** `docs/superpowers/specs/2026-09-07-resume-chat-design.md` (revision 2 — read it; this plan argues from it)

## Global Constraints

- **Verification gate is `npm run build && npm test`.** `npm run lint` is non-functional in this repo — never add it.
- **`tsconfig.json` declares no `target`, so `npm run build` typechecks at ES5.** No `/u` regex flag, no `\p{…}` unicode property escapes anywhere in this work. They pass vitest and fail the build. `npx tsc --noEmit --target es2017` does NOT reproduce the gate.
- **`{ error?: string }` results are detected by PRESENCE (`!== undefined`), never truthiness.** The string can legitimately be `""`. Database failures go through `describeWriteFailure(error?.message, "…")` from `lib/write-failure.ts`; a non-database failure (model, parsing) substitutes its own sentence at the catch, because `UNDESCRIBED_DB_ERROR` names the database and would be false there. See `.claude/skills/swallowed-string-errors`.
- **Every exported server action refuses a session-less call** and takes its place in `app/actions/auth-required.test.ts`. Résumé surfaces gate on `requireResumeAdmin()` from `lib/require-resume-admin.ts`, which stays in `lib/` — exporting it from a `"use server"` file publishes it as an RPC endpoint.
- **`lib/resume-render/render.js` is VENDORED** from the TK Resume Design System (`render.d.ts:1-3`). Two tasks edit it. Each edit gets a dated divergence comment at the changed lines naming what changed and why, matching the treatment `public/resume-design/tokens/*.css` received.
- **Never hand-build `.rsm` markup outside `render.js`** (`render.js:11`).
- **Regenerating a checked-in fixture requires reading the diff in the same commit.** A commit that touches only fixtures is a red flag.
- **A new table with inline `tenant_id` is invisible to `lib/supabase.test.ts`'s ALTER TABLE retrofit regex** and must be added to `TENANT_TABLES` in `lib/supabase.ts` by hand.
- Commit after every task. Run `npm test` before each commit; run `npm run build` before the commits in Tasks 1, 5, 8, 13, 15.

## File Structure

**Created**
- `lib/resume-coverage.ts` — rendered-vs-full coverage report. Pure.
- `lib/resume-text.ts` — `sanitizeBulletText`, the one escape/tag-limit boundary for authored text. Pure.
- `lib/resume-design-tokens.ts` — token allowlist + value parser, shared by the write path and the sanitizer. Pure.
- `lib/effective-career.ts` — merges shipped record + overlay + text overrides. Pure.
- `lib/resume-ops.ts` — operation types + validator. Pure.
- `lib/resume-chat-prompt.ts` — chat system/user prompt builder. Pure.
- `app/actions/resume-chat.ts` — the one server action for a chat turn.
- `components/resume/CoveragePanel.tsx`, `components/resume/ChatPanel.tsx`
- `db/migrations/019_resume_chats.sql`, `db/migrations/020_saved_resume_page_margin.sql`
- Test files alongside each `lib/` module; `lib/__fixtures__/resume-chat-prompt.txt`

**Modified**
- `lib/resume-render/render.js` — ordering rule (Task 1), `rootStyle` option (Task 6)
- `lib/resume-render/render.d.ts` — `tail`, `rootStyle`, overlay/edited metadata
- `lib/resume-render/content/resume.json` — `tail: true` on two bullets
- `lib/resume-sanitize.ts` — `allowedStyles.div` (Task 5)
- `lib/settings-store.ts` — `CAREER_OVERLAY_KEY` + reader/writer (Task 7)
- `lib/supabase.ts` — `TENANT_TABLES` (Task 9)
- `app/actions/resume.ts`, `app/resume/page.tsx`, `components/resume/TailorPanel.tsx`, `components/resume/ResumeDocument.tsx`, `components/resume/SavedResumePanel.tsx`
- `CLAUDE.md` (Task 15)

---

### Task 1: Bullet ordering — `tail` bullets and weight-first ranking

**Files:**
- Modify: `lib/resume-render/render.js:31-74`
- Modify: `lib/resume-render/render.d.ts:10-16`
- Modify: `lib/resume-render/content/resume.json` (two bullets)
- Test: `lib/resume-render/render-pipeline.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `ResumeBullet.tail?: boolean`. `selectBullets(career, opts)` signature unchanged; ordering within each role changes.

- [ ] **Step 1: Write the failing test**

Append to `lib/resume-render/render-pipeline.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { selectBullets } from "@/lib/resume-render/render";
import type { CareerRecord } from "@/lib/resume-render/render";

const ORDERING_FIXTURE = {
  identity: { name: "T", contacts: [] },
  positioning: [{ id: "p", themes: [], tagline: "t", summary: "s" }],
  roles: [
    {
      id: "r1",
      title: "Role One",
      org: "Org",
      dates: "2020 – Present",
      bullets: [
        { id: "b1", priority: 1, themes: [], text: "anchor, off-theme" },
        { id: "b2", priority: 2, themes: ["other"], text: "middle" },
        { id: "b3", priority: 3, themes: ["systems"], text: "on-theme" },
        { id: "b6", priority: 6, themes: ["systems"], tail: true, text: "award" },
      ],
    },
  ],
  advisory: [],
  education: [],
  rules: { taper: [4], themes: ["systems", "other"], compressAfter: null },
} as unknown as CareerRecord;

describe("selectBullets ordering", () => {
  it("leads with the on-theme bullet, keeps the anchor, and sinks tail bullets", () => {
    const sel = selectBullets(ORDERING_FIXTURE, { themes: ["systems"] });
    expect(sel.bullets.r1[0]).toBe("b3");
    expect(sel.bullets.r1).toContain("b1");
    expect(sel.bullets.r1[sel.bullets.r1.length - 1]).toBe("b6");
  });

  it("orders tail bullets among themselves by priority, after every non-tail bullet", () => {
    const twoTails = JSON.parse(JSON.stringify(ORDERING_FIXTURE));
    twoTails.roles[0].bullets.push({ id: "b5", priority: 5, themes: ["systems"], tail: true, text: "award 2" });
    twoTails.rules.taper = [5];
    const sel = selectBullets(twoTails, { themes: ["systems"] });
    const ids = sel.bullets.r1;
    expect(ids.slice(-2)).toEqual(["b5", "b6"]);
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npx vitest run lib/resume-render/render-pipeline.test.ts -t "ordering"`
Expected: FAIL. Today's sort is priority-only (`render.js:55-56`), so `sel.bullets.r1[0]` is `"b1"`, not `"b3"`.

- [ ] **Step 3: Add `tail` to the type declaration**

In `lib/resume-render/render.d.ts`, inside `ResumeBullet` (after `themes`):

```ts
  /**
   * Recognition rather than accomplishment — awards, honours. Always sorts
   * after every non-tail bullet in its role, whatever its theme weight.
   * Priority alone used to carry this, which is why a weight-first sort
   * without it promotes an awards line to the top of a role.
   */
  tail?: boolean;
```

- [ ] **Step 4: Change the ordering in `render.js`**

Replace `render.js:55-56` — currently:

```js
      const ranked = (anchor ? [anchor].concat(scored) : scored)
        .sort((a, b) => (a.priority || 99) - (b.priority || 99));
```

with:

```js
      // DIVERGENCE from the vendored TK Resume Design System, 2026-09-07.
      // Was: .sort by priority alone, which forced the priority-1 anchor to
      // index 0 in every role. Surviving and LEADING are two different
      // guarantees and only survival was intended (see the anchor comment
      // above) — so a role's headline claim led even on a posting it had no
      // signal for. Now: tail bullets always sink, and the rest rank by theme
      // weight with priority as the tie-break. The anchor's guaranteed
      // INCLUSION at the lines above is untouched; it loses only its forced
      // first position. A weight-first sort WITHOUT the tail rule promotes
      // award bullets (principal p6, sr-director p9) to the top of a role,
      // which is why both halves are here.
      const byRank = (a, b) => {
        if (!!a.tail !== !!b.tail) return a.tail ? 1 : -1;
        if (a.tail && b.tail) return (a.priority || 99) - (b.priority || 99);
        const d = weight(b) - weight(a);
        return d !== 0 ? d : (a.priority || 99) - (b.priority || 99);
      };
      const ranked = (anchor ? [anchor].concat(scored) : scored).sort(byRank);
```

- [ ] **Step 5: Run the test and confirm it passes**

Run: `npx vitest run lib/resume-render/render-pipeline.test.ts`
Expected: PASS, including every pre-existing test in that file.

- [ ] **Step 6: Mark the two award bullets in the career record**

In `lib/resume-render/content/resume.json`, add `"tail": true` to exactly two bullets — the `principal` role's bullet whose text begins `"2024 A.I. Revenue Summit A.I. Strategist Award"` and the `sr-director` role's bullet whose text begins `"2024 MarTech Stackies Award"`. Verify with:

```bash
python3 -c "
import json
r=json.load(open('lib/resume-render/content/resume.json'))
print([(x['id'],b['id']) for x in r['roles'] for b in x['bullets'] if b.get('tail')])"
```
Expected: exactly two entries, one in `principal`, one in `sr-director`.

- [ ] **Step 7: Run the full gate**

Run: `npm test && npm run build`
Expected: all tests pass; build succeeds.

- [ ] **Step 8: Commit**

```bash
git add lib/resume-render/render.js lib/resume-render/render.d.ts \
        lib/resume-render/content/resume.json lib/resume-render/render-pipeline.test.ts
git commit -m "fix: a role leads with its most on-theme bullet, not its anchor"
```

---

### Task 2: `lib/resume-coverage.ts` — rendered vs full coverage

**Files:**
- Create: `lib/resume-coverage.ts`
- Test: `lib/resume-coverage.test.ts`

**Interfaces:**
- Consumes: `coverage`, `CareerRecord`, `ResumeSelection` from `lib/resume-render/render`; `ThemeVocabulary` from the same.
- Produces:

```ts
export interface ThemeCoverage {
  theme: string; pool: number; selected: number;
  roles: string[]; support: "absent" | "thin" | "strong";
  poolBeyondRendered: number;
}
export interface CoverageReport {
  themes: ThemeCoverage[]; gaps: string[]; unknown: string[];
  strength: number | null; overlayBullets: number; editedBullets: number;
}
export function coverageReport(
  career: CareerRecord, themes: string[],
  selection: ResumeSelection, vocabulary: ThemeVocabulary
): CoverageReport;
```

- [ ] **Step 1: Write the failing test**

Create `lib/resume-coverage.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { coverageReport } from "@/lib/resume-coverage";
import { selectBullets } from "@/lib/resume-render/render";
import type { CareerRecord, ThemeVocabulary } from "@/lib/resume-render/render";

const VOCAB = { themes: [
  { id: "systems", label: "Systems", jdSignals: [] },
  { id: "data", label: "Data", jdSignals: [] },
  { id: "absent", label: "Absent", jdSignals: [] },
] } as unknown as ThemeVocabulary;

function role(id: string, themes: string[][]) {
  return {
    id, title: id, org: "Org", dates: "2020 – 2021",
    bullets: themes.map((t, i) => ({ id: id + "-b" + i, priority: i + 1, themes: t, text: "x" })),
  };
}

const CAREER = {
  identity: { name: "T", contacts: [] },
  positioning: [{ id: "p", themes: [], tagline: "t", summary: "s" }],
  // compressAfter 1: only `shown` renders; `hidden` is a compressed one-line row.
  roles: [role("shown", [["systems"], ["systems"], ["data"]]), role("hidden", [["systems"], ["systems"]])],
  advisory: [], education: [],
  rules: { taper: [3, 2], themes: ["systems", "data"], compressAfter: 1 },
} as unknown as CareerRecord;

describe("coverageReport", () => {
  const selection = selectBullets(CAREER, { themes: ["systems", "data", "absent"] });
  const report = coverageReport(CAREER, ["systems", "data", "absent"], selection, VOCAB);

  it("counts only bullets that actually render", () => {
    const systems = report.themes.find((t) => t.theme === "systems")!;
    expect(systems.pool).toBe(2);
    expect(systems.poolBeyondRendered).toBe(2);
    expect(systems.roles).toEqual(["shown"]);
  });

  it("reports a theme with no support as absent and lists it in gaps", () => {
    expect(report.themes.find((t) => t.theme === "absent")!.support).toBe("absent");
    expect(report.gaps).toContain("absent");
  });

  it("verdicts thin below three supporting bullets", () => {
    expect(report.themes.find((t) => t.theme === "data")!.support).toBe("thin");
  });

  it("computes strength over rendered bullets only", () => {
    expect(report.strength).not.toBeNull();
    expect(report.strength!).toBeGreaterThan(0);
    expect(report.strength!).toBeLessThanOrEqual(1);
  });

  it("counts overlay and edited bullets", () => {
    const withMeta = JSON.parse(JSON.stringify(CAREER));
    withMeta.roles[0].bullets[0].origin = "overlay";
    withMeta.roles[0].bullets[1].edited = true;
    const sel = selectBullets(withMeta, { themes: ["systems"] });
    const r = coverageReport(withMeta, ["systems"], sel, VOCAB);
    expect(r.overlayBullets).toBe(1);
    expect(r.editedBullets).toBe(1);
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npx vitest run lib/resume-coverage.test.ts`
Expected: FAIL — `Cannot find module '@/lib/resume-coverage'`.

- [ ] **Step 3: Implement the module**

Create `lib/resume-coverage.ts`:

```ts
/**
 * The coverage report the tailor screen shows and the chat agent is given.
 *
 * `coverage()` in the vendored render.js audits the whole POOL: selectBullets
 * fills `bullets` for every role (render.js:41) while renderBody renders only
 * roles.slice(0, compressAfter) (render.js:117-119). Measured on the shipped
 * record with themes systems/data/ops that is 23 selected against 16 rendered,
 * strength 0.870 against 0.813, and six of ten roles listed for `systems` being
 * compressed one-line rows carrying no bullets at all. A panel that claims to
 * show what produced THIS document must not describe a different one.
 *
 * So coverage() is called twice against the effective record — once narrowed to
 * the rendered roles (the numbers shown) and once whole (only to say how much
 * more support is stranded in compressed roles, which is actionable, because
 * raising compressAfter is an operation the agent can perform).
 */
import { coverage } from "@/lib/resume-render/render";
import type { CareerRecord, ResumeSelection, ThemeVocabulary } from "@/lib/resume-render/render";

export interface ThemeCoverage {
  theme: string;
  pool: number;
  selected: number;
  roles: string[];
  support: "absent" | "thin" | "strong";
  /** Supporting bullets that exist but sit in compressed roles. */
  poolBeyondRendered: number;
}

export interface CoverageReport {
  themes: ThemeCoverage[];
  gaps: string[];
  unknown: string[];
  strength: number | null;
  overlayBullets: number;
  editedBullets: number;
}

/** The roles renderBody actually draws bullets for (render.js:117-119). */
function renderedRoles(career: CareerRecord): CareerRecord {
  const compressAfter = career.rules ? career.rules.compressAfter : null;
  if (compressAfter == null) return career;
  return { ...career, roles: career.roles.slice(0, compressAfter) };
}

export function coverageReport(
  career: CareerRecord,
  themes: string[],
  selection: ResumeSelection,
  vocabulary: ThemeVocabulary
): CoverageReport {
  const rendered = renderedRoles(career);
  const near = coverage(rendered, themes, selection, vocabulary);
  const full = coverage(career, themes, selection, vocabulary);

  const byTheme: Record<string, number> = {};
  full.themes.forEach((t) => {
    byTheme[t.theme] = t.pool;
  });

  let overlayBullets = 0;
  let editedBullets = 0;
  const picked = selection.bullets || {};
  rendered.roles.forEach((role) => {
    const ids = picked[role.id] || [];
    role.bullets.forEach((b) => {
      if (ids.indexOf(b.id) === -1) return;
      const meta = b as { origin?: string; edited?: boolean };
      if (meta.origin === "overlay") overlayBullets += 1;
      if (meta.edited === true) editedBullets += 1;
    });
  });

  return {
    themes: near.themes.map((t) => ({
      theme: t.theme,
      pool: t.pool,
      selected: t.selected,
      roles: t.roles,
      support: t.support,
      poolBeyondRendered: Math.max(0, (byTheme[t.theme] || 0) - t.pool),
    })),
    gaps: near.gaps,
    unknown: near.unknown,
    strength: near.strength,
    overlayBullets,
    editedBullets,
  };
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `npx vitest run lib/resume-coverage.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/resume-coverage.ts lib/resume-coverage.test.ts
git commit -m "feat: coverage report scoped to what the document actually renders"
```

---

### Task 3: `lib/resume-text.ts` — the authored-text boundary

**Files:**
- Create: `lib/resume-text.ts`
- Test: `lib/resume-text.test.ts`

**Interfaces:**
- Consumes: `sanitize-html` (already a dependency, see `lib/resume-sanitize.ts:17`).
- Produces: `export const MAX_BULLET_CHARS = 600;` and
  `export function sanitizeBulletText(input: string): { text?: string; error?: string }`

- [ ] **Step 1: Write the failing test**

Create `lib/resume-text.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { sanitizeBulletText, MAX_BULLET_CHARS } from "@/lib/resume-text";

describe("sanitizeBulletText", () => {
  it("keeps a legitimate <strong> byte-identically", () => {
    const input = "Owned a <strong>$100M+</strong> pipeline engine.";
    expect(sanitizeBulletText(input).text).toBe(input);
  });

  it("keeps the other three inline tags", () => {
    expect(sanitizeBulletText("<b>a</b> <i>b</i> <em>c</em>").text).toBe("<b>a</b> <i>b</i> <em>c</em>");
  });

  it("escapes an image payload rather than deleting it", () => {
    const out = sanitizeBulletText('Led <img src=x onerror=alert(1)> the team').text!;
    expect(out).not.toContain("<img");
    expect(out).toContain("&lt;img");
    expect(out).not.toContain("onerror=alert(1)>");
  });

  it("escapes a script tag and does not leave its contents as live markup", () => {
    const out = sanitizeBulletText("<script>alert(1)</script>").text!;
    expect(out).not.toContain("<script");
    expect(out).toContain("&lt;script&gt;");
  });

  it("drops an anchor's javascript: href by escaping the whole tag", () => {
    const out = sanitizeBulletText('<a href="javascript:alert(1)">x</a>').text!;
    expect(out).not.toContain("<a ");
    expect(out).toContain("&lt;a");
  });

  it("escapes a bare ampersand", () => {
    expect(sanitizeBulletText("Sales & Marketing").text).toBe("Sales &amp; Marketing");
  });

  it("rejects rather than truncates over the length cap", () => {
    const res = sanitizeBulletText("x".repeat(MAX_BULLET_CHARS + 1));
    expect(res.text).toBeUndefined();
    expect(res.error).toContain("too long");
  });

  it("rejects empty or whitespace-only text", () => {
    expect(sanitizeBulletText("   ").error).toBeDefined();
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npx vitest run lib/resume-text.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the module**

Create `lib/resume-text.ts`:

```ts
/**
 * The ONE boundary for text this app did not author itself — a chat `set_text`
 * value, or a proposed overlay bullet.
 *
 * Why this has to exist: render.js:155 emits '<li>' + b.text + '</li>' with NO
 * escaping (lib/resume-sanitize.ts:5-8 documents that deliberately — the career
 * record carries 22 <strong> tags that must survive), and renderBody's output
 * reaches the DOM through dangerouslySetInnerHTML on the CLIENT
 * (ResumeDocument.tsx:80), where sanitizeResumeHtml — which runs server-side on
 * Save only — has never run. So a model-authored bullet is a script tag away
 * from executing in the user's browser.
 *
 * ESCAPES rather than strips. sanitize-html's default drops a disallowed tag
 * and keeps its text, which would silently delete part of what the user asked
 * for; `disallowedTagsMode: "escape"` renders the payload as visible, inert
 * text instead, so a blocked edit is something the user can SEE.
 *
 * Applied at three boundaries, because each alone has a bypass: operation
 * validation (lib/resume-ops.ts), the effectiveCareer merge (so a row written
 * by an earlier build cannot render unsafe), and sanitizeResumeHtml on Save.
 */
import sanitizeHtml from "sanitize-html";

export const MAX_BULLET_CHARS = 600;

export function sanitizeBulletText(input: string): { text?: string; error?: string } {
  if (typeof input !== "string" || input.trim() === "") {
    return { error: "That text is empty." };
  }
  if (input.length > MAX_BULLET_CHARS) {
    return {
      error:
        "That text is too long (" + input.length + " characters; the limit is " + MAX_BULLET_CHARS + ").",
    };
  }
  const text = sanitizeHtml(input, {
    allowedTags: ["strong", "b", "em", "i"],
    allowedAttributes: {},
    allowedSchemes: [],
    disallowedTagsMode: "escape",
  });
  return { text };
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `npx vitest run lib/resume-text.test.ts`
Expected: PASS (8 tests).

If the ampersand assertion fails, sanitize-html is not re-encoding a bare `&`; change that one assertion to `expect(sanitizeBulletText("Sales & Marketing").text).toContain("Marketing")` and add a comment recording the actual behaviour — the security-relevant assertions are the tag ones and must not be relaxed.

- [ ] **Step 5: Commit**

```bash
git add lib/resume-text.ts lib/resume-text.test.ts
git commit -m "feat: escape and tag-limit authored resume text at one boundary"
```

---

### Task 4: `lib/resume-design-tokens.ts` — allowlist and value parser

**Files:**
- Create: `lib/resume-design-tokens.ts`
- Test: `lib/resume-design-tokens.test.ts`

**Interfaces:**
- Produces:

```ts
export type TokenName = string;
export const DESIGN_TOKENS: { name: string; kind: "length" | "color"; min?: number; max?: number; units?: string[] }[];
export function parseTokenValue(name: string, value: string): { value?: string; error?: string };
export function styleAttributeFor(overrides: Record<string, string>): string;
export const PAGE_MARGIN = { min: 0.25, max: 1.5, units: ["in", "mm", "px"] };
export function parsePageMargin(value: string): { value?: string; error?: string };
export const TOKEN_STYLE_RULES: Record<string, RegExp[]>;
```

- [ ] **Step 1: Write the failing test**

Create `lib/resume-design-tokens.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  DESIGN_TOKENS, parseTokenValue, styleAttributeFor, parsePageMargin, TOKEN_STYLE_RULES,
} from "@/lib/resume-design-tokens";
import fs from "node:fs";
import path from "node:path";

describe("design token allowlist", () => {
  it("only lists tokens the stylesheets actually consume", () => {
    const dir = path.join(process.cwd(), "public/resume-design");
    const css = fs
      .readdirSync(path.join(dir, "tokens"))
      .map((f) => fs.readFileSync(path.join(dir, "tokens", f), "utf8"))
      .join("\n");
    for (const t of DESIGN_TOKENS) {
      expect(css.indexOf("var(" + t.name), t.name + " has no consumer").toBeGreaterThan(-1);
    }
  });

  it("has a style rule for every allowlisted token and no others", () => {
    expect(Object.keys(TOKEN_STYLE_RULES).sort()).toEqual(DESIGN_TOKENS.map((t) => t.name).sort());
  });
});

describe("parseTokenValue", () => {
  it("accepts a bounded length in an allowed unit", () => {
    expect(parseTokenValue("--rail", "120px").value).toBe("120px");
  });

  it("rejects an unknown token", () => {
    expect(parseTokenValue("--page-width", "9in").error).toContain("not adjustable");
  });

  it("rejects a length outside its bounds", () => {
    expect(parseTokenValue("--rail", "9000px").error).toBeDefined();
  });

  it("rejects an unknown unit", () => {
    expect(parseTokenValue("--rail", "12vw").error).toBeDefined();
  });

  it("rejects a CSS injection attempt", () => {
    expect(parseTokenValue("--rail", "1px } .rsm { background:url(http://e)").error).toBeDefined();
    expect(parseTokenValue("--rail", "url(http://evil/x)").error).toBeDefined();
  });

  it("accepts oklch, hex and a named colour for a colour token", () => {
    expect(parseTokenValue("--link", "oklch(0.62 0.012 40)").value).toBe("oklch(0.62 0.012 40)");
    expect(parseTokenValue("--link", "#1a2b3c").value).toBe("#1a2b3c");
    expect(parseTokenValue("--link", "black").value).toBe("black");
  });

  it("rejects a colour that is a function call other than oklch", () => {
    expect(parseTokenValue("--link", "image-set(x)").error).toBeDefined();
  });
});

describe("styleAttributeFor", () => {
  it("renders only valid declarations, in a stable order", () => {
    expect(styleAttributeFor({ "--rail": "120px", "--link": "black" })).toBe("--link:black;--rail:120px");
  });

  it("omits anything invalid rather than emitting it", () => {
    expect(styleAttributeFor({ "--rail": "9000px" })).toBe("");
  });
});

describe("parsePageMargin", () => {
  it("accepts inches within bounds", () => {
    expect(parsePageMargin("0.5in").value).toBe("0.5in");
  });
  it("rejects out-of-bounds and bad units", () => {
    expect(parsePageMargin("9in").error).toBeDefined();
    expect(parsePageMargin("0.5em").error).toBeDefined();
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npx vitest run lib/resume-design-tokens.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the module**

Create `lib/resume-design-tokens.ts`:

```ts
/**
 * What the chat agent may retune about the document, and how a value is proved
 * safe. ONE module, because the write path and the sanitizer must agree: a
 * value the agent cannot set must also be a value that cannot be saved.
 *
 * Every token here was verified to have a consumer — `grep -rF "var(--x"` over
 * public/resume-design. Five obvious-looking candidates were dropped because
 * nothing reads them (--page-margin, --stack-entry, --col-side, --measure-prose,
 * --text-accent): setting one changes nothing while the agent reports success.
 * A test re-derives that from the stylesheets so the list cannot rot.
 *
 * --rule-200 is here alongside --rule-100 because --rule-100 alone reaches only
 * .rsm-role's bottom hairline (document.css:37); the section rules go through
 * --border-rule -> --rule-200 (document.css:22, colors.css:21), so without both
 * "change the rule colour" changes half the rules.
 *
 * Excluded on purpose: --page-width/--page-height (a document that is not US
 * Letter prints wrong with no on-screen symptom), the font families (an
 * unloaded face falls back silently), everything in elevation.css (screen-only).
 *
 * NO /u FLAG AND NO \p{...} IN THIS FILE. tsconfig declares no target, so the
 * build typechecks at ES5 and either passes vitest then fails `npm run build`
 * (lib/resume-sanitize.ts:27 carries the same warning).
 */

interface TokenSpec {
  name: string;
  kind: "length" | "color";
  min?: number;
  max?: number;
  units?: string[];
}

const LENGTH_UNITS = ["px", "pt", "rem", "em", "%", "ch"];

export const DESIGN_TOKENS: TokenSpec[] = [
  { name: "--rail", kind: "length", min: 40, max: 260, units: LENGTH_UNITS },
  { name: "--gap-bullet", kind: "length", min: 0, max: 48, units: LENGTH_UNITS },
  { name: "--type-body", kind: "length", min: 6, max: 24, units: LENGTH_UNITS },
  { name: "--type-meta", kind: "length", min: 5, max: 20, units: LENGTH_UNITS },
  { name: "--type-name", kind: "length", min: 12, max: 72, units: LENGTH_UNITS },
  { name: "--type-org", kind: "length", min: 6, max: 24, units: LENGTH_UNITS },
  { name: "--type-role", kind: "length", min: 6, max: 28, units: LENGTH_UNITS },
  { name: "--type-section", kind: "length", min: 5, max: 20, units: LENGTH_UNITS },
  { name: "--leading-tight", kind: "length", min: 0.8, max: 2.4, units: LENGTH_UNITS.concat([""]) },
  { name: "--tracking-tight", kind: "length", min: -0.1, max: 0.5, units: LENGTH_UNITS.concat([""]) },
  { name: "--ink-900", kind: "color" },
  { name: "--text-primary", kind: "color" },
  { name: "--rule-100", kind: "color" },
  { name: "--rule-200", kind: "color" },
  { name: "--link", kind: "color" },
];

const SPEC_BY_NAME: Record<string, TokenSpec> = {};
DESIGN_TOKENS.forEach((t) => {
  SPEC_BY_NAME[t.name] = t;
});

// Anchored, no /u flag. A value is a number plus an optional allowed unit, or a
// colour in one of three shapes. Anchoring is what rejects "1px } .rsm { ... }".
const LENGTH_RE = /^-?[0-9]+(\.[0-9]+)?(px|pt|rem|em|%|ch)?$/;
const OKLCH_RE = /^oklch\([0-9. ]+(\/[0-9. ]+)?\)$/;
const HEX_RE = /^#[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/;
const NAMED_COLORS = ["black", "white", "transparent", "currentColor", "inherit"];

function parseLength(spec: TokenSpec, value: string): { value?: string; error?: string } {
  const trimmed = value.trim();
  if (!LENGTH_RE.test(trimmed)) {
    return { error: trimmed + " is not a plain length (a number, optionally with px/pt/rem/em/%/ch)." };
  }
  const unit = trimmed.replace(/^-?[0-9.]+/, "");
  const units = spec.units || LENGTH_UNITS;
  if (units.indexOf(unit) === -1) {
    return { error: (unit || "a bare number") + " is not an accepted unit for " + spec.name + "." };
  }
  const n = parseFloat(trimmed);
  if (spec.min != null && n < spec.min) return { error: spec.name + " must be at least " + spec.min + "." };
  if (spec.max != null && n > spec.max) return { error: spec.name + " must be at most " + spec.max + "." };
  return { value: trimmed };
}

function parseColor(spec: TokenSpec, value: string): { value?: string; error?: string } {
  const trimmed = value.trim();
  if (OKLCH_RE.test(trimmed) || HEX_RE.test(trimmed) || NAMED_COLORS.indexOf(trimmed) !== -1) {
    return { value: trimmed };
  }
  return { error: trimmed + " is not a colour this document accepts (oklch(...), #hex, or a basic name)." };
}

export function parseTokenValue(name: string, value: string): { value?: string; error?: string } {
  const spec = SPEC_BY_NAME[name];
  if (!spec) return { error: name + " is not adjustable on this document." };
  if (typeof value !== "string") return { error: "That value is not text." };
  return spec.kind === "length" ? parseLength(spec, value) : parseColor(spec, value);
}

/** The inline style attribute for the .rsm root. Invalid entries are omitted. */
export function styleAttributeFor(overrides: Record<string, string>): string {
  return Object.keys(overrides)
    .sort()
    .map((name) => {
      const parsed = parseTokenValue(name, overrides[name]);
      return parsed.value === undefined ? null : name + ":" + parsed.value;
    })
    .filter((d): d is string => d !== null)
    .join(";");
}

export const PAGE_MARGIN = { min: 0.25, max: 1.5, units: ["in", "mm", "px"] };
const PAGE_MARGIN_RE = /^[0-9]+(\.[0-9]+)?(in|mm|px)$/;

/**
 * The page margin is NOT a token. It is the `margin` attribute on <doc-page>
 * (ResumeDocument.tsx:76), which doc-page.js maps to its own --doc-page-margin
 * on an ANCESTOR of .rsm — unreachable from an inline override on .rsm under
 * any spelling. Its bounds are in whatever unit was given, so mm and px are
 * converted to inches before the range check.
 */
export function parsePageMargin(value: string): { value?: string; error?: string } {
  const trimmed = String(value).trim();
  if (!PAGE_MARGIN_RE.test(trimmed)) {
    return { error: trimmed + " is not a page margin (a number with in, mm or px)." };
  }
  const n = parseFloat(trimmed);
  const unit = trimmed.replace(/^[0-9.]+/, "");
  const inches = unit === "in" ? n : unit === "mm" ? n / 25.4 : n / 96;
  if (inches < PAGE_MARGIN.min || inches > PAGE_MARGIN.max) {
    return { error: "The page margin must be between " + PAGE_MARGIN.min + "in and " + PAGE_MARGIN.max + "in." };
  }
  return { value: trimmed };
}

/**
 * The same allowlist expressed as sanitize-html's `allowedStyles` shape, so the
 * sanitizer and the write path cannot drift. Values are matched by the same
 * regexes; range checks are the write path's job, and a saved out-of-range value
 * is a cosmetic problem, never a safety one.
 */
export const TOKEN_STYLE_RULES: Record<string, RegExp[]> = (() => {
  const rules: Record<string, RegExp[]> = {};
  DESIGN_TOKENS.forEach((t) => {
    rules[t.name] = t.kind === "length" ? [LENGTH_RE] : [OKLCH_RE, HEX_RE, new RegExp("^(" + NAMED_COLORS.join("|") + ")$")];
  });
  return rules;
})();
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `npx vitest run lib/resume-design-tokens.test.ts`
Expected: PASS. If the "only lists tokens the stylesheets actually consume" test fails for a token, DELETE that token from `DESIGN_TOKENS` — do not weaken the test. That test is the whole defence against shipping inert knobs.

- [ ] **Step 5: Commit**

```bash
git add lib/resume-design-tokens.ts lib/resume-design-tokens.test.ts
git commit -m "feat: allowlist and parser for per-document design tokens"
```

---

### Task 5: Sanitizer accepts custom properties on the `.rsm` root

**Files:**
- Modify: `lib/resume-sanitize.ts:49-52`
- Test: `lib/resume-sanitize.test.ts`
- Regenerate: `lib/__fixtures__/resume-sanitized.html`

**Interfaces:**
- Consumes: `TOKEN_STYLE_RULES` from `lib/resume-design-tokens.ts` (Task 4).
- Produces: no signature change to `sanitizeResumeHtml`.

- [ ] **Step 1: Write the failing test**

Append to `lib/resume-sanitize.test.ts`:

```ts
describe("design token overrides on the .rsm root", () => {
  it("keeps an allowlisted custom property", () => {
    const html = '<div class="rsm" style="--rail:120px"><p>x</p></div>';
    expect(sanitizeResumeHtml(html).html).toContain("--rail:120px");
  });

  it("strips a property that is not on the allowlist", () => {
    const html = '<div class="rsm" style="--rail:120px;background:red"><p>x</p></div>';
    const out = sanitizeResumeHtml(html).html!;
    expect(out).toContain("--rail:120px");
    expect(out).not.toContain("background");
  });

  // The reason allowedStyles.div is not optional: filterCss falls back to
  // allowedStyles['*'] and, when neither key exists, returns declarations
  // UNFILTERED. Adding div to allowedAttributes without this pairing opens
  // arbitrary inline CSS on every div the renderer emits.
  it("strips arbitrary CSS from a non-root div", () => {
    const html = '<div class="rsm"><div class="rsm-role" style="background:url(http://evil)">x</div></div>';
    expect(sanitizeResumeHtml(html).html).not.toContain("evil");
  });

  it("rejects a value that tries to escape the declaration", () => {
    const html = '<div class="rsm" style="--rail:1px } .rsm { background:url(http://evil)"><p>x</p></div>';
    expect(sanitizeResumeHtml(html).html).not.toContain("evil");
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npx vitest run lib/resume-sanitize.test.ts`
Expected: FAIL on the first two — `style` is not currently allowed on `div`, so `--rail:120px` is stripped.

- [ ] **Step 3: Change the sanitizer config**

In `lib/resume-sanitize.ts`, add the import at the top:

```ts
import { TOKEN_STYLE_RULES } from "@/lib/resume-design-tokens";
```

Replace lines 49-52 (the `allowedAttributes` / `allowedStyles` pair) with:

```ts
    allowedTags: ALLOWED_TAGS,
    // `div: ["style"]` carries the chat's per-document design tokens, which
    // renderBody puts on the .rsm root and useResumeCapture therefore captures.
    // THE allowedStyles.div ENTRY BELOW IS NOT OPTIONAL: sanitize-html's
    // filterCss does `allowedStyles[selector] || allowedStyles['*']` and, when
    // neither key exists, returns every declaration UNFILTERED — so this
    // attribute without that rule set opens arbitrary inline CSS on all ~40
    // divs renderBody emits plus whatever contentEditable produces. A test
    // pins the pairing. allowedStyles is keyed by TAG, never by class, so this
    // permits allowlisted custom properties on any div; that is accepted
    // deliberately, because the VALUE allowlist is what makes it safe.
    allowedAttributes: { "*": ["class"], a: ["href"], section: ["style"], div: ["style"] },
    allowedClasses: { "*": [RSM_CLASS] },
    allowedStyles: { section: { "margin-bottom": [/^0$/] }, div: TOKEN_STYLE_RULES },
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `npx vitest run lib/resume-sanitize.test.ts`
Expected: PASS, including every pre-existing test in the file.

- [ ] **Step 5: Check the checked-in fixture and regenerate it only if it moved**

Run: `npm test 2>&1 | grep -i fixture`
If `lib/__fixtures__/resume-sanitized.html` now fails, regenerate it with whatever command that test names, then **read the diff before staging it**:

```bash
git diff lib/__fixtures__/resume-sanitized.html
```

Expected diff: nothing, or only a `style` attribute appearing on the `.rsm` root. Any other change means the config edit did more than intended — stop and investigate rather than blessing it.

- [ ] **Step 6: Run the full gate**

Run: `npm test && npm run build`

- [ ] **Step 7: Commit**

```bash
git add lib/resume-sanitize.ts lib/resume-sanitize.test.ts lib/__fixtures__/resume-sanitized.html
git commit -m "feat: sanitizer admits allowlisted design tokens on the resume root"
```

---

### Task 6: `renderBody` accepts a root style

**Files:**
- Modify: `lib/resume-render/render.js:106-127`
- Modify: `lib/resume-render/render.d.ts`
- Test: `lib/resume-render/render-pipeline.test.ts`

**Interfaces:**
- Produces: `renderBody(career, selection, opts?)` where `opts` is `{ rootStyle?: string }`.

- [ ] **Step 1: Write the failing test**

Append to `lib/resume-render/render-pipeline.test.ts`:

```ts
import { renderBody } from "@/lib/resume-render/render";

describe("renderBody rootStyle", () => {
  it("puts the style on the .rsm root", () => {
    const html = renderBody(ORDERING_FIXTURE, undefined, { rootStyle: "--rail:120px" });
    expect(html.indexOf('<div class="rsm" style="--rail:120px">')).toBe(0);
  });

  it("emits the bare root when no style is given", () => {
    expect(renderBody(ORDERING_FIXTURE, undefined).indexOf('<div class="rsm">')).toBe(0);
  });

  it("never emits a style attribute for an empty string", () => {
    expect(renderBody(ORDERING_FIXTURE, undefined, { rootStyle: "" })).toContain('<div class="rsm">');
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npx vitest run lib/resume-render/render-pipeline.test.ts -t rootStyle`
Expected: FAIL — the root is always `<div class="rsm">`.

- [ ] **Step 3: Implement**

In `render.js`, change the `renderBody` signature (currently `function renderBody(career, selection) {`) to `function renderBody(career, selection, opts) {`, and replace `out.push('<div class="rsm">');` (:127) with:

```js
    // DIVERGENCE from the vendored TK Resume Design System, 2026-09-07.
    // opts.rootStyle carries the chat's per-document design token overrides.
    // It belongs HERE and nowhere else: .rsm is a child of <doc-page>, and
    // useResumeCapture captures docPageEl.innerHTML — so an attribute on this
    // element rides into saved_resumes for free, while the same declarations
    // set on <doc-page> itself, or in a <style> in the head, look identical on
    // screen and are silently lost on Save. Splicing the attribute in from the
    // app instead would be hand-building .rsm markup, which this file's header
    // forbids. The value is produced and re-validated by
    // lib/resume-design-tokens.ts; this function does not parse it.
    const rootStyle = (opts && opts.rootStyle) || '';
    out.push(rootStyle ? '<div class="rsm" style="' + rootStyle + '">' : '<div class="rsm">');
```

In `render.d.ts`, update the `renderBody` declaration to:

```ts
export interface RenderOptions {
  /** Validated CSS custom-property declarations for the .rsm root. */
  rootStyle?: string;
}
export function renderBody(
  career: CareerRecord,
  selection?: ResumeSelection,
  opts?: RenderOptions
): string;
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `npx vitest run lib/resume-render/render-pipeline.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/resume-render/render.js lib/resume-render/render.d.ts lib/resume-render/render-pipeline.test.ts
git commit -m "feat: renderBody takes a validated root style for design overrides"
```

---

### Task 7: Career overlay store and `effectiveCareer()`

**Files:**
- Modify: `lib/settings-store.ts` (new key + reader + writer)
- Create: `lib/effective-career.ts`
- Test: `lib/effective-career.test.ts`

**Interfaces:**
- Consumes: `sanitizeBulletText` (Task 3); `upsertSetting`, `SettingRow` from `lib/settings-store.ts`.
- Produces:

```ts
// lib/settings-store.ts
export const CAREER_OVERLAY_KEY = "career_overlay";
export interface OverlayBullet { id: string; roleId: string; text: string; themes: string[]; priority?: number }
export function careerOverlayFrom(rows: SettingRow[]): OverlayBullet[];
export function writeCareerOverlay(overlay: OverlayBullet[]): Promise<{ error?: string }>;

// lib/effective-career.ts
export interface TextOverrides { [target: string]: string }
export function effectiveCareer(
  shipped: CareerRecord, overlay: OverlayBullet[], text: TextOverrides
): { career: CareerRecord; warnings: string[] };
```

Target strings for `TextOverrides`: `bullet:<roleId>:<bulletId>`, `summary`, `positioning`.

- [ ] **Step 1: Write the failing test**

Create `lib/effective-career.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { effectiveCareer } from "@/lib/effective-career";
import type { CareerRecord } from "@/lib/resume-render/render";

const SHIPPED = {
  identity: { name: "T", contacts: [] },
  positioning: [{ id: "pos", themes: [], tagline: "tag", summary: "shipped summary" }],
  roles: [
    { id: "r1", title: "R1", org: "Org", dates: "2020 – Present",
      bullets: [{ id: "b1", priority: 1, themes: ["ops"], text: "shipped bullet" }] },
  ],
  advisory: [], education: [],
  rules: { taper: [4], themes: ["ops", "systems"], compressAfter: null },
} as unknown as CareerRecord;

describe("effectiveCareer", () => {
  it("merges an overlay bullet into its role", () => {
    const { career } = effectiveCareer(SHIPPED, [
      { id: "ov-1", roleId: "r1", text: "overlay bullet", themes: ["systems"] },
    ], {});
    const bullets = career.roles[0].bullets;
    expect(bullets.map((b) => b.id)).toEqual(["b1", "ov-1"]);
    expect((bullets[1] as { origin?: string }).origin).toBe("overlay");
  });

  it("warns rather than silently dropping an overlay for an unknown role", () => {
    const { career, warnings } = effectiveCareer(SHIPPED, [
      { id: "ov-9", roleId: "nope", text: "x", themes: [] },
    ], {});
    expect(career.roles[0].bullets).toHaveLength(1);
    expect(warnings.join(" ")).toContain("nope");
  });

  it("applies a text override by id and marks the bullet edited", () => {
    const { career } = effectiveCareer(SHIPPED, [], { "bullet:r1:b1": "edited text" });
    expect(career.roles[0].bullets[0].text).toBe("edited text");
    expect((career.roles[0].bullets[0] as { edited?: boolean }).edited).toBe(true);
  });

  it("sanitizes a stored text override at merge time", () => {
    const { career } = effectiveCareer(SHIPPED, [], { "bullet:r1:b1": "<img src=x onerror=alert(1)>" });
    expect(career.roles[0].bullets[0].text).not.toContain("<img");
  });

  it("sanitizes overlay text at merge time", () => {
    const { career } = effectiveCareer(SHIPPED, [
      { id: "ov-1", roleId: "r1", text: "<script>alert(1)</script>", themes: [] },
    ], {});
    expect(career.roles[0].bullets[1].text).not.toContain("<script");
  });

  it("overrides the positioning summary", () => {
    const { career } = effectiveCareer(SHIPPED, [], { summary: "new summary" });
    expect(career.positioning[0].summary).toBe("new summary");
  });

  it("returns a fresh record and never mutates the shipped one", () => {
    const before = JSON.stringify(SHIPPED);
    const { career } = effectiveCareer(SHIPPED, [
      { id: "ov-1", roleId: "r1", text: "x", themes: [] },
    ], { "bullet:r1:b1": "y" });
    expect(JSON.stringify(SHIPPED)).toBe(before);
    expect(career).not.toBe(SHIPPED);
    expect(career.roles[0]).not.toBe(SHIPPED.roles[0]);
  });

  it("ignores a text override naming a bullet that does not exist", () => {
    const { warnings } = effectiveCareer(SHIPPED, [], { "bullet:r1:nope": "x" });
    expect(warnings.join(" ")).toContain("nope");
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npx vitest run lib/effective-career.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Add the overlay key, reader and writer to `lib/settings-store.ts`**

After the `ENRICH_RESCORED_AT_KEY` block (~line 161), add:

```ts
/**
 * Bullets the user accepted from the résumé chat, which are NOT in the
 * checked-in career record.
 *
 * A standalone key, deliberately NOT a SETTING_KEYS member — the same call
 * PROFILE_KEY and JOB_STATUSES_KEY make, and for the same reason: the value is
 * a whole array of objects, so admitting it would force another shape group
 * onto mergeSettings, which is shape-guarded for the list/text/number values
 * that ARE Criteria fields.
 *
 * It cannot be a write to lib/resume-render/content/resume.json: that file is
 * checked in and bundled, a runtime write on Railway does not survive the next
 * deploy, and it is the git history that makes the career record auditable.
 */
export const CAREER_OVERLAY_KEY = "career_overlay";

export interface OverlayBullet {
  /** Namespaced `ov-*` at creation so it can never collide with a record id. */
  id: string;
  roleId: string;
  text: string;
  themes: string[];
  priority?: number;
}

/** REPAIRS whatever is in the row rather than rejecting it — the contract
 *  resolveStatuses established and resolveProfile follows. A malformed entry is
 *  dropped; a malformed ROW reads as no overlay at all. */
export function careerOverlayFrom(rows: SettingRow[]): OverlayBullet[] {
  const value = rows.find((r) => r.key === CAREER_OVERLAY_KEY)?.value;
  if (!Array.isArray(value)) return [];
  return value
    .filter((b): b is OverlayBullet => {
      if (!b || typeof b !== "object") return false;
      const o = b as Record<string, unknown>;
      return (
        typeof o.id === "string" &&
        typeof o.roleId === "string" &&
        typeof o.text === "string" &&
        Array.isArray(o.themes)
      );
    })
    .map((b) => ({
      id: b.id,
      roleId: b.roleId,
      text: b.text,
      themes: b.themes.filter((t) => typeof t === "string"),
      priority: typeof b.priority === "number" ? b.priority : undefined,
    }));
}

export async function writeCareerOverlay(overlay: OverlayBullet[]): Promise<{ error?: string }> {
  return upsertSetting(CAREER_OVERLAY_KEY, overlay);
}
```

Then widen `upsertSetting`'s key union (`lib/settings-store.ts:402-411`) by adding one line — `| typeof CAREER_OVERLAY_KEY` — after `| typeof ENRICH_RESCORED_AT_KEY`. The comment above that union says to add a literal per stamp and never `string`; follow it.

- [ ] **Step 4: Implement `lib/effective-career.ts`**

```ts
/**
 * The ONE record everything downstream sees.
 *
 * There are no override "layers" threaded through the renderer, and that is
 * deliberate: renderBody runs on the CLIENT, from a vendored file, and
 * app/resume/page.tsx used to hand it the record imported statically from
 * content/resume.json. Any override the server knew about and that record did
 * not would silently fail to render — render.js:145 resolves ids against the
 * record and .filter(Boolean) drops what it cannot find, and :146 drops the
 * whole ROLE when nothing survives. So the server merges once, up front, and
 * selectBullets, renderBody and coverage all operate on the result.
 *
 * Every returned object is fresh. The shipped record is a module-level import
 * shared for the life of the process, so mutating it would corrupt every later
 * request — the hazard resolveProfile records for DEFAULT_PROFILE.
 */
import { sanitizeBulletText } from "@/lib/resume-text";
import type { CareerRecord } from "@/lib/resume-render/render";
import type { OverlayBullet } from "@/lib/settings-store";

export interface TextOverrides {
  [target: string]: string;
}

function cleaned(text: string): string | null {
  const res = sanitizeBulletText(text);
  return res.text === undefined ? null : res.text;
}

export function effectiveCareer(
  shipped: CareerRecord,
  overlay: OverlayBullet[],
  text: TextOverrides
): { career: CareerRecord; warnings: string[] } {
  const warnings: string[] = [];
  const roleIds: Record<string, true> = {};
  shipped.roles.forEach((r) => {
    roleIds[r.id] = true;
  });

  overlay.forEach((b) => {
    if (!roleIds[b.roleId]) {
      // Surfaced, not silent: after a record change this is the user's own text
      // disappearing, and they are the only one who can decide what to do.
      warnings.push('An added bullet refers to a role that no longer exists ("' + b.roleId + '").');
    }
  });

  const career: CareerRecord = {
    ...shipped,
    positioning: shipped.positioning.map((p) => ({ ...p })),
    roles: shipped.roles.map((role) => {
      const own = role.bullets.map((b) => {
        const override = text["bullet:" + role.id + ":" + b.id];
        if (override === undefined) return { ...b };
        const safe = cleaned(override);
        if (safe === null) return { ...b };
        return { ...b, text: safe, edited: true };
      });
      const added = overlay
        .filter((o) => o.roleId === role.id)
        .map((o) => {
          const safe = cleaned(o.text);
          if (safe === null) return null;
          return {
            id: o.id,
            priority: o.priority == null ? 90 : o.priority,
            themes: o.themes,
            text: safe,
            origin: "overlay" as const,
          };
        })
        .filter((b): b is NonNullable<typeof b> => b !== null);
      return { ...role, bullets: own.concat(added as typeof own) };
    }),
  };

  Object.keys(text).forEach((target) => {
    if (target.indexOf("bullet:") !== 0) return;
    const parts = target.split(":");
    const role = career.roles.filter((r) => r.id === parts[1])[0];
    if (!role || !role.bullets.some((b) => b.id === parts[2])) {
      warnings.push('An edit refers to a bullet that no longer exists ("' + parts[2] + '").');
    }
  });

  if (text.summary !== undefined && career.positioning[0]) {
    const safe = cleaned(text.summary);
    if (safe !== null) career.positioning.forEach((p) => (p.summary = safe));
  }
  if (text.positioning !== undefined && career.positioning[0]) {
    const safe = cleaned(text.positioning);
    if (safe !== null) career.positioning.forEach((p) => (p.tagline = safe));
  }

  return { career, warnings };
}
```

Add `origin?: "overlay"` and `edited?: boolean` to `ResumeBullet` in `lib/resume-render/render.d.ts`, with the comment: `Metadata for the coverage panel. renderBody ignores unknown fields.`

- [ ] **Step 5: Run the test and confirm it passes**

Run: `npx vitest run lib/effective-career.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 6: Commit**

```bash
git add lib/effective-career.ts lib/effective-career.test.ts lib/settings-store.ts lib/resume-render/render.d.ts
git commit -m "feat: one effective career record merging overlay and text overrides"
```

---

### Task 8: Wire the effective record and coverage into the tailor screen

**Files:**
- Modify: `app/actions/resume.ts` (`tailorResumeForJob`, `getTailoredResume`, a new `loadResumeContext`)
- Modify: `app/resume/page.tsx:10,93`
- Modify: `components/resume/TailorPanel.tsx`
- Modify: `components/resume/ResumeDocument.tsx`
- Create: `components/resume/CoveragePanel.tsx`

**Interfaces:**
- Consumes: `effectiveCareer` (Task 7), `coverageReport` (Task 2), `styleAttributeFor` (Task 4), `renderBody` opts (Task 6).
- Produces:

```ts
// app/actions/resume.ts
export interface ResumeOverrides {
  selection?: { lead?: string; positioning?: string; taper?: number[]; compressAfter?: number;
                bullets?: Record<string, string[]> };
  text?: Record<string, string>;
  design?: Record<string, string>;
  pageMargin?: string;
}
export async function loadResumeContext(jobId: string): Promise<{
  career?: CareerRecord; themes: string[]; selection: ResumeSelection | null;
  overrides: ResumeOverrides; coverage: CoverageReport | null;
  warnings: string[]; error?: string;
}>;
```

`tailorResumeForJob` returns the same shape plus its existing `unread`.

- [ ] **Step 1: Write the failing test**

Create `app/actions/resume-context.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { selectBullets } from "@/lib/resume-render/render";
import { effectiveCareer } from "@/lib/effective-career";
import { coverageReport } from "@/lib/resume-coverage";
import career from "@/lib/resume-render/content/resume.json";
import vocabulary from "@/lib/resume-render/content/themes.json";
import type { CareerRecord, ThemeVocabulary } from "@/lib/resume-render/render";

// The composition the action performs, asserted without a database: an overlay
// bullet must be visible to SCORING and to COVERAGE, which is exactly what
// breaks when the client renders the shipped record instead.
describe("resume context composition", () => {
  it("scores and counts an overlay bullet", () => {
    const { career: merged } = effectiveCareer(career as CareerRecord, [
      { id: "ov-1", roleId: "gtm-experts", text: "Built a thing", themes: ["systems"], priority: 2 },
    ], {});
    const selection = selectBullets(merged, { themes: ["systems"] });
    expect(selection.bullets["gtm-experts"]).toContain("ov-1");
    const report = coverageReport(merged, ["systems"], selection, vocabulary as ThemeVocabulary);
    expect(report.overlayBullets).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npx vitest run app/actions/resume-context.test.ts`
Expected: PASS if Tasks 2 and 7 are done — this test guards the composition rather than driving new code. If it FAILS, the overlay priority is being ignored by the taper; fix Task 7 before continuing.

- [ ] **Step 3: Add `loadResumeContext` to `app/actions/resume.ts`**

Add near `getTailoredResume`:

```ts
/**
 * Everything the tailor screen needs, resolved server-side against ONE record.
 *
 * The career record must not be imported statically by the page any more: an
 * overlay bullet or a text override the server scored would not exist in the
 * client's copy, and render.js:145-146 drops unknown ids silently and the whole
 * role when nothing survives.
 */
export async function loadResumeContext(jobId: string): Promise<{
  career?: CareerRecord;
  themes: string[];
  selection: ResumeSelection | null;
  overrides: ResumeOverrides;
  coverage: CoverageReport | null;
  warnings: string[];
  error?: string;
}> {
  const actor = await requireResumeAdmin();
  const rowsResult = await readAllSettingsResult();
  if (rowsResult.error !== undefined) {
    return { themes: [], selection: null, overrides: {}, coverage: null, warnings: [], error: rowsResult.error };
  }
  const overlay = careerOverlayFrom(rowsResult.rows);

  const stored = await getTailoredResume(jobId);
  if (stored.error !== undefined) {
    return { themes: [], selection: null, overrides: {}, coverage: null, warnings: [], error: stored.error };
  }

  const overrides = stored.overrides || {};
  const { career: merged, warnings } = effectiveCareer(
    career as CareerRecord,
    overlay,
    overrides.text || {}
  );
  const coverage = stored.selection
    ? coverageReport(merged, stored.themes, stored.selection, themeVocabulary as ThemeVocabulary)
    : null;

  return {
    career: merged,
    themes: stored.themes,
    selection: stored.selection,
    overrides,
    coverage,
    warnings,
  };
}
```

Extend `getTailoredResume` (`app/actions/resume.ts:202-203`) to return `overrides`, defaulting to `{}` when the stored `content` has no such key — a row written before this change is normal, never an error:

```ts
  const content = (data as {
    content: { themes: string[]; selection: ResumeSelection; overrides?: ResumeOverrides };
  }).content;
  return { themes: content.themes, selection: content.selection, overrides: content.overrides || {} };
```

In `tailorResumeForJob`, build the same merged record before `selectBullets`, and return a freshly computed `coverage`. Regenerate writes `content` with no `overrides` key — that is what "regenerate discards overrides" means.

- [ ] **Step 4: Stop the page importing the record, and pass the merged one**

In `app/resume/page.tsx`: delete the `import career from "@/lib/resume-render/content/resume.json"` line, call `loadResumeContext(jobId)` in the existing `Promise.all`, and pass `context.career`, `context.coverage`, `context.overrides` and `context.warnings` into `TailorPanel`. When `loadResumeContext` returns an error, render it in the existing `#92400E` paragraph and do not render the panel.

- [ ] **Step 5: Thread the root style and page margin through `ResumeDocument`**

Add two props and use them:

```tsx
export interface ResumeDocumentProps {
  career: CareerRecord;
  selection?: ResumeSelection;
  docPageRef?: React.RefObject<HTMLElement>;
  onEdit?: () => void;
  /** Validated declarations for the .rsm root — see lib/resume-design-tokens. */
  rootStyle?: string;
  /** Overrides <doc-page margin>. NOT captured on Save: it is an attribute on
   *  docPageEl itself, which is outside the innerHTML useResumeCapture reads,
   *  so a saved row carries it in its own column instead. */
  pageMargin?: string;
}
```

`const html = renderBody(career, selection, { rootStyle });` and `margin={pageMargin || "0.68in"}`.

- [ ] **Step 6: Create `components/resume/CoveragePanel.tsx`**

```tsx
"use client";

import type { CoverageReport } from "@/lib/resume-coverage";

const SUPPORT_LABEL: Record<string, string> = { strong: "strong", thin: "thin", absent: "no support" };

/**
 * What the document was built FROM. Always shown, never collapsed: it is the
 * only place the input is visible, and a collapsed panel leaves the screen as
 * opaque as it was without it. Numbers describe the RENDERED document only —
 * see lib/resume-coverage.ts for why the pool-wide figures are wrong here.
 */
export default function CoveragePanel({
  coverage,
  warnings,
}: {
  coverage: CoverageReport;
  warnings: string[];
}) {
  const pct = coverage.strength === null ? null : Math.round(coverage.strength * 100);
  return (
    <div className="rounded border border-slate p-3 text-xs print:hidden">
      <p className="font-medium uppercase tracking-wide text-ink/60">What this document was built from</p>
      <ul className="mt-2 space-y-1">
        {coverage.themes.map((t) => (
          <li key={t.theme} className={t.support === "absent" ? "text-[#92400E]" : "text-ink/80"}>
            <span className="font-medium">{t.theme}</span> — {SUPPORT_LABEL[t.support]} ·{" "}
            {t.pool} on the page, {t.selected} used
            {t.poolBeyondRendered > 0 && ` · ${t.poolBeyondRendered} more in compressed roles`}
          </li>
        ))}
      </ul>
      {coverage.gaps.length > 0 && (
        <p className="mt-2 text-[#92400E]">
          This posting asks for {coverage.gaps.join(", ")}, and the career record has nothing supporting{" "}
          {coverage.gaps.length === 1 ? "it" : "them"}.
        </p>
      )}
      {pct !== null && (
        <p className="mt-2 text-ink/60">
          {pct}% of the bullets on the page speak to what the posting asked for.
        </p>
      )}
      {(coverage.overlayBullets > 0 || coverage.editedBullets > 0) && (
        <p className="mt-2 text-ink/60">
          {coverage.overlayBullets > 0 && `${coverage.overlayBullets} added by you. `}
          {coverage.editedBullets > 0 && `${coverage.editedBullets} edited from the record.`}
        </p>
      )}
      {warnings.map((w) => (
        <p key={w} className="mt-2 text-[#92400E]">{w}</p>
      ))}
    </div>
  );
}
```

Render it in `TailorPanel` between the button row and `<ResumeDocument>`, only when `coverage` is non-null.

- [ ] **Step 7: Run the gate**

Run: `npm test && npm run build`
Expected: all pass. A type error about `career` possibly being undefined in `page.tsx` is the correct signal that the error branch is unhandled — handle it, do not cast.

- [ ] **Step 8: Commit**

```bash
git add app/actions/resume.ts app/actions/resume-context.test.ts app/resume/page.tsx \
        components/resume/TailorPanel.tsx components/resume/ResumeDocument.tsx \
        components/resume/CoveragePanel.tsx
git commit -m "feat: tailor screen renders the effective record and shows coverage"
```

---

### Task 9: `resume_chats` table

**Files:**
- Create: `db/migrations/019_resume_chats.sql`
- Modify: `lib/supabase.ts:127-151`
- Test: `lib/supabase.test.ts`

**Interfaces:**
- Produces: table `resume_chats`, and `"resume_chats"` in `TENANT_TABLES`.

- [ ] **Step 1: Write the failing test**

Append to `lib/supabase.test.ts`:

```ts
it("registers resume_chats as a tenant table", () => {
  expect(TENANT_TABLES).toContain("resume_chats");
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npx vitest run lib/supabase.test.ts`
Expected: FAIL.

- [ ] **Step 3: Write the migration**

Create `db/migrations/019_resume_chats.sql`:

```sql
-- db/migrations/019_resume_chats.sql
-- One chat thread per (tenant, job): the conversation that shaped this job's
-- tailored résumé. Working state on the DRAFT, so it is not covered by the
-- 60-day saved-résumé retention (lib/resume-retention.ts) — that window exists
-- for frozen documents in saved_resumes. It dies with the job via the cascade.
--
-- All six statements below are load-bearing. `force row level security` WITHOUT
-- `enable` only sets forcerowsecurity and is inert until rowsecurity is true,
-- so the pair ships a table with no row security at all; `enable` + `force`
-- with NO POLICY denies everything instead. Both failures are silent. This is
-- 015_tailored_resumes.sql:20-33 in full, deliberately.
--
-- tenant_id is declared INLINE, not via ALTER TABLE ... ADD COLUMN, so it is
-- invisible to lib/supabase.test.ts's retrofit regex and must be added to
-- TENANT_TABLES in lib/supabase.ts by hand.

create table if not exists resume_chats (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references users(id) on delete cascade,
  job_id     uuid not null references jobs(id) on delete cascade,
  messages   jsonb not null default '[]',
  updated_at timestamptz not null default now(),
  unique (tenant_id, job_id)
);

create index if not exists resume_chats_tenant_idx on resume_chats (tenant_id);

alter table resume_chats enable row level security;
alter table resume_chats force row level security;

drop policy if exists tenant_isolation on resume_chats;

create policy tenant_isolation on resume_chats
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

grant select, insert, update, delete on resume_chats to app_rw;
```

- [ ] **Step 4: Register the table**

In `lib/supabase.ts`, after the `saved_resumes` entry, add:

```ts
  // Added by migration 019. Same inline-tenant_id pattern as the two above, so
  // likewise invisible to lib/supabase.test.ts's retrofit regex.
  "resume_chats",
```

- [ ] **Step 5: Run the test and confirm it passes**

Run: `npx vitest run lib/supabase.test.ts`
Expected: PASS.

- [ ] **Step 6: Apply the migration to production**

```bash
railway run psql "$DATABASE_URL" -f db/migrations/019_resume_chats.sql
```

If `psql` is unavailable locally, use the `railway-cli` skill's documented path for running SQL against the Railway database. Verify:

```sql
select relrowsecurity, relforcerowsecurity from pg_class where relname = 'resume_chats';
select polname from pg_policy where polrelid = 'resume_chats'::regclass;
```
Expected: `t | t`, and one policy named `tenant_isolation`. **Do not skip this check** — the whole reason this migration is spelled out in full is that both halves fail silently.

- [ ] **Step 7: Commit**

```bash
git add db/migrations/019_resume_chats.sql lib/supabase.ts lib/supabase.test.ts
git commit -m "feat: resume_chats table with RLS, policy and tenant registration"
```

---

### Task 10: `lib/resume-ops.ts` — operation types and validation

**Files:**
- Create: `lib/resume-ops.ts`
- Test: `lib/resume-ops.test.ts`

**Interfaces:**
- Consumes: `sanitizeBulletText` (Task 3), `parseTokenValue` / `parsePageMargin` (Task 4), `ResumeOverrides` (Task 8), `CareerRecord`, `ThemeVocabulary`.
- Produces:

```ts
export interface Operation { op: string; [k: string]: unknown }
export const OPERATION_SCHEMA: Record<string, unknown>;
export function applyOperations(
  ops: Operation[], career: CareerRecord, selection: ResumeSelection,
  overrides: ResumeOverrides, vocabulary: ThemeVocabulary
): { overrides?: ResumeOverrides; themes?: string[]; overlayAdds?: OverlayBullet[];
     ruleRequests?: string[]; applied?: string[]; error?: string };
```

- [ ] **Step 1: Write the failing test**

Create `lib/resume-ops.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { applyOperations } from "@/lib/resume-ops";
import { selectBullets } from "@/lib/resume-render/render";
import career from "@/lib/resume-render/content/resume.json";
import vocabulary from "@/lib/resume-render/content/themes.json";
import type { CareerRecord, ThemeVocabulary } from "@/lib/resume-render/render";

const CAREER = career as CareerRecord;
const VOCAB = vocabulary as ThemeVocabulary;
const SELECTION = selectBullets(CAREER, { themes: ["systems"] });
const run = (ops: { op: string; [k: string]: unknown }[]) =>
  applyOperations(ops, CAREER, SELECTION, {}, VOCAB);

describe("applyOperations", () => {
  it("applies set_themes", () => {
    const res = run([{ op: "set_themes", themes: ["systems", "data"] }]);
    expect(res.themes).toEqual(["systems", "data"]);
    expect(res.error).toBeUndefined();
  });

  it("rejects a theme outside the vocabulary", () => {
    expect(run([{ op: "set_themes", themes: ["nonsense"] }]).error).toContain("nonsense");
  });

  it("rejects a bullet id outside the role's pool", () => {
    expect(run([{ op: "add_bullet", roleId: "principal", bulletId: "b-nope" }]).error).toContain("b-nope");
  });

  it("rejects a design token outside the allowlist", () => {
    expect(run([{ op: "set_design_token", name: "--page-width", value: "9in" }]).error).toBeDefined();
  });

  it("rejects a malformed token value", () => {
    expect(run([{ op: "set_design_token", name: "--rail", value: "1px } .rsm {" }]).error).toBeDefined();
  });

  it("rejects a text target not in the current selection", () => {
    const bullets = SELECTION.bullets["principal"];
    const notSelected = CAREER.roles
      .filter((r) => r.id === "principal")[0]
      .bullets.filter((b) => bullets.indexOf(b.id) === -1)[0];
    expect(run([{ op: "set_text", target: "bullet:principal:" + notSelected.id, text: "x" }]).error)
      .toContain("not on the page");
  });

  it("sanitizes accepted text", () => {
    const target = "bullet:principal:" + SELECTION.bullets["principal"][0];
    const res = run([{ op: "set_text", target, text: "<img src=x onerror=alert(1)>ok" }]);
    expect(res.overrides!.text![target]).not.toContain("<img");
  });

  // A turn is ATOMIC: a partially applied turn leaves the document, the
  // coverage panel and the persisted thread describing a state nobody asked for.
  it("applies nothing when any operation in the turn is invalid", () => {
    const res = run([
      { op: "set_themes", themes: ["systems"] },
      { op: "add_bullet", roleId: "principal", bulletId: "b-nope" },
    ]);
    expect(res.error).toBeDefined();
    expect(res.themes).toBeUndefined();
    expect(res.overrides).toBeUndefined();
  });

  it("collects a rule-change request without touching the document", () => {
    const res = run([{ op: "request_rule_change", description: "two-column header" }]);
    expect(res.ruleRequests).toEqual(["two-column header"]);
    expect(res.overrides).toEqual({});
  });

  it("namespaces a proposed career bullet id", () => {
    const res = run([{ op: "propose_career_bullet", roleId: "principal", text: "Did a thing", themes: ["systems"] }]);
    expect(res.overlayAdds![0].id.indexOf("ov-")).toBe(0);
  });

  it("rejects an unknown operation name", () => {
    expect(run([{ op: "delete_everything" }]).error).toContain("delete_everything");
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npx vitest run lib/resume-ops.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `lib/resume-ops.ts`**

Write the module so that:
- It validates ALL operations first, collecting the first error, and returns `{ error }` with no other field set when any fails. Only after every operation validates does it build and return the new `overrides` / `themes` / `overlayAdds` / `ruleRequests` / `applied`.
- `applied` is a human-readable line per operation, for the chat transcript ("set themes: systems, data").
- `set_themes` checks each id against `vocabulary.themes`.
- `add_bullet` / `drop_bullet` / `swap_bullet` / `set_lead` check `roleId` against `career.roles` and each bullet id against that role's `bullets`.
- `set_positioning` checks against `career.positioning`.
- `set_taper` requires an array of non-negative integers; `set_compress_after` a non-negative integer no greater than `career.roles.length`.
- `set_text` requires the target to name a bullet **in the current selection** (`selection.bullets[roleId]`), or be `summary` / `positioning`; the value goes through `sanitizeBulletText` and its error is returned verbatim.
- `propose_career_bullet` validates `roleId` and `themes`, runs the text through `sanitizeBulletText`, and assigns `id = "ov-" + <random 8 hex chars>`.
- `set_design_token` goes through `parseTokenValue`; `set_page_margin` through `parsePageMargin`; `reset_design` clears `overrides.design` and `overrides.pageMargin`.
- `request_rule_change` requires a non-empty string and touches nothing else.
- An unrecognised `op` is an error naming it.

Also export `OPERATION_SCHEMA` — a JSON Schema for `{ reply: string, operations: [{ op: string, ...optional fields }] }`. Use ONE flat object with `op` plus every optional field (`themes`, `roleId`, `bulletId`, `outId`, `inId`, `target`, `text`, `name`, `value`, `taper`, `n`, `positioningId`, `description`), not a 13-branch `anyOf`: the schema is passed straight through as the tool's `input_schema` (`lib/providers/anthropic.ts:85`), the server validates the union regardless, and a large nested union there has real behavioural cost. Document that choice in the export's comment.

- [ ] **Step 4: Run the test and confirm it passes**

Run: `npx vitest run lib/resume-ops.test.ts`
Expected: PASS (11 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/resume-ops.ts lib/resume-ops.test.ts
git commit -m "feat: validate and atomically apply resume chat operations"
```

---

### Task 11: `lib/resume-chat-prompt.ts` — the prompt, fixture-pinned

**Files:**
- Create: `lib/resume-chat-prompt.ts`
- Create: `lib/__fixtures__/resume-chat-prompt.txt`
- Test: `lib/resume-chat-prompt.test.ts`

**Interfaces:**
- Produces:

```ts
export interface ChatMessage { role: "user" | "assistant"; text: string }
export function buildChatPrompt(input: {
  career: CareerRecord; themes: string[]; selection: ResumeSelection;
  overrides: ResumeOverrides; coverage: CoverageReport;
  requirements: string[]; niceToHaves: string[];
  roleTitle: string; company: string; messages: ChatMessage[];
}): { system: string; prompt: string };
```

- [ ] **Step 1: Write the failing test**

Create `lib/resume-chat-prompt.test.ts` asserting: the system prompt names every operation in the catalogue; it lists the allowlisted design tokens and no others; it states that a bullet must be proposed rather than invented and that CSS rules are refused; the user prompt carries the posting's requirements and nice-to-haves as labelled lines and OMITS the label entirely when a list is empty (the `optionalList` convention in `lib/resume-prompt.ts:32-35`); the transcript renders in order with roles labelled; and the whole rendered pair matches `lib/__fixtures__/resume-chat-prompt.txt` byte-for-byte.

Follow `lib/resume-prompt.test.ts` for the fixture-comparison idiom already used in this repo.

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npx vitest run lib/resume-chat-prompt.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the builder**

Mirror `lib/resume-prompt.ts`'s conventions exactly: `optionalLine` / `optionalList` helpers, a missing field omits its whole line rather than rendering an empty label. The system prompt carries the theme vocabulary; the bullet index (role id, bullet id, themes, and the first ~80 characters of text — ids and text, never the full record); the current selection; the current overrides; the rendered coverage report; the operation catalogue; and the invariant in this repo's words:

> You may reorder and retune the document freely. You may not invent a bullet — propose it and let the user accept it. You may not write CSS rules; if a change needs one, say so with request_rule_change.

The user prompt carries the role title, company, requirements, nice-to-haves, and the transcript.

- [ ] **Step 4: Generate the fixture and READ IT**

Write it from the builder, then read the whole file before staging. A fixture is a claim about what the model is told; generating one without reading it blesses whatever the code emits.

- [ ] **Step 5: Run the test and confirm it passes**

Run: `npx vitest run lib/resume-chat-prompt.test.ts`

- [ ] **Step 6: Commit**

```bash
git add lib/resume-chat-prompt.ts lib/resume-chat-prompt.test.ts lib/__fixtures__/resume-chat-prompt.txt
git commit -m "feat: fixture-pinned prompt builder for the resume chat"
```

---

### Task 12: `app/actions/resume-chat.ts` — the turn

**Files:**
- Create: `app/actions/resume-chat.ts`
- Test: `app/actions/resume-chat.test.ts`

**Interfaces:**
- Consumes: `requireResumeAdmin`, `withBudget`, `complete` from `lib/model-call.ts`, `parseJson`, `applyOperations` (Task 10), `buildChatPrompt` (Task 11), `loadResumeContext` (Task 8), `writeCareerOverlay` (Task 7).
- Produces:

```ts
export async function sendChatTurn(jobId: string, message: string): Promise<{
  reply: string; applied: string[]; rejected?: string;
  selection: ResumeSelection | null; overrides: ResumeOverrides;
  coverage: CoverageReport | null; messages: ChatMessage[]; error?: string;
}>;
export async function loadChatThread(jobId: string): Promise<{ messages: ChatMessage[]; error?: string }>;
export async function acceptProposedBullets(jobId: string, ids: string[]): Promise<{ error?: string }>;
```

- [ ] **Step 1: Write the failing test**

Create `app/actions/resume-chat.test.ts`. Because the action needs a database and a model, test the pure decision points by extracting them: assert that a `stopReason` indicating truncation produces a refusal rather than an applied turn, and that a model response whose `operations` fail validation returns `rejected` with the reason and an unchanged selection. Structure it the way `app/actions/resume-model-failure.test.ts` already does for `deriveThemes`.

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npx vitest run app/actions/resume-chat.test.ts`

- [ ] **Step 3: Implement the action**

Required properties, each of which has a named reason:

```ts
"use server";
// Every export here is an RPC endpoint reachable by id from the client bundle.
```

- `requireResumeAdmin()` FIRST, in every export.
- The model call is `complete({ system, prompt, maxTokens: 2000, jsonSchema: OPERATION_SCHEMA })` — **not `callStructured`**, which despite its name forwards to `complete()` with no schema (`lib/model-call.ts:134-139`) and would give free-form prose.
- Check `stopReason` for truncation before parsing. The forced-tool path returns `JSON.stringify(toolBlock.input)` (`lib/providers/anthropic.ts:96-104`), so a response cut at `max_tokens` parses into a valid-looking object with operations missing. A truncated turn is REFUSED with "That answer was cut short — try asking for one change at a time", never partially applied.
- Wrap the call in `withBudget({ action: "resume-chat", estimateCents: 3, isAdmin: actor.isAdmin, fn })`. `lib/metered.ts:83-100` reserves once per call and nested calls short-circuit, so one turn is one reservation.
- Apply operations through `applyOperations`. On `error`, persist the user message and the assistant reply, return `rejected`, and change nothing else.
- `propose_career_bullet` results are returned to the client as pending proposals and are written to the overlay ONLY by `acceptProposedBullets`, which the user triggers explicitly.
- Write the updated `content` to `tailored_resumes` and the appended messages to `resume_chats`, both through the `forTenant` builder.
- Every database result goes through `describeWriteFailure` and is detected by `!== undefined`. Model and parse failures get their own sentence at the catch — `UNDESCRIBED_DB_ERROR` names the database and would be false there.
- Recompute and return `coverage` from the new selection; never store it.

- [ ] **Step 4: Run the test and confirm it passes**

Run: `npx vitest run app/actions/resume-chat.test.ts`

- [ ] **Step 5: Confirm the auth guard test covers the new exports**

Run: `npx vitest run app/actions/auth-required.test.ts`
Expected: PASS. That test imports every file in `app/actions/` and calls every export; a new export that does not refuse a session-less call fails here. If it fails, fix the action — never the test's exemption list.

- [ ] **Step 6: Commit**

```bash
git add app/actions/resume-chat.ts app/actions/resume-chat.test.ts
git commit -m "feat: one billed, validated, atomic resume chat turn"
```

---

### Task 13: `components/resume/ChatPanel.tsx`

**Files:**
- Create: `components/resume/ChatPanel.tsx`
- Modify: `components/resume/TailorPanel.tsx`

**Interfaces:**
- Consumes: `sendChatTurn`, `loadChatThread`, `acceptProposedBullets` (Task 12).
- Produces: a panel rendered inside `TailorPanel`, below `CoveragePanel`.

- [ ] **Step 1: Build the panel**

Requirements, each with its reason:

- Lives under `components/` — `tailwind.config.ts` scans `./app/**` and `./components/**` only, so an arbitrary-value class defined in `lib/` is never generated.
- `print:hidden` on the outer element. App chrome, not document: Tailwind and the existing `ink`/`slate`/`canvas` palette, NOT the résumé design tokens, which are scoped to `.rsm` and describe a printed page.
- Each assistant turn renders its prose and, beneath it, `applied` as a plain list, or `rejected` as one `#92400E` line.
- Errors use presence: `if (res.error !== undefined) setError(res.error || UNDESCRIBED_DB_ERROR)`, matching `TailorPanel.tsx:63`.
- A proposed career bullet renders with an explicit Accept button wired to `acceptProposedBullets`. Nothing reaches the overlay without that click.

- [ ] **Step 2: Add the dirty guard — the part that is easy to get wrong**

Before sending a turn, if `dirty` is set, confirm:

```tsx
// A chat turn re-renders the document from state, and ResumeDocument.tsx:68-73
// is explicit that re-setting dangerouslySetInnerHTML discards unsaved edits.
// `dirty`'s only consumers are the beforeunload handler and the Regenerate
// confirm (TailorPanel.tsx:45-53,104-106) — NEITHER fires for a chat turn, so
// without this the user's hand edits vanish with no message, and setting
// dirty=true afterwards would actively mislead.
if (dirty && !window.confirm("You have unsaved edits to this document. Apply this change and discard them?")) return;
```

After a turn that changed the document, call `onApplied()` so `TailorPanel` sets `selection`, `overrides` and `dirty`. A turn that changes nothing — a question — must not prompt and must not set `dirty`.

- [ ] **Step 3: Widen the Regenerate confirm**

In `TailorPanel.tsx:104-106`, change the non-dirty message to:

```
"Regenerate this resume? It re-derives themes from the posting and discards every change made in the chat — bullet choices, text edits and design changes."
```

- [ ] **Step 4: Run the gate**

Run: `npm test && npm run build`

- [ ] **Step 5: Verify by hand against the running app**

```bash
npm run dev
```

Open a tailored role and check, in order: a question changes nothing and does not prompt; "lead with the systems work" reorders and the coverage panel's numbers move; hand-edit a bullet then send a turn and confirm the warning appears; a design change ("tighten the rail") visibly moves the layout; Save, reopen the saved résumé, and confirm the design change survived.

- [ ] **Step 6: Commit**

```bash
git add components/resume/ChatPanel.tsx components/resume/TailorPanel.tsx
git commit -m "feat: chat panel on the tailor screen"
```

---

### Task 14: Page margin survives Save

**Files:**
- Create: `db/migrations/020_saved_resume_page_margin.sql`
- Modify: `app/actions/saved-resumes.ts`, `components/resume/SavedResumePanel.tsx`
- Test: `app/actions/saved-resumes.test.ts`

- [ ] **Step 1: Write the migration**

```sql
-- db/migrations/020_saved_resume_page_margin.sql
-- The page margin is the `margin` attribute on <doc-page>
-- (components/resume/ResumeDocument.tsx:76), which lives OUTSIDE the
-- docPageEl.innerHTML that useResumeCapture serializes — so unlike the design
-- token overrides, which ride along on the .rsm root, it is not captured and
-- must be stored on the row. A margin that looks right in the draft and
-- silently reverts in the archive would only be found by comparing two screens.
--
-- An ALTER on an existing table inherits its RLS and its app_rw grant:
-- migration 009's column-list revoke is users-only, and a table-level grant
-- covers columns added later (012_watchlist_signal.sql records this). So no
-- new policy and no new grant. A null reads as the 0.68in default, which is
-- every row written before today.

alter table saved_resumes add column if not exists page_margin text;
```

- [ ] **Step 2: Write the failing test**

Assert `saveResume` persists `pageMargin` and `listSavedResumes` returns it, and that a row with a null `page_margin` reads back as the default rather than as `""`.

- [ ] **Step 3: Run it and confirm it fails, then implement**

Add `pageMargin` to `saveResume`'s input and the insert, select it on both reads, and pass it to `<doc-page margin=…>` on the saved screen. Keep `DESIGN_VERSION` untouched: the token overrides are frozen into the row's HTML and are immune to a token-file change by construction, so the stamp still means what it meant.

- [ ] **Step 4: Apply the migration to production**

```bash
railway run psql "$DATABASE_URL" -f db/migrations/020_saved_resume_page_margin.sql
```

- [ ] **Step 5: Run the gate and commit**

```bash
npm test && npm run build
git add db/migrations/020_saved_resume_page_margin.sql app/actions/saved-resumes.ts \
        app/actions/saved-resumes.test.ts components/resume/SavedResumePanel.tsx
git commit -m "feat: a saved resume keeps its page margin"
```

---

### Task 15: Documentation and deploy

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Add a résumé-chat paragraph to CLAUDE.md**

Place it after the saved-résumés paragraph. It must record the facts a future session would otherwise re-derive:

- `effectiveCareer()` is the one record; the page must NOT import `content/resume.json` for rendering, because the client renderer drops unknown ids silently (`render.js:145-146`).
- Authored text goes through `sanitizeBulletText` at three boundaries, because `render.js:155` does not escape and `ResumeDocument.tsx:80` is `dangerouslySetInnerHTML` on the client.
- `allowedStyles.div` is not optional in `lib/resume-sanitize.ts`; without it `allowedAttributes.div: ["style"]` permits arbitrary inline CSS on every div.
- Design token overrides ride on `.rsm` (captured); the page margin is a `<doc-page>` attribute (not captured) and has its own column.
- `render.js` now carries two dated divergences from the vendored source — the ordering rule and `rootStyle` — which a re-sync would revert.
- The chat uses `complete({ jsonSchema })`; `callStructured` takes no schema despite its name.
- Coverage is computed per request against the RENDERED roles and never stored.

- [ ] **Step 2: Update the spec's status line**

Add one line at the top of `docs/superpowers/specs/2026-09-07-resume-chat-design.md`: **Implemented 2026-…, see `docs/superpowers/plans/2026-09-07-resume-chat.md`.**

- [ ] **Step 3: Run the full gate**

Run: `npm run build && npm test`

- [ ] **Step 4: Deploy and verify against the deployed commit**

```bash
git push origin main
railway deployment list --service web --limit 1 --json
```

Compare `meta.commitHash` to `git rev-parse origin/main` before believing any check against the live site. Then confirm both migrations are applied in production — `resume_chats` exists with `relrowsecurity` and `relforcerowsecurity` true and one `tenant_isolation` policy, and `saved_resumes.page_margin` exists.

- [ ] **Step 5: Commit**

```bash
git add CLAUDE.md docs/superpowers/specs/2026-09-07-resume-chat-design.md
git commit -m "docs: record the resume chat's invariants in CLAUDE.md"
```

---

## Self-Review Notes

**Spec coverage.** §0 effective record → Task 7, wired in Task 8. §1 ordering → Task 1. §2 coverage → Tasks 2 and 8. §3 operations → Task 10; authored text → Task 3; overlay → Task 7 (store) and Task 12 (accept); design tokens → Tasks 4, 5, 6; model call → Tasks 11 and 12; persistence → Task 9; server-action contract → Task 12 step 5; the panel and the dirty guard → Task 13; page margin → Task 14. `request_rule_change` is validated in Task 10 and surfaced in Task 13.

**Known judgement calls the executor may need to revisit.** Task 3's ampersand assertion depends on `sanitize-html`'s entity handling and has an explicit fallback; the security assertions in that test do not. Task 8's step 2 expects a PASS rather than a FAIL — it guards a composition rather than driving new code, and that is called out in the step.
