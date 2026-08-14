// Which jobs rescoreAll re-scores, how many at a time, and what it feeds the
// model about each one.
//
// Lives in lib/ rather than inline in app/actions/settings.ts for the same
// reason STALE_POSTING_CANDIDATES_SQL and CRITERIA_CHANGED_AT_SQL do: this
// encodes decisions that are expensive to get wrong and impossible to test
// through the action, which reads the database and calls Claude.

// `import type` of a value, used only through `typeof` below. Fully erased at
// compile time, so this does NOT pull the Anthropic SDK into the test process.
import type { scoreFit } from "@/app/actions/parse-role";

/** One row of SCORED_JOBS_SQL. Field names are the column names. */
export interface ScoredJobRow {
  id: string;
  company: string;
  role_title: string;
  company_description: string | null;
  department: string | null;
  location: string | null;
  key_skills: string | null;
  fit_summary: string | null;
  arr: string | null;
  exit_signal: string | null;
  backer: string | null;
}

/**
 * The fields `scoreFit` reads off each row, and therefore the fields both
 * SCORED_JOBS_SQL must select AND `scoringArgsFor` must forward.
 *
 * Stating the contract once, as data, is what lets a test check the query and
 * the mapping against the same list instead of against copies of themselves.
 */
export const SCORING_INPUT_COLUMNS = [
  "company",
  "role_title",
  "company_description",
  "department",
  "location",
  "key_skills",
  "fit_summary",
  "arr",
  "exit_signal",
  "backer",
] as const;

// The one definition of "has already been scored". Three queries below need
// it; three hand-written copies would eventually disagree.
const SCORED = `fit_score is not null`;

/**
 * A bounded batch of already-scored jobs, oldest-touched first.
 *
 * Three load-bearing properties, all pinned by lib/rescore-scope.test.ts:
 *
 * 1. `fit_score is not null` — NOT the query builder. `.neq("fit_score", null)`
 *    renders `"fit_score" <> $1` with `$1 = null`, which is never true in
 *    Postgres: it matches zero rows and reports success, so the rescore
 *    silently does nothing and says it worked.
 *
 * 2. `limit $1`. One scoreFit call per row at roughly $0.0076 and a couple of
 *    seconds each: 500 rows is ~$3.80 and ~30 minutes of sequential wall
 *    clock, well past any request timeout. The loop would die mid-way, the
 *    return value would be lost, and nothing would tell the user how many rows
 *    landed. Same reason the cron crawl clamps to 10 companies per call.
 *
 * 3. `order by updated_at asc nulls first` is what makes a second call make
 *    progress. Rescoring is idempotent on the row set — `fit_score` stays
 *    non-null — so an unordered batch would re-score the same rows forever.
 *    updateJob stamps `updated_at`, which sends finished rows to the back of
 *    the queue.
 */
export const SCORED_JOBS_SQL = `select id, company, role_title, company_description, department, location,
            key_skills, fit_summary, arr, exit_signal, backer
       from jobs
      where ${SCORED}
      order by updated_at asc nulls first
      limit $1`;

/** Every scored job, for the "this is what a rescore will cost" figure. */
export const SCORED_JOBS_COUNT_SQL = `select count(*) n from jobs where ${SCORED}`;

/**
 * Scored jobs this pass has not finished yet: everything still carrying an
 * `updated_at` from before the pass began ($1).
 *
 * $1 is the start of the WHOLE PASS, not of the current batch — see
 * `passStartFrom` below for why that distinction is the difference between a
 * loop that terminates and one that bills forever.
 *
 * A row that failed to score keeps its old timestamp and so stays counted,
 * which is the honest answer — it still needs doing. It also means `remaining`
 * alone is not a drain condition: a caller looping until zero would spin on a
 * permanently failing row. Stop when a batch reports `rescored === 0`.
 */
export const SCORED_JOBS_REMAINING_SQL = `select count(*) n from jobs
      where ${SCORED}
        and (updated_at is null or updated_at < $1)`;

export const DEFAULT_RESCORE_LIMIT = 25;
export const MAX_RESCORE_LIMIT = 100;

/**
 * The timestamp SCORED_JOBS_REMAINING_SQL counts against: the moment the PASS
 * began, carried forward from the first batch, not a fresh `now()` per batch.
 *
 * This is the whole fix for a defect that only exists across batches. With a
 * per-batch timestamp, every row batch 1 finished carries an `updated_at`
 * older than batch 2's start, so batch 2 counts batch 1's completed work as
 * still remaining. `remaining` then never reaches zero, the client loop keeps
 * paying for full extra passes (26 scored rows billed 75 scoreFit calls, then
 * still reported work left), and the "pass finished" branch never fires. The
 * server log reads plausibly the whole time, so nothing flags it.
 *
 * The FIRST batch has no candidate and takes the server's clock; later batches
 * receive that value back through the client. An unparseable or missing
 * candidate falls back to `fallback` rather than reaching Postgres, where an
 * invalid timestamp literal would error the count and silently stop the loop.
 * Normalizing through `toISOString` also means only one format is ever bound.
 */
export function passStartFrom(
  candidate: string | undefined,
  fallback: Date = new Date()
): string {
  if (typeof candidate === "string" && Number.isFinite(Date.parse(candidate))) {
    return new Date(candidate).toISOString();
  }
  return fallback.toISOString();
}

/**
 * How many rows one rescore call may touch.
 *
 * Clamped rather than trusted: the limit arrives from a client component, and
 * the whole point of the bound is that no single call can run away. A missing
 * or unusable value takes the default instead of erroring — the caller asked
 * for a rescore, and refusing one over a bad number helps nobody.
 */
export function clampRescoreLimit(n?: number | null): number {
  if (typeof n !== "number" || !Number.isFinite(n)) return DEFAULT_RESCORE_LIMIT;
  const whole = Math.floor(n);
  if (whole < 1) return 1;
  return Math.min(whole, MAX_RESCORE_LIMIT);
}

/**
 * Everything `scoreFit` is told about a row, derived from `scoreFit`'s own
 * parameter type.
 *
 * `Omit<…, "fitInputs">` is not decoration: it means a new REQUIRED input on
 * scoreFit breaks the build here, which is the direction a hand-maintained
 * column list cannot cover.
 */
export type ScoringArgs = Omit<Parameters<typeof scoreFit>[0], "fitInputs">;

/**
 * Maps a database row onto scoreFit's arguments.
 *
 * Extracted from the action for one specific reason: `arr`, `exit_signal`, and
 * `backer` are OPTIONAL on scoreFit's opts, so deleting those three lines from
 * an inline object literal compiles clean and passes every test — while
 * silently rescoring blind. A role scored 4 on "$380M+ ARR, PE exit planned"
 * loses the entire FINANCIAL SIGNALS block and drops. Out here, the test that
 * walks SCORING_INPUT_COLUMNS catches the deletion.
 *
 * Nulls become "" (required fields) or undefined (optional ones) so scoreFit
 * renders "unknown" rather than the literal string "null".
 */
export function scoringArgsFor(row: ScoredJobRow): ScoringArgs {
  return {
    company: row.company,
    role_title: row.role_title,
    company_description: row.company_description ?? "",
    department: row.department ?? "",
    location: row.location ?? "",
    key_skills: row.key_skills ?? "",
    fit_summary: row.fit_summary ?? "",
    arr: row.arr ?? undefined,
    exit_signal: row.exit_signal ?? undefined,
    backer: row.backer ?? undefined,
  };
}

// One row's fate in a rescore batch. Named rather than counted inline because
// the batch runs concurrently (Promise.all): tallying inside the callbacks
// would mean several closures incrementing shared counters, which is the
// classic way accounting quietly breaks when a serial loop is parallelized.
// Each callback returns one of these; the tally happens once, afterward.
export type RescoreOutcome = "rescored" | "score-failed" | "write-failed";

export interface RescoreTally {
  rescored: number;
  scoreFailures: number;
  writeFailures: number;
}

export function tallyRescoreOutcomes(outcomes: RescoreOutcome[]): RescoreTally {
  const tally: RescoreTally = { rescored: 0, scoreFailures: 0, writeFailures: 0 };
  for (const o of outcomes) {
    if (o === "rescored") tally.rescored++;
    else if (o === "score-failed") tally.scoreFailures++;
    else tally.writeFailures++;
  }
  return tally;
}
