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
 * The stop reasons that mean the model FINISHED SAYING WHAT IT HAD TO SAY.
 *
 * An ALLOWLIST, not a denylist, and that inversion is the whole safety
 * property. The first version of this gate failed only on "max_tokens" and
 * salvaged everything else — which silently included `pause_turn`, the stop
 * reason a long web_search turn returns when the model pauses mid-flight. The
 * crawler's search tier IS that kind of turn, so the one incomplete case most
 * likely to occur on this code path was the one being treated as complete.
 * `refusal` (a non-answer) and `tool_use` (waiting on a tool) were wrong for
 * the same reason.
 *
 * Full stop_reason vocabulary: end_turn, stop_sequence, max_tokens, tool_use,
 * pause_turn, refusal. Only the first two mean "complete".
 */
const COMPLETE_STOP_REASONS = new Set(["end_turn", "stop_sequence"]);

export type SalvageDecision = "salvage" | "fail";

/**
 * Whether an unparseable response is worth re-reading, given how the model
 * stopped.
 *
 * ONLY A CONFIRMED-COMPLETE ANSWER IS SALVAGED. Re-reading an incomplete one
 * under constrained decoding manufactures a confident `{"roles": []}` out of a
 * sentence that was still mid-thought — and an empty result is trusted as
 * evidence that a company lists nothing, which closes live postings. So
 * anything not positively known to be complete rethrows and the run fails, the
 * behaviour that existed before salvage was added.
 *
 * A null stop reason therefore FAILS. That is a deliberate reversal: an earlier
 * version salvaged on null so a provider that does not report stop reasons
 * would not have every prose response scored as a dead page. The closure hazard
 * outranks it — assuming completeness is exactly what lets a truncated answer
 * close a job. A provider that cannot report stop reasons needs its adapter to
 * map its own vocabulary onto these values, not a permissive default here.
 */
export function salvageDecisionFor(stopReason: string | null): SalvageDecision {
  return stopReason !== null && COMPLETE_STOP_REASONS.has(stopReason)
    ? "salvage"
    : "fail";
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
/**
 * Deliberately permissive about the SHAPE OF AN ITEM, and it has to be.
 *
 * The extraction contracts these callers use (roleExtractionSchema in
 * lib/search-criteria.ts, and the hiring-signal and role-search prompts) are
 * PROSE embedded in the prompt, not JSON Schema objects — and they are
 * per-tenant, since they render the profile's persona and building concept.
 * Enumerating fields here would silently drop every field that prose asks for
 * and every field a future profile adds. So this constrains only what the
 * caller actually depends on — an object with an array under a known key — and
 * lets each item carry whatever the model transcribed.
 *
 * `key` is the caller's, NOT a shared constant: the crawler wants `roles`,
 * Discover wants `startups`, role search wants `matches`. A hardcoded key here
 * would hand every caller an object it then has to rename.
 */
export function salvageSchemaFor(key: string, itemNoun: string): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      [key]: {
        type: "array",
        description: `The ${itemNoun} entries stated in the text. Empty if it states none were found.`,
        items: { type: "object" },
      },
      message: {
        type: "string",
        description: "The explanation given, if the text explains why nothing was found.",
      },
    },
    required: [key],
  };
}

/**
 * `raw` goes in verbatim. This call must not re-derive anything — it is a
 * reformat of words already paid for, not a second search.
 */
export function buildSalvagePrompt(raw: string, itemNoun: string): string {
  return `A previous step was asked for JSON and answered in prose instead. Convert its answer, below, into the required JSON object.

Rules:
- Transcribe ONLY what the text below actually states. Do not invent ${itemNoun} entries, titles, URLs, salaries, or companies, and do not fill in fields the text does not give.
- If the text says nothing qualifying was found, return an empty array and put its explanation in "message".
- Keep every detail the text does give for each ${itemNoun}, using the field names it uses.

The answer to convert:
---
${raw}
---`;
}
