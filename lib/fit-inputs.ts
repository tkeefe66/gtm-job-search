/**
 * The scoring inputs a fit score is computed from — the deliberately narrow
 * slice of settings that `scoreFit` needs, kept apart from the full `Criteria`
 * object so batch callers can hand it down without carrying (and without
 * re-widening on) everything else.
 *
 * It lives in its own module rather than in lib/search-criteria.ts so that
 * search-criteria can import the type while producing the value
 * (`loadScoringInputs`) without an import cycle.
 */
export interface FitInputs {
  fitBrain: string;
  // The companion compensation plan adds `compFloor: number | null` here.
  // Nothing else changes when it does — that is the point of this indirection.
}
