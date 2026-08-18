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
  test("a truncated response is NOT salvageable", () => {
    // The text is incomplete narration. Reformatting it would turn "the model
    // got cut off" into a confident empty answer, and "empty" is trusted as
    // closure evidence (LAST_TRUSTWORTHY_RUN_SQL) — it would close live roles.
    expect(salvageDecisionFor("max_tokens")).toBe("fail");
  });

  test("a completed response that simply ignored the JSON instruction is salvageable", () => {
    expect(salvageDecisionFor("end_turn")).toBe("salvage");
  });

  test("an unknown stop reason is salvageable", () => {
    // Salvage is the safe direction for anything unrecognised: it re-reads the
    // model's own words under constrained decoding rather than guessing.
    expect(salvageDecisionFor("stop_sequence")).toBe("salvage");
  });

  test("a missing stop reason does not crash and is treated as salvageable", () => {
    // A provider that does not report stop_reason must not be pinned to the
    // failure path — that would make every prose response a dead-page signal.
    expect(salvageDecisionFor(null)).toBe("salvage");
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

describe("SALVAGE_SYSTEM", () => {
  test("frames the task as transcription, not research", () => {
    // Mutation this catches: a system prompt that invites the model to look
    // things up. This call must never search — it is a reformat of words
    // already paid for.
    expect(SALVAGE_SYSTEM.toLowerCase()).toContain("transcrib");
  });
});
