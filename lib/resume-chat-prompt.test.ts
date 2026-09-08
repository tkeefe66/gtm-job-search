import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { buildChatPrompt, type ChatMessage, type ChatPromptInput } from "./resume-chat-prompt";
import { OPERATION_SCHEMA } from "./resume-ops";
import { DESIGN_TOKENS } from "./resume-design-tokens";
import type { CareerRecord, ResumeSelection } from "./resume-render/render";
import type { ResumeOverrides } from "./resume-overrides";
import type { CoverageReport } from "./resume-coverage";

function fixture(name: string): string {
  return readFileSync(path.join(__dirname, "__fixtures__", name), "utf8");
}

/** The whole rendered pair, in one deterministic layout — the format the
 *  checked-in fixture file uses. */
function combined(system: string, prompt: string): string {
  return `==SYSTEM==\n${system}\n==PROMPT==\n${prompt}`;
}

// A long bullet text, deliberately over BULLET_PREVIEW_CHARS (80), to prove
// the bullet index truncates rather than carrying the full record — the
// whole point of the index (see lib/resume-chat-prompt.ts's file header).
const LONG_BULLET_TEXT =
  "Rebuilt the entire outbound pipeline reporting stack from scratch, cutting the weekly close process from three days of manual reconciliation down to about ninety minutes end to end.";

const CAREER: CareerRecord = {
  identity: { name: "Test Candidate", contacts: [] },
  positioning: [{ id: "operator", themes: ["systems"], tagline: "Operator", summary: "Runs the machine." }],
  roles: [
    {
      id: "principal",
      title: "Principal, RevOps",
      org: "Acme Corp",
      dates: "2022 – Present",
      bullets: [
        { id: "p-b0", priority: 1, themes: ["systems", "data"], text: LONG_BULLET_TEXT },
        { id: "p-b1", priority: 2, themes: ["data"], text: "Short bullet under the limit." },
      ],
    },
    {
      id: "manager",
      title: "Manager, Sales Ops",
      org: "Beta Inc",
      dates: "2019 – 2022",
      bullets: [{ id: "m-b0", priority: 1, themes: ["systems"], text: "Owned the CRM migration." }],
    },
  ],
  advisory: [],
  education: [],
  rules: { taper: [3, 2], themes: ["systems", "data"], compressAfter: null },
};

const SELECTION: ResumeSelection = {
  positioningId: "operator",
  bullets: { principal: ["p-b0", "p-b1"], manager: ["m-b0"] },
};

const OVERRIDES: ResumeOverrides = {
  selection: {
    lead: "p-b0",
    positioning: "operator",
    taper: [3, 2],
    compressAfter: 1,
    bullets: { manager: ["m-b0"] },
  },
  text: { "bullet:principal:p-b0": "Edited text for that bullet." },
  design: { "--rail": "110px" },
  pageMargin: "0.6in",
};

const COVERAGE: CoverageReport = {
  themes: [
    { theme: "systems", pool: 2, selected: 2, roles: ["principal"], support: "strong", poolBeyondRendered: 0 },
    { theme: "data", pool: 2, selected: 1, roles: ["principal"], support: "thin", poolBeyondRendered: 1 },
  ],
  gaps: ["leadership"],
  unknown: ["nonsense-theme"],
  strength: 0.82,
  overlayBullets: 1,
  editedBullets: 1,
};

const MESSAGES: ChatMessage[] = [
  { role: "user", text: "Lead with the reporting rebuild." },
  { role: "assistant", text: "Done — set p-b0 as the lead bullet on principal." },
  { role: "user", text: "Also widen the rail a bit." },
];

const FIXTURE_INPUT: ChatPromptInput = {
  career: CAREER,
  themes: ["systems", "data"],
  selection: SELECTION,
  overrides: OVERRIDES,
  coverage: COVERAGE,
  requirements: ["5+ years running revenue operations", "SQL fluency"],
  niceToHaves: ["Experience with Salesforce CPQ"],
  roleTitle: "Director, Revenue Operations",
  company: "Northwind Systems",
  messages: MESSAGES,
};

function operationNamesFromSchema(): string[] {
  const shape = OPERATION_SCHEMA as unknown as {
    properties: { operations: { items: { properties: { op: { enum: string[] } } } } };
  };
  return shape.properties.operations.items.properties.op.enum;
}

describe("buildChatPrompt", () => {
  test("the whole rendered pair matches the checked-in fixture byte-for-byte", () => {
    const { system, prompt } = buildChatPrompt(FIXTURE_INPUT);
    expect(combined(system, prompt)).toBe(fixture("resume-chat-prompt.txt"));
  });

  // Requirement: the catalogue named in the system prompt cannot drift from
  // what applyOperations actually accepts — derived programmatically from
  // lib/resume-ops.ts's own schema, never retyped, so a rename there fails
  // this test instead of silently producing a turn that always fails.
  test("the system prompt names every operation resume-ops.ts actually accepts", () => {
    const { system } = buildChatPrompt(FIXTURE_INPUT);
    for (const name of operationNamesFromSchema()) {
      expect(system).toContain(name);
    }
  });

  // Same guarantee for the design-token allowlist: derived from
  // DESIGN_TOKENS, not retyped, and checked in both directions so a token
  // dropped from the allowlist can't linger in the prompt as a dangling
  // promise, and nothing not on the allowlist is offered.
  test("the system prompt lists the allowlisted design tokens and no others", () => {
    const { system } = buildChatPrompt(FIXTURE_INPUT);
    const allowedNames = DESIGN_TOKENS.map((t) => t.name).sort();
    for (const name of allowedNames) {
      expect(system).toContain(name);
    }
    const mentioned = Array.from(new Set(system.match(/--[a-zA-Z0-9-]+/g) || [])).sort();
    expect(mentioned).toEqual(allowedNames);
  });

  test("the system prompt states the invariant: propose, never invent; no CSS rules", () => {
    const { system } = buildChatPrompt(FIXTURE_INPUT);
    expect(system).toContain(
      "You may not invent a bullet — propose it and let the user accept it."
    );
    expect(system).toContain("You may not write CSS rules");
    expect(system).toContain("request_rule_change");
  });

  test("the bullet index carries a truncated preview, never the full bullet text", () => {
    const { system } = buildChatPrompt(FIXTURE_INPUT);
    expect(system).not.toContain(LONG_BULLET_TEXT);
    expect(system).toContain(LONG_BULLET_TEXT.slice(0, 80));
  });

  test("requirements and nice-to-haves render as labelled lines in the user prompt", () => {
    const { prompt } = buildChatPrompt(FIXTURE_INPUT);
    expect(prompt).toContain("Requirements: 5+ years running revenue operations; SQL fluency");
    expect(prompt).toContain("Nice to have (not required): Experience with Salesforce CPQ");
  });

  // The optionalList convention lib/resume-prompt.ts establishes: a missing
  // list omits its WHOLE label, never an empty "Nice to have:" line, which
  // would read to the model as a posting that stated no preferences at all.
  test("an empty nice-to-haves list omits the label entirely", () => {
    const { prompt } = buildChatPrompt({ ...FIXTURE_INPUT, niceToHaves: [] });
    expect(prompt).not.toContain("Nice to have");
  });

  test("an empty requirements list omits the label entirely", () => {
    const { prompt } = buildChatPrompt({ ...FIXTURE_INPUT, requirements: [] });
    expect(prompt).not.toContain("Requirements");
  });

  test("the transcript renders in order with roles labelled", () => {
    const { prompt } = buildChatPrompt(FIXTURE_INPUT);
    const iUser1 = prompt.indexOf("User: Lead with the reporting rebuild.");
    const iAssistant = prompt.indexOf("Assistant: Done — set p-b0 as the lead bullet on principal.");
    const iUser2 = prompt.indexOf("User: Also widen the rail a bit.");
    expect(iUser1).toBeGreaterThan(-1);
    expect(iAssistant).toBeGreaterThan(iUser1);
    expect(iUser2).toBeGreaterThan(iAssistant);
  });

  test("an empty transcript renders no message lines", () => {
    const { prompt } = buildChatPrompt({ ...FIXTURE_INPUT, messages: [] });
    expect(prompt).not.toContain("User:");
    expect(prompt).not.toContain("Assistant:");
  });
});
