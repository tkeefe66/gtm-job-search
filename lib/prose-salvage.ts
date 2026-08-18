// Recovering a search-tier response that came back as prose instead of JSON.
//
// THE FAILURE THIS EXISTS FOR (2026-08-18, adobe). The crawler's search tier
// asks for JSON and its no-results branch asks for a SENTENCE inside JSON:
// `{"roles": [], "message": "explanation"}` (lib/company-role-prompt.ts). The
// model wrote the sentence and skipped the wrapper — "I found a ..." — so
// parseJson found no `[` and no `{` anywhere and threw, crawlCompany's catch
// scored the run status "error", and `failed` in the watchlist update stamped
// failing_since. Seven days and two failures of that and lib/dead-tracking.ts
// sets tracking_enabled = false. A formatting slip was being scored exactly
// like a dead careers page. The same company had returned a correct `empty`
// 27 hours earlier on the identical prompt, so this is nondeterministic
// instruction compliance, not a broken prompt — it will recur.
//
// WHY NOT JUST CALL IT "empty". That was the obvious fix and it is wrong.
// `status = "empty"` is not merely "no failure", it is TRUSTED EVIDENCE that
// the company currently lists nothing: LAST_TRUSTWORTHY_RUN_SQL selects
// `status in ('ok', 'empty')`, and closeStalePostings closes any role absent
// from an 'empty' run. Mapping unparseable prose to 'empty' would let a
// formatting glitch close live jobs — a strictly worse bug than the one being
// fixed, and a silent one.
//
// WHAT THIS DOES INSTEAD. Re-read the model's own words under constrained
// decoding (a forced tool call — see CompleteOpts.jsonSchema), which is
// structurally incapable of returning prose. Whatever the model actually said,
// "no roles" or a list of them, comes back in the shape the pipeline expects
// and flows through the normal path. No new CrawlStatus, no new trust rule.

/**
 * Anthropic's stop_reason for "I hit max_tokens mid-sentence". Named rather
 * than inlined because the whole safety property below turns on this one
 * comparison.
 */
export const TRUNCATION_STOP_REASON = "max_tokens";

export type SalvageDecision = "salvage" | "fail";

/**
 * Whether an unparseable response is worth re-reading, given how the model
 * stopped.
 *
 * TRUNCATION IS THE CASE THAT MUST FAIL. A response cut off at max_tokens is
 * incomplete narration: the roles it was about to list may never have been
 * emitted. Re-reading it under constrained decoding would produce a confident
 * `{"roles": []}` from a sentence that was still mid-thought, and that empty
 * answer is trusted as closure evidence downstream. So truncation keeps the
 * old behaviour — throw, score the run "error" — which is correct for it: a
 * truncated run genuinely did fail, and a raised maxTokens is the real fix.
 *
 * Everything else salvages, INCLUDING an absent stop_reason. A provider that
 * does not report one must not have every prose response scored as a dead
 * page; the salvage call is cheap and its worst case is an empty result from
 * an honest re-read.
 */
export function salvageDecisionFor(stopReason: string | null): SalvageDecision {
  return stopReason === TRUNCATION_STOP_REASON ? "fail" : "salvage";
}

export const SALVAGE_SYSTEM =
  "You transcribe an existing answer into JSON. You do no research and you add nothing.";

/**
 * Deliberately permissive about the SHAPE OF A ROLE, and it has to be.
 *
 * The extraction contract the original call used (roleExtractionSchema in
 * lib/search-criteria.ts) is PROSE embedded in the prompt, not a JSON Schema
 * object — and it is per-tenant, since it renders the profile's persona and
 * building concept. Enumerating fields here would silently drop every field
 * that prose asks for and every field a future profile adds. So this schema
 * constrains only what the pipeline actually depends on — an object with a
 * `roles` array — and lets each role carry whatever the model transcribed.
 */
export const SALVAGE_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    roles: {
      type: "array",
      description: "The roles stated in the text. Empty if it states none were found.",
      items: { type: "object" },
    },
    message: {
      type: "string",
      description: "The explanation given, if the text explains why nothing was found.",
    },
  },
  required: ["roles"],
};

/**
 * `raw` goes in verbatim. This call must not re-derive anything — it is a
 * reformat of words already paid for, not a second search.
 */
export function buildSalvagePrompt(raw: string): string {
  return `A previous step was asked for JSON and answered in prose instead. Convert its answer, below, into the required JSON object.

Rules:
- Transcribe ONLY what the text below actually states. Do not invent roles, titles, URLs, salaries, or companies, and do not fill in fields the text does not give.
- If the text says no qualifying roles were found, return an empty roles array and put its explanation in "message".
- Keep every detail the text does give for each role, using the field names it uses.

The answer to convert:
---
${raw}
---`;
}
