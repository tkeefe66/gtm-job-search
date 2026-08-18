import { describe, expect, test } from "vitest";
import {
  SALVAGE_SYSTEM,
  buildSalvagePrompt,
  salvageDecisionFor,
  salvageSchemaFor,
} from "./prose-salvage";

// The failure this exists for: on 2026-08-18 a crawler search-tier run against
// adobe returned prose ("I found a ...") with no JSON anywhere, parseJson threw,
// and crawlCompany's catch scored it status "error" — which stamps
// failing_since and starts the dead-page clock on a careers page that was fine.
describe("salvageDecisionFor", () => {
  test("a completed response that ignored the JSON instruction is salvageable", () => {
    // Mutation this catches: an allowlist that forgot end_turn — nothing would
    // ever salvage and the whole feature would be dead code that still passes
    // every failure-path test.
    expect(salvageDecisionFor("end_turn")).toBe("salvage");
  });

  test("a response ended by a stop sequence is salvageable", () => {
    expect(salvageDecisionFor("stop_sequence")).toBe("salvage");
  });

  test("a truncated response is NOT salvageable", () => {
    // Mutation this catches: treating max_tokens as complete. The text is
    // incomplete narration; re-reading it manufactures a confident empty
    // answer, and an empty answer is trusted as closure evidence.
    expect(salvageDecisionFor("max_tokens")).toBe("fail");
  });

  test("a PAUSED turn is NOT salvageable", () => {
    // Mutation this catches: the original denylist gate (`=== "max_tokens"`),
    // under which pause_turn salvaged. This is the case that matters most on
    // this code path: pause_turn is what a long web_search turn returns when
    // the model pauses mid-flight, and the search tier is exactly that kind of
    // turn. A paused turn is INCOMPLETE — same category as max_tokens.
    expect(salvageDecisionFor("pause_turn")).toBe("fail");
  });

  test("a refusal is NOT salvageable", () => {
    // Mutation this catches: the same denylist. A refusal is a non-answer;
    // salvaging it yields an empty array that reads as "this company lists
    // nothing", which can close live roles.
    expect(salvageDecisionFor("refusal")).toBe("fail");
  });

  test("an incomplete tool_use turn is NOT salvageable", () => {
    expect(salvageDecisionFor("tool_use")).toBe("fail");
  });

  test("an UNRECOGNISED stop reason is NOT salvageable", () => {
    // Mutation this catches: a denylist default. Allowlist means a stop reason
    // this code has never heard of — a new API value, or another provider's
    // vocabulary such as OpenAI's "length" for truncation — fails closed
    // instead of being assumed complete.
    expect(salvageDecisionFor("some_future_reason")).toBe("fail");
  });

  test("a missing stop reason is NOT salvageable", () => {
    // Deliberate reversal of the original behaviour, and the cost is real: a
    // provider that does not report stop_reason never salvages, so its prose
    // responses stay hard failures. Accepted because the alternative — assuming
    // completeness — is what lets a truncated answer close live jobs.
    expect(salvageDecisionFor(null)).toBe("fail");
  });
});

describe("buildSalvagePrompt", () => {
  test("carries the model's own words into the prompt verbatim", () => {
    // Mutation this catches: summarising or truncating `raw` instead of
    // passing it through. A salvage that re-describes the prose is a second
    // generation, not a transcription.
    const prose = "I found a careers page but no qualifying roles at this time.";
    expect(buildSalvagePrompt(prose, "role")).toContain(prose);
  });

  test("forbids inventing entries that were not in the prose", () => {
    // Mutation this catches: dropping the anti-fabrication rule. The whole
    // risk of this call is a model helpfully producing plausible roles nobody
    // found, which would then be ingested as real postings.
    expect(buildSalvagePrompt("some prose", "role").toLowerCase()).toContain("do not invent");
  });

  test("states that an empty result is a valid answer", () => {
    // Mutation this catches: removing the empty-is-allowed sentence, which
    // pushes the model toward manufacturing a non-empty array rather than
    // reporting that the prose said nothing was found.
    expect(buildSalvagePrompt("some prose", "role").toLowerCase()).toContain("empty");
  });

  test("names the CALLER'S item noun, not a hardcoded 'role'", () => {
    // Mutation this catches: ignoring itemNoun and hardcoding "role" in the
    // wording. Discover salvages companies and role search salvages matches;
    // a prompt that talks about roles to a Discover salvage is describing the
    // wrong task. Asserting "company" appears is what discriminates — a
    // hardcoded-"role" build contains neither the noun nor anything like it.
    const prompt = buildSalvagePrompt("some prose", "company");
    expect(prompt).toContain("company");
  });
});

describe("salvageSchemaFor", () => {
  test("puts the array under the caller's key", () => {
    // Mutation this catches: returning a fixed `roles` key regardless of the
    // argument. Discover would then get {roles: [...]} for startups and its
    // extract step would read undefined — a silent empty result from a
    // salvage that actually succeeded.
    const schema = salvageSchemaFor("startups", "company");
    const props = schema.properties as Record<string, { type?: string }>;
    expect(props.startups?.type).toBe("array");
    expect(props.roles).toBeUndefined();
  });

  test("requires the caller's key, not a fixed one", () => {
    // Mutation this catches: `required: ["roles"]` hardcoded. Constrained
    // decoding would then force a key the caller never reads while leaving
    // the one it does read optional.
    expect(salvageSchemaFor("matches", "role match").required).toEqual(["matches"]);
  });

  test("lets items keep whatever fields the extraction prompt asked for", () => {
    // Mutation this catches: `additionalProperties: false` on the item shape.
    // The real extraction contract is PROSE in the prompt and is per-tenant,
    // so a closed item schema would strip every field it does not enumerate —
    // silently, since the call still succeeds.
    const props = salvageSchemaFor("roles", "role").properties as Record<
      string,
      { items?: Record<string, unknown> }
    >;
    expect(props.roles?.items?.additionalProperties).not.toBe(false);
  });
});

describe("field names", () => {
  // THE DEFECT THIS PINS, found by calling the real API on 2026-08-18: the
  // model was handed prose and an item schema with no properties, so it chose
  // its own field names — {title, url, salary} where Role requires
  // {role_title, job_url, salary_range}. ingestRoles would have received
  // role_title: undefined for every salvaged role. Every unit test passed,
  // because every fixture was written with the correct names already.
  test("the schema declares the caller's field names on each item", () => {
    // Mutation this catches: ignoring itemFields and emitting a bare
    // {type: "object"} item, which is what shipped.
    const schema = salvageSchemaFor("roles", "role", ["role_title", "job_url"]);
    const props = schema.properties as Record<string, { items?: { properties?: Record<string, unknown> } }>;
    expect(Object.keys(props.roles?.items?.properties ?? {})).toEqual(["role_title", "job_url"]);
  });

  test("items still accept fields beyond the declared ones", () => {
    // The original reason the item shape was left open: the real extraction
    // contract is per-tenant prose, so closing it would strip fields it does
    // not enumerate. Declaring the core names must not close the shape.
    const schema = salvageSchemaFor("roles", "role", ["role_title"]);
    const props = schema.properties as Record<string, { items?: Record<string, unknown> }>;
    expect(props.roles?.items?.additionalProperties).not.toBe(false);
  });

  test("the prompt names the required fields verbatim", () => {
    // Mutation this catches: constraining the schema but leaving the prompt
    // saying "using the field names it uses" — prose has no field names, so
    // that sentence invites exactly the invention that caused the defect.
    const prompt = buildSalvagePrompt("some prose", "role", ["role_title", "job_url"]);
    expect(prompt).toContain("role_title");
    expect(prompt).toContain("job_url");
  });

  test("omitting the field list leaves the item shape open", () => {
    const props = salvageSchemaFor("roles", "role").properties as Record<
      string,
      { items?: { properties?: unknown } }
    >;
    expect(props.roles?.items?.properties).toBeUndefined();
  });
});

describe("SALVAGE_SYSTEM", () => {
  test("frames the task as transcription, not research", () => {
    // Mutation this catches: a system prompt that invites the model to look
    // things up. This call must never search — it is a reformat of words
    // already paid for.
    expect(SALVAGE_SYSTEM.toLowerCase()).toContain("transcrib");
  });
});
