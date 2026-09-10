// The ONE place a web-search response is parsed, and the one place an
// unparseable one is recovered.
//
// Four surfaces call web search and hand the result to parseJson: the crawler's
// search tier, Find Roles, role search, and Discover. Before this existed, only
// the crawler recovered from a prose response, and it did so with the gate
// inlined. Four copies of a rule whose WRONG version silently closes live jobs
// (see .claude/skills/web-search-json-contract) is four chances to drift, so
// the gate lives here once and each caller supplies only the part that is
// genuinely its own: how to read its own shape out of the parsed JSON.

import { completeDetailed, parseJson } from "@/lib/model-call";
import {
  SALVAGE_SYSTEM,
  buildSalvagePrompt,
  salvageSchemaFor,
} from "@/lib/prose-salvage";

export interface SalvageOutcome<T> {
  items: T[];
  message?: string;
  /** True when the first parse failed and the salvage call produced this. */
  salvaged: boolean;
}

export { SEARCH_RESPONSE_TOO_LARGE } from "./model-response";
import { assertModelComplete, ModelResponseError } from "./model-response";
import { ROLE_SEARCH_MAX_TOKENS } from "./role-search-policy";
import { ROLE_MATCH_FIELDS, STARTUP_FIELDS } from "./types";

/**
 * Validate completion before parsing. Recover formatting once with the same
 * output allowance, then validate completion and shape again. Wrong envelopes
 * never become empty listings; recovered results retain separate provenance.
 */
export async function parseOrSalvage<T>(opts: {
  raw: string;
  stopReason: string | null;
  /** The JSON key the salvage schema puts the array under. */
  key: string;
  /** Singular noun for the prompt: "role", "company", "role match". */
  itemNoun: string;
  /**
   * The field names the caller's own type requires. Without these the model
   * picks its own — see salvageSchemaFor. Every caller in this repo passes
   * them; the parameter is optional only for a shape-free future caller.
   */
  itemFields?: readonly string[];
  /** Identifies this call site in logs. */
  label: string;
  extract: (parsed: unknown) => { items: T[]; message?: string };
}): Promise<SalvageOutcome<T>> {
  assertModelComplete(opts.stopReason);
  let parsed: unknown;
  try {
    parsed = parseJson<unknown>(opts.raw);
  } catch {
    console.warn(`${opts.label}: invalid JSON; attempting one format recovery (${opts.raw.length} characters)`);
    try {
      const recovery = await completeDetailed({
        system: SALVAGE_SYSTEM,
        prompt: buildSalvagePrompt(opts.raw, opts.itemNoun, opts.itemFields),
        maxTokens: ROLE_SEARCH_MAX_TOKENS,
        jsonSchema: salvageSchemaFor(opts.key, opts.itemNoun, opts.itemFields),
      });
      assertModelComplete(recovery.stopReason, true);
      const extracted = opts.extract(parseJson<unknown>(recovery.text));
      console.log(`${opts.label}: recovered ${extracted.items.length} item(s)`);
      return { ...extracted, salvaged: true };
    } catch (error) {
      console.error(`${opts.label}: response recovery failed (${error instanceof Error ? error.name : "unknown"})`);
      if (error instanceof ModelResponseError) throw error;
      throw new ModelResponseError("The search response could not be recovered. Please retry.");
    }
  }
  // An explicit error/wrong envelope is not a formatting slip. Do not ask
  // recovery to turn an error object into a successful empty listing.
  return { ...opts.extract(parsed), salvaged: false };
}

/**
 * The extract most callers want: an array, either bare or under `key`.
 *
 * Both shapes have to be accepted because the ORIGINAL response and the
 * SALVAGED one differ by construction — the prompts ask for a bare array, while
 * the salvage schema must nest it under a key to also carry `message`.
 */
export function arrayUnder<T>(key: string, requiredFields: readonly string[] = []) {
  return (parsed: unknown): { items: T[]; message?: string } => {
    const obj = parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown> : null;
    if (obj && ("error" in obj || "errors" in obj)) throw new ModelResponseError();
    const items = Array.isArray(parsed) ? parsed : obj?.[key];
    if (!Array.isArray(items) || items.some(item =>
      !item || typeof item !== "object" || Array.isArray(item) ||
      requiredFields.some(field => typeof item[field] !== "string" || !item[field].trim()) ||
      !validItemFields(item, key)
    )) throw new ModelResponseError();
    const message = typeof obj?.message === "string" ? obj.message : undefined;
    return Array.isArray(parsed) ? { items: items as T[] } : { items: items as T[], message };
  };
}

function validItemFields(item: Record<string, unknown>, key: string): boolean {
  const fields: readonly string[] = key === "roles" || key === "matches"
    ? ROLE_MATCH_FIELDS : key === "startups" ? STARTUP_FIELDS : [];
  for (const field of fields) {
    if (!(field in item)) continue;
    const value = item[field];
    if (field === "requirements" || field === "nice_to_haves") {
      if (!Array.isArray(value) || value.some(v => typeof v !== "string")) return false;
    } else if (field === "ic_flag") {
      if (typeof value !== "boolean") return false;
    } else if (typeof value !== "string") return false;
  }
  if ("extras" in item && (!item.extras || typeof item.extras !== "object" ||
      Array.isArray(item.extras) || Object.values(item.extras).some(v => typeof v !== "string"))) return false;
  return true;
}
