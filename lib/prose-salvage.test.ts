import { describe, expect, test } from "vitest";
import {
  SALVAGE_SCHEMA,
  SALVAGE_SYSTEM,
  buildSalvagePrompt,
  salvageDecisionFor,
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
    const prose = "I found a careers page but no qualifying roles at this time.";
    expect(buildSalvagePrompt(prose)).toContain(prose);
  });

  test("forbids inventing roles that were not in the prose", () => {
    // The whole risk of this call: a model handed prose about a careers page
    // could helpfully produce plausible-looking roles nobody found.
    const prompt = buildSalvagePrompt("some prose").toLowerCase();
    expect(prompt).toContain("do not invent");
  });

  test("states that an empty list is a valid answer", () => {
    // Without this the model is pushed toward manufacturing a non-empty array.
    expect(buildSalvagePrompt("some prose").toLowerCase()).toContain("empty");
  });
});

describe("SALVAGE_SCHEMA", () => {
  test("forces an object with a roles array", () => {
    expect(SALVAGE_SCHEMA.type).toBe("object");
    const props = SALVAGE_SCHEMA.properties as Record<string, { type?: string }>;
    expect(props.roles?.type).toBe("array");
    expect(SALVAGE_SCHEMA.required).toContain("roles");
  });

  test("lets role objects keep whatever fields the extraction prompt asked for", () => {
    // roleExtractionSchema is PROSE in the prompt, not a JSON Schema, so this
    // schema cannot enumerate the fields. Pinning them here would silently drop
    // every field the prose schema adds.
    const props = SALVAGE_SCHEMA.properties as Record<string, { items?: Record<string, unknown> }>;
    expect(props.roles?.items?.additionalProperties).not.toBe(false);
  });
});

describe("SALVAGE_SYSTEM", () => {
  test("frames the task as transcription, not research", () => {
    expect(SALVAGE_SYSTEM.toLowerCase()).toContain("transcrib");
  });
});
