"use server";

import { requireActor } from "@/lib/require-actor";
import { withBudget } from "@/lib/metered";

import { complete, parseJson } from "@/lib/model-call";
import type { FitInputs } from "@/lib/fit-inputs";
import { buildFitPrompt, type FitPromptRole } from "@/lib/fit-prompt";
import { loadScoringInputs } from "@/lib/search-criteria";

/**
 * Scores a role against the candidate's background, 1-5, ruthlessly.
 *
 * `fitInputs` is a REQUIRED key whose value may be null. Omission would be
 * indistinguishable from "I meant the default", and the companion
 * compensation plan adds a money value to this same object where that
 * ambiguity becomes a real bug. Requiring the key forces every call site to
 * state its intent — omitting it is a compile error.
 *
 * `null` does NOT mean "use the shipped default": it means "load the user's
 * actual stored settings now", so a manually-added role is scored against the
 * edited fit brain. It exists for the two `"use client"` call sites
 * (components/RolesTable.tsx, components/RecruiterPanel.tsx) which cannot call
 * loadScoringInputs themselves — it transitively imports `pg`.
 *
 * Batch paths must always pass an explicit value. Letting the null fallback
 * fire inside a loop costs one settings read per scored row.
 *
 * The role half of `opts` is `FitPromptRole` (lib/fit-prompt.ts), which is
 * also where the prompt itself lives — pure, and therefore testable, which
 * nothing in this `"use server"` module can be. Spelling the parameter as that
 * interface rather than as a second inline copy is what keeps `ScoringArgs` in
 * lib/rescore-scope.ts (`Omit<Parameters<typeof scoreFit>[0], "fitInputs">`)
 * exact: a field added to the prompt shape breaks `scoringArgsFor` at compile
 * time instead of silently scoring rescored rows blind.
 */
/**
 * Metered. This was billing the PLATFORM key, uncapped and unrecorded — it calls
 * Claude and was never wrapped, so "the platform pays for nothing" was untrue
 * before any provider work started.
 *
 * withBudget runs the inner function directly when a scope is already active, so
 * wrapping this does not double-charge the paths that reach it from inside an
 * already-metered action.
 */
export async function scoreFit(opts: FitPromptRole & { fitInputs: FitInputs | null }): Promise<{ score: number; rationale: string; error?: string }> {
  const actor = await requireActor();
  const budget = await withBudget({
    action: "score-fit",
    estimateCents: 2,
    isAdmin: actor.isAdmin,
    fn: () => scoreFitInner(opts),
  });
  if (budget.capped) return { score: 0, rationale: "", error: budget.capped };
  // Presence, not truthiness: an unreachable database reports an empty message.
  if (budget.error !== undefined) return { score: 0, rationale: "", error: budget.error };
  return budget.result!;
}

async function scoreFitInner(
  opts: FitPromptRole & { fitInputs: FitInputs | null }
): Promise<{ score: number; rationale: string; error?: string }> {
  try {
    const fitInputs = opts.fitInputs ?? (await loadScoringInputs());
    // Through the facade, which resolves the tenant's provider, key and model
    // from the ambient billing scope and records this call's usage into it.
    // This is the app's highest-volume model call — once per role inside
    // ingestRoles' Promise.all — so it is the one that most needs to route the
    // same way as everything else rather than holding its own client.
    const raw = await complete({
      system:
        "You are a ruthless career coach scoring job fit for a specific candidate. Be honest and harsh — most roles should score 2-3. Only give 4-5 for genuinely strong matches. A 5 is rare. Return ONLY valid JSON.",
      prompt: buildFitPrompt(opts, fitInputs),
      maxTokens: 500,
    });

    const result = parseJson<{ score: number; rationale: string }>(raw);
    return { score: Math.min(5, Math.max(1, Math.round(result.score))), rationale: result.rationale };
  } catch (err) {
    // The real error is logged, and logged is the only place it goes.
    console.error("scoreFit error:", err);
    // A CLOSED SET, not the thrown text. The failure that most often lands here
    // is now the SDK's own — a `model: not_found_error` for a model the key
    // cannot reach — and SDK error text embeds the request URL and sometimes
    // the key itself (see app/actions/api-key.ts). None of that may reach a
    // browser, and passing `err.message` through sent all of it.
    //
    // Not describeWriteFailure either: this failure is the model or the parse,
    // not the database, and UNDESCRIBED_DB_ERROR names the database and would
    // be a false sentence here. The constant is non-empty on every path, so the
    // caller's presence check still separates "failed" from "succeeded".
    return { score: 0, rationale: "", error: "Failed to score fit." };
  }
}
