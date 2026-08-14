// Which jobs rescoreAll re-scores, and what it feeds the model about them.
//
// Lives in lib/ rather than inline in app/actions/settings.ts for the same
// reason STALE_POSTING_CANDIDATES_SQL and CRITERIA_CHANGED_AT_SQL do: the
// query encodes two decisions that are expensive to get wrong and impossible
// to test through the action, which reads the database and calls Claude.

/**
 * Every job that already carries a score, with every field `scoreFit` reads.
 *
 * Two load-bearing properties, both pinned by lib/rescore-scope.test.ts:
 *
 * 1. `fit_score is not null` — NOT the query builder. `.neq("fit_score", null)`
 *    renders `"fit_score" <> $1` with `$1 = null`, which is never true in
 *    Postgres: it matches zero rows and reports success, so the rescore
 *    silently does nothing and says it worked.
 *
 * 2. The column list is the whole prompt input. `scoreFit` weights
 *    `company_description`, `arr`, `exit_signal`, and `backer` explicitly (the
 *    FINANCIAL SIGNALS block in app/actions/parse-role.ts), and `fit_summary`
 *    is the posting summary it reasons from. Dropping any of them does not
 *    merely fail to improve a score — it ACTIVELY DEGRADES it: a role scored 4
 *    on "$380M+ ARR, PE exit planned" gets rescored blind and drops.
 */
export const SCORED_JOBS_SQL = `select id, company, role_title, company_description, department, location,
            key_skills, fit_summary, arr, exit_signal, backer
       from jobs
      where fit_score is not null`;

/**
 * The fields `scoreFit` reads off each row, and therefore the fields
 * SCORED_JOBS_SQL must select. Kept beside the query so the test compares the
 * query against a stated contract rather than against a copy of itself.
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
