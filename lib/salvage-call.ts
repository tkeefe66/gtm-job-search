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

import { complete, parseJson } from "@/lib/model-call";
import {
  SALVAGE_SYSTEM,
  buildSalvagePrompt,
  salvageDecisionFor,
  salvageSchemaFor,
} from "@/lib/prose-salvage";

export interface SalvageOutcome<T> {
  items: T[];
  message?: string;
  /** True when the first parse failed and the salvage call produced this. */
  salvaged: boolean;
}

/**
 * Parse a web-search response, recovering it under constrained decoding if the
 * model answered in prose.
 *
 * `extract` is the caller's own shape logic and runs against BOTH the original
 * parse and the salvaged one, so a caller cannot accidentally accept a shape on
 * the recovery path that it would have rejected on the normal one.
 *
 * Truncation is NOT recoverable and rethrows — see salvageDecisionFor. The
 * caller's existing error handling then behaves exactly as it did before this
 * function existed, which is the point: nothing about the failure path changes
 * except that non-truncated prose now gets a second, cheap chance.
 */
export async function parseOrSalvage<T>(opts: {
  raw: string;
  stopReason: string | null;
  /** The JSON key the salvage schema puts the array under. */
  key: string;
  /** Singular noun for the prompt: "role", "company", "role match". */
  itemNoun: string;
  /** Identifies this call site in logs. */
  label: string;
  extract: (parsed: unknown) => { items: T[]; message?: string };
}): Promise<SalvageOutcome<T>> {
  try {
    return { ...opts.extract(parseJson<unknown>(opts.raw)), salvaged: false };
  } catch (err) {
    if (salvageDecisionFor(opts.stopReason) === "fail") {
      console.error(
        `${opts.label}: response was truncated (stop_reason=${opts.stopReason}); not salvaging — ` +
          `raise maxTokens if this recurs. Raw head: ${opts.raw.slice(0, 200)}`
      );
      throw err;
    }
    console.warn(
      `${opts.label}: response was prose, not JSON (stop_reason=${opts.stopReason}); ` +
        `re-reading it under constrained decoding. Raw head: ${opts.raw.slice(0, 200)}`
    );

    // A salvage that itself fails rethrows the ORIGINAL parse error, not its
    // own: the first failure is what actually happened to this call, and
    // replacing it would hide the real response behind a second-order message.
    let salvagedRaw: string;
    try {
      salvagedRaw = await complete({
        system: SALVAGE_SYSTEM,
        prompt: buildSalvagePrompt(opts.raw, opts.itemNoun),
        // No search, and the input is one already-generated answer, so this is
        // small and cheap next to the call that produced the prose.
        maxTokens: 4000,
        jsonSchema: salvageSchemaFor(opts.key, opts.itemNoun),
      });
    } catch (salvageErr) {
      console.error(
        `${opts.label}: salvage call failed — ` +
          `${salvageErr instanceof Error ? salvageErr.message : String(salvageErr)}`
      );
      throw err;
    }

    const extracted = opts.extract(parseJson<unknown>(salvagedRaw));
    console.log(`${opts.label}: salvaged ${extracted.items.length} item(s) from a prose response`);
    return { ...extracted, salvaged: true };
  }
}

/**
 * The extract most callers want: an array, either bare or under `key`.
 *
 * Both shapes have to be accepted because the ORIGINAL response and the
 * SALVAGED one differ by construction — the prompts ask for a bare array, while
 * the salvage schema must nest it under a key to also carry `message`.
 */
export function arrayUnder<T>(key: string) {
  return (parsed: unknown): { items: T[]; message?: string } => {
    if (Array.isArray(parsed)) return { items: parsed as T[] };
    if (parsed && typeof parsed === "object") {
      const obj = parsed as Record<string, unknown>;
      const items = Array.isArray(obj[key]) ? (obj[key] as T[]) : [];
      const message = typeof obj.message === "string" ? obj.message : undefined;
      return { items, message };
    }
    return { items: [] };
  };
}
