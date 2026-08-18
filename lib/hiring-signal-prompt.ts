// Discover's two prompt builders — the system prompt and the per-search user
// prompt — pulled out of app/actions/discover.ts for the reason every other
// *-prompt.ts file in this directory exists: "use server" forbids non-async
// exports, so nothing in that action can be exported pure or reached from a
// test, and this text now has to vary per tenant rather than being one
// hardcoded funding-analyst persona.
//
// RULING (this task, in the shape of the SDD ledger's Ruling 3): full literal
// byte-identity to the PRE-TASK-13 hardcoded prompt is not achievable from
// HiringSignal's five fields alone, and is not attempted. The old SYSTEM
// prompt's "(Series B, Series C, Series D+, Late Stage, Growth, Pre-IPO).
// Exclude seed, pre-seed, and Series A rounds." and the old USER prompt's
// four example search queries ("Series B funding …", "startup raises
// millions …") are venture-specific detail that DEFAULT_PROFILE.hiringSignal
// does not carry (its `qualifier` is the five words "Series B and above",
// nothing more) — and this task exists specifically to stop Discover
// hardcoding that vocabulary for every tenant. Reproducing it verbatim in a
// template every profile now shares would put the venture wording back for a
// defence-contract or hospital-accreditation tenant, which is the exact
// defect CLAUDE.md names Discover for. So: the two builders below are pinned
// exactly by lib/hiring-signal-prompt.test.ts (any unintentional drift in
// their rendering shows up as a test diff, the same guarantee every other
// prompt builder in this directory gets) but the pinned text is a new,
// signal-driven rendering, not a reproduction of the old literal string.
// What IS preserved byte-for-byte for the shipped funding profile: the exact
// 10-source list and join style (joinSources, below — Ruling 3's superset),
// the qualifier text, the location-preference sentence (verbatim per Step 3
// — it comes from `criteria.locationRule`, not from the signal, so it is
// out of this task's scope), and the closing "Return ONLY…" instructions.

import { dateContextLine, type Criteria } from "@/lib/search-criteria";
import type { HiringSignal } from "@/lib/profile";

// Oxford-comma join, matching today's rendered source list exactly:
// "A, B, C, and D". Extracted so both builders — and the test — share one
// implementation rather than two copies that could drift apart.
export function joinSources(sources: string[]): string {
  if (sources.length === 0) return "";
  if (sources.length === 1) return sources[0];
  if (sources.length === 2) return `${sources[0]} and ${sources[1]}`;
  return `${sources.slice(0, -1).join(", ")}, and ${sources[sources.length - 1]}`;
}

export function hiringSignalSystem(signal: HiringSignal): string {
  // hasRecency decides the framing, not a separate parameter — HiringSignal
  // already carries it, and Binding 4 requires the prompt to ask for CURRENT
  // holders of a standing property rather than announcements "for the given
  // period" when there is no period at all.
  const periodClause = signal.hasRecency ? " for the given period" : "";
  return `You are a ${signal.name} analyst. Your job is to find every significant ${signal.name}${periodClause} — do not curate down to a short list, capture all notable ones. Search multiple sources: ${joinSources(signal.sources)}. Focus exclusively on ${signal.qualifier}. Prioritize completeness — it is better to return 20 results than to miss a major one. Return ONLY valid JSON, no markdown, no preamble.`;
}

export function buildHiringSignalPrompt(args: {
  signal: HiringSignal;
  criteria: Criteria;
  /**
   * The rendered window text (e.g. "in the past 7 days"), or null when
   * `signal.hasRecency` is false. Binding 4: with no period, the prompt
   * carries NO period clause at all — it asks for current holders of the
   * property instead of announcements in a window.
   */
  period: string | null;
  focus: string;
  now?: Date;
}): string {
  const { signal, criteria, period, focus, now } = args;
  const sources = joinSources(signal.sources);

  const searchClause = period
    ? `Search ${sources} for ALL ${signal.name} announced ${period}. Only include ${signal.qualifier}.`
    : `Search ${sources} for current holders of this property: ${signal.name}. Only include ${signal.qualifier}.`;

  const exampleQueries = period
    ? `Do multiple searches to ensure completeness — vary the query wording, e.g. "${signal.qualifier} ${signal.name} ${period}" and "${signal.name} ${period}".`
    : `Do multiple searches to ensure completeness — vary the query wording, e.g. "${signal.qualifier} ${signal.name}" and "current ${signal.name}".`;

  // Only injected when there is a period to reason about — dateContextLine's
  // whole job is to stop the model biasing a WINDOWED search toward a stale
  // year, which does not apply to a standing-property search that carries no
  // window at all.
  const dateLine = period ? `${dateContextLine(now)} ` : "";

  // Signal-relevant location, added to the fixed core per Binding 2: the
  // probe found `headquarters` actively misleading for a facility-shaped
  // signal (Amgen HQ'd in Thousand Oaks, CA for an OHIO plant expansion), so
  // the card needs a field that names where the SIGNAL happened, which may
  // differ from headquarters.
  const locationField = `location (string, WHERE the ${signal.name} actually happened — the specific site, facility, or region named in the signal, which may differ from headquarters)`;

  // extras absorb whatever per-signal detail the profile asks for (raised /
  // stage / lead_investor for the shipped funding profile; contract_value /
  // awarding_agency / program_name for a defence-contract profile; empty for
  // a profile that asked for none) — see Binding 1/Step 4: the fixed core
  // stays five fields plus this one, everything else is generated.
  const extrasClause =
    signal.extraFields.length > 0
      ? `, extras (a JSON object with these additional fields, all strings: ${signal.extraFields.join(", ")})`
      : "";

  // The location-preference sentence below is verbatim, unchanged by this
  // task: it is driven by `criteria.locationRule` (a Criteria field, already
  // per-tenant and out of this task's scope — see the module comment), not
  // by the hiring signal, so Step 3's "replace only what the signal
  // supplies" leaves it alone.
  return `${focus}${searchClause} ${exampleQueries} Return up to 20 results — do not cut the list short. ${dateLine}IMPORTANT location preference (soft, for ranking — do not hard-exclude): prioritize companies that hire remotely or have a Denver/Colorado presence. For reference, the roles being sought follow this rule: ${criteria.locationRule} For each, return a JSON array of objects with these exact fields: company (string), tagline (string), careers_url (string, best guess careers page URL or empty string), headquarters (string, city and state e.g. "San Francisco, CA" or "Remote" or "New York, NY"), ${locationField}, signal (string, one legible sentence describing what happened, e.g. "Won $2.1B USAF sustainment contract" or "Raised $400M Series D led by a16z")${extrasClause}. Return ONLY the JSON array.`;
}
