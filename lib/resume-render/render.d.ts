// Type declarations for render.js, ported verbatim from the "TK Resume Design
// System" Claude Design project (999f7fe8-e8bc-449f-9121-0f2d8dc9730c).
// render.js itself is untouched pure JS — see its own header comment.

export interface ContactItem {
  label: string;
  href?: string;
}

export interface ResumeBullet {
  id: string;
  priority: number;
  themes: string[];
  /** May contain a literal <strong>...</strong> span around one figure. */
  text: string;
}

export interface ResumeRole {
  id: string;
  title: string;
  org: string;
  scope?: string;
  acquired?: string;
  dates: string;
  accounts?: string[];
  bullets: ResumeBullet[];
}

export interface ResumeRow {
  main: string;
  scope?: string;
  dates?: string;
}

export interface PositioningVariant {
  id: string;
  themes: string[];
  tagline: string;
  summary: string;
}

export interface CareerRules {
  taper: number[];
  themes: string[];
  compressAfter: number | null;
  notes?: string;
}

export interface CareerRecord {
  identity: { name: string; contacts: ContactItem[] };
  positioning: PositioningVariant[];
  roles: ResumeRole[];
  compressed?: ResumeRow[];
  advisory: ResumeRow[];
  education: ResumeRow[];
  rules: CareerRules;
}

export interface ThemeDefinition {
  id: string;
  label: string;
  covers: string;
  jdSignals: string[];
  evidence: string;
}

export interface ThemeVocabulary {
  themes: ThemeDefinition[];
  derivation: { method: string; examples: unknown[] };
  knownGaps: { note: string; absent: string[] };
  evidenceNote: string;
}

export interface ResumeSelection {
  positioningId: string | null;
  bullets: Record<string, string[]>;
}

export interface SelectBulletsOptions {
  /** Most important first. */
  themes?: string[];
  /** Defaults to career.rules.taper. */
  taper?: number[];
  /** Forces a positioning id; otherwise the best theme match wins. */
  positioning?: string;
  /** Bullet id forced into first position on the first role. */
  lead?: string;
}

export interface RenderResumeOptions {
  /** Prefixes styles.css / doc-page.js / page-guides.js. Defaults to "." */
  base?: string;
  margin?: string;
  /** Defaults to true. */
  pageGuides?: boolean;
}

export interface CoverageThemeReport {
  theme: string;
  pool: number;
  selected: number;
  roles: string[];
  support: "strong" | "thin" | "absent";
}

export interface CoverageReport {
  themes: CoverageThemeReport[];
  gaps: string[];
  unknown: string[];
  strength: number | null;
}

export function selectBullets(
  career: CareerRecord,
  opts?: SelectBulletsOptions
): ResumeSelection;

/** Just the `.rsm` div — for embedding in a page you already own. */
export function renderBody(
  career: CareerRecord,
  selection?: ResumeSelection
): string;

/** A complete, print-ready HTML document. */
export function renderResume(
  career: CareerRecord,
  selection?: ResumeSelection,
  opts?: RenderResumeOptions
): string;

export function coverage(
  career: CareerRecord,
  requestedThemes: string[],
  selection: ResumeSelection | null,
  vocabulary: ThemeVocabulary
): CoverageReport;
