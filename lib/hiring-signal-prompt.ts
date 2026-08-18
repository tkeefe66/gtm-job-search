// Discover's two prompt builders — the system prompt and the per-search user
// prompt — pulled out of app/actions/discover.ts for the reason every other
// *-prompt.ts file in this directory exists: "use server" forbids non-async
// exports, so nothing in that action can be exported pure or reached from a
// test, and this text now has to vary per tenant rather than being one
// hardcoded funding-analyst persona.
//
// RULING (this task, in the shape of the SDD ledger's Ruling 3): full literal
// byte-identity to the PRE-TASK-13 hardcoded prompt is not attempted, even
// though the old SYSTEM prompt's "(Series B, Series C, Series D+, Late
// Stage, Growth, Pre-IPO). Exclude seed, pre-seed, and Series A rounds." IS
// mechanically reconstructible — the template below is
// `Focus exclusively on ${signal.qualifier}.`, so a longer `qualifier` value
// would render that detail byte-for-byte. Two real reasons rule that out,
// not "the field can't carry it":
//   1. `qualifier` is pinned to the five words "Series B and above" by
//      lib/profile.test.ts, which this task's file list does not touch —
//      lengthening it here would desync from that pin.
//   2. `qualifier` is reused verbatim inside the example search queries
//      below (`exampleQueries`). A qualifier long enough to carry the old
//      parenthetical/exclusion detail would turn a billed web search into a
//      garbage query string — the field has to stay short to serve BOTH
//      call sites, and the prompt call site is the one that wins.
// So: the two builders below are pinned exactly by
// lib/hiring-signal-prompt.test.ts (any unintentional drift in their
// rendering shows up as a test diff, the same guarantee every other prompt
// builder in this directory gets), but the pinned text is a new,
// signal-driven rendering, not a reproduction of the old literal string.
// What IS preserved byte-for-byte for the shipped funding profile: the exact
// 10-source list and join style (joinSources, below — Ruling 3's superset),
// the qualifier text, the location-preference sentence (verbatim per Step 3
// — it comes from `criteria.locationRule`, not from the signal, so it is
// out of this task's scope), and the closing "Return ONLY…" instructions.
//
// RESOLVED, and left here because the reasoning still governs the shape.
// This file previously recorded a behaviour change: the old prompt's
// exclusion clause ("exclude seed, pre-seed, and Series A rounds") was gone
// with nothing replacing it, so `qualifier` alone ("Series B and above")
// stated the floor but no longer ruled out what sat below it, and the
// shipped funding profile's result set could widen to include a round the
// model judged close enough. `HiringSignal.exclusions` (lib/profile.ts) now
// carries it, rendered by exclusionSentence() below.
//
// It is a SECOND field rather than a longer `qualifier`, for reason 2 above
// and only reason 2: `qualifier` is spliced into the example search queries,
// where exclusion prose would turn a billed web search into a garbage query
// string. `exclusions` is prompt-only and never reaches a query.

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

/**
 * A sentence naming the signal's qualifying threshold, or "" when the tenant
 * left it blank — lib/onboarding-prompt.ts explicitly allows that ("An empty
 * string is a valid answer when every instance counts and nothing should be
 * filtered out"). Owns its own leading space, matching the guard pattern in
 * lib/fit-prompt.ts (compScoringClause / titleScopeBlock / domainBonusBlock):
 * the caller splices this directly with no punctuation of its own around it,
 * so an empty qualifier must vanish cleanly rather than rendering "Focus
 * exclusively on ." or "Only include .".
 */
function qualifierSentence(lead: string, qualifier: string): string {
  return qualifier ? ` ${lead} ${qualifier}.` : "";
}

/**
 * The exclusion sentence, or "" when the tenant's signal rules nothing out.
 * Owns its own leading space for the same reason qualifierSentence does — the
 * caller splices it directly with no punctuation around it.
 */
function exclusionSentence(exclusions: string): string {
  return exclusions ? ` Exclude ${exclusions}.` : "";
}

/**
 * A query-example fragment that leads with the qualifier when there is one,
 * or just `rest` when there isn't — guards the third splice site, inside
 * `exampleQueries` below, where an empty qualifier would otherwise leave a
 * leading space inside a quoted, billed search-query string.
 */
function qualifierPrefixed(qualifier: string, rest: string): string {
  return qualifier ? `${qualifier} ${rest}` : rest;
}

export function hiringSignalSystem(signal: HiringSignal): string {
  // hasRecency decides the framing, not a separate parameter — HiringSignal
  // already carries it, and Binding 4 requires the prompt to ask for CURRENT
  // holders of a standing property rather than announcements "for the given
  // period" when there is no period at all.
  const periodClause = signal.hasRecency ? " for the given period" : "";
  // NOT "find every/all significant ${name}" — that puts a determiner
  // directly against `signal.name`, and `signal.name`'s grammatical number
  // is per-tenant free text this code cannot know (round 1 of this fix
  // tried "all" on the theory the shipped signals are plural; the standing
  // designation is singular, so that broke too — see the round-2 note in
  // this task's report). Restructured instead so no determiner ever sits
  // next to `signal.name`: "every employer" carries the quantifier, and the
  // name sits in an appositive slot after the colon, where singular or
  // plural both read correctly. This avoids the whole class of agreement
  // bug rather than picking a determiner and hoping.
  return `You are a ${signal.name} analyst. Your job is to find every employer showing this signal${periodClause}: ${signal.name} — do not curate down to a short list, capture all notable ones. Search multiple sources: ${joinSources(signal.sources)}.${qualifierSentence("Focus exclusively on", signal.qualifier)}${exclusionSentence(signal.exclusions)} Prioritize completeness — it is better to return 20 results than to miss a major one. Return ONLY valid JSON, no markdown, no preamble.`;
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

  // Same restructuring as hiringSignalSystem, applied here for the same
  // reason: "Search ... for ALL ${signal.name} announced ..." put a
  // determiner directly against per-tenant free text of unknown number.
  // "every employer showing this signal: ${signal.name}" sidesteps it —
  // found while auditing this file for the same bug class after round 2 of
  // this task's review, not asked for directly, but the exact defect the
  // review just flagged next door.
  const searchClause = period
    ? `Search ${sources} for every employer showing this signal: ${signal.name}, announced ${period}.${qualifierSentence("Only include", signal.qualifier)}${exclusionSentence(signal.exclusions)}`
    : `Search ${sources} for current holders of this property: ${signal.name}.${qualifierSentence("Only include", signal.qualifier)}${exclusionSentence(signal.exclusions)}`;

  const exampleQueries = period
    ? `Do multiple searches to ensure completeness — vary the query wording, e.g. "${qualifierPrefixed(signal.qualifier, `${signal.name} ${period}`)}" and "${signal.name} ${period}".`
    : `Do multiple searches to ensure completeness — vary the query wording, e.g. "${qualifierPrefixed(signal.qualifier, signal.name)}" and "current ${signal.name}".`;

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

  // The location-preference sentence below used to ALSO carry a hardcoded
  // "prioritize companies that hire remotely or have a Denver/Colorado
  // presence" clause ahead of `criteria.locationRule` — the previous single
  // user's own city, rendered unconditionally into every tenant's Discover
  // prompt. The career-neutrality guard (lib/career-neutrality.test.ts)
  // could not see it: it is a location assumption, not one of the extracted
  // career-vocabulary phrases. Fixed here by dropping the hardcoded clause
  // and letting `criteria.locationRule` (a Criteria field, already
  // per-tenant) carry the whole preference on its own, still as a SOFT
  // ranking hint rather than a hard exclusion — that was the original
  // intent and stays correct for every tenant's own rule, not just Denver's.
  return `${focus}${searchClause} ${exampleQueries} Return up to 20 results — do not cut the list short. ${dateLine}IMPORTANT location preference (soft, for ranking — do not hard-exclude): prioritize companies consistent with the location rule the roles being sought follow: ${criteria.locationRule} For each, return a JSON array of objects with these exact fields: company (string), tagline (string), careers_url (string, best guess careers page URL or empty string), headquarters (string, city and state e.g. "San Francisco, CA" or "Remote" or "New York, NY"), ${locationField}, signal (string, one legible sentence describing what happened, e.g. "Won $2.1B USAF sustainment contract" or "Raised $400M Series D led by a16z")${extrasClause}. Return ONLY the JSON array.`;
}
