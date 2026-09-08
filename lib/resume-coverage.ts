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
