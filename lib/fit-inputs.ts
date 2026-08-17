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
  /**
   * The minimum base compensation the user will consider, or null when no
   * floor is set. Lives HERE rather than as another parameter on `scoreFit`
   * for the reason this interface exists: every batch caller already threads
   * a FitInputs through, so the floor reached scoring without reopening
   * `scoreFit`'s signature or `ingestRoles`'s options — exactly the "nothing
   * else changes" this comment used to promise.
   *
   * A scoring input ONLY. It must never reach `buildExtractionPrompt` or any
   * other crawl-time prompt: filtering roles out at ingest time is what the
   * spec forbids, and the promise is that a below-floor role scores low
   * rather than disappearing.
   *
   * `null` and `0` both mean "no floor" — see `compFloorLine` in
   * lib/fit-prompt.ts and `saveCompFloor` in app/actions/settings.ts, which
   * rejects 0 for the same reason.
   */
  compFloor: number | null;
  /**
   * The tails of the 2/3/4 clauses in the fit prompt's scoring guide — what
   * "weak", "moderate" and "strong" actually mean for this career.
   *
   * Three fields rather than one because they splice at three distinct
   * positions inside one template literal; a single string cannot reach all
   * three. The 1 and 5 clauses are not here: they are career-neutral as
   * written ("wrong industry, no relevant overlap" / "almost tailor-made").
   *
   * CONTRACTUALLY NON-EMPTY. An empty tail renders `2 = Weak fit — ` with a
   * trailing space, which is the same dangling-fragment defect the block
   * helpers in lib/fit-prompt.ts exist to prevent — and it is invisible to the
   * doubled-blank-line guard, because a trailing space is not a blank line.
   */
  weakFitTail: string;
  moderateTail: string;
  strongTail: string;
}
