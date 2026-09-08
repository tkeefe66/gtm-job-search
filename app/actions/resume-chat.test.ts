// app/actions/resume-chat.test.ts
//
// Pins the two pure decision points inside sendChatTurn: a truncated model
// response is refused rather than parsed, and a response whose operations
// fail validation is rejected with the reason and leaves the selection
// unchanged. Structured the way app/actions/resume-model-failure.test.ts
// pins deriveThemes's own failure reporting — a mocked model-call/supabase
// layer under an admin actor, isolated from the auth-refusal suite in
// resume.test.ts.
import { beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("@/lib/require-actor", () => ({
  requireActor: async () => ({
    userId: "admin-1",
    tenantId: "admin-1",
    email: "admin@example.com",
    isAdmin: true,
  }),
}));

// Bypassed for the same reason resume-model-failure.test.ts bypasses it: this
// suite is about sendChatTurn's own decision points, and withBudget reaches
// the database for tiers/counters before fn ever runs. Budget behaviour
// itself is pinned in lib/budget.test.ts.
vi.mock("@/lib/metered", () => ({
  withBudget: async (o: { fn: () => Promise<unknown> }) => ({ result: await o.fn() }),
}));

const completeDetailed = vi.fn();
vi.mock("@/lib/model-call", () => ({
  completeDetailed: (...args: unknown[]) => completeDetailed(...args),
  parseJson: (raw: string) => JSON.parse(raw),
}));

const CAREER = {
  identity: { name: "Test Candidate", contacts: [] },
  positioning: [{ id: "operator", themes: ["systems"], tagline: "Operator", summary: "Runs the machine." }],
  roles: [
    {
      id: "principal",
      title: "Principal, RevOps",
      org: "Acme Corp",
      dates: "2022 – Present",
      bullets: [
        { id: "p-b0", priority: 1, themes: ["systems"], text: "Rebuilt the pipeline." },
        { id: "p-b1", priority: 2, themes: ["data"], text: "Owned the reporting stack." },
      ],
    },
  ],
  advisory: [],
  education: [],
  rules: { taper: [2], themes: ["systems"], compressAfter: null },
};

const SELECTION = { positioningId: "operator", bullets: { principal: ["p-b0"] } };
const COVERAGE = { themes: [], gaps: [], unknown: [], strength: null, overlayBullets: 0, editedBullets: 0 };

// loadResumeContext (app/actions/resume.ts) is mocked directly rather than
// its own DB layer: sendChatTurn's contract with it is the career/selection/
// overrides/coverage/themes it returns, and re-deriving those through a full
// supabase/settings-store mock chain would test loadResumeContext a second
// time rather than sendChatTurn's own logic.
vi.mock("@/app/actions/resume", () => ({
  loadResumeContext: vi.fn(async () => ({
    career: CAREER,
    themes: ["systems"],
    selection: SELECTION,
    overrides: {},
    coverage: COVERAGE,
    warnings: [],
  })),
}));

// resume-chat.ts still talks to supabase directly for the job row and the
// resume_chats thread. An empty thread and a plausible job row are enough for
// both cases under test — neither exercises the tailored_resumes write path,
// since a truncation and a validation failure both refuse before that point.
const h = vi.hoisted(() => {
  const state = {
    tailoredResumesUpsertCalled: false,
    chatMessagesWritten: null as unknown,
    storedThreadMessages: null as unknown,
  };
  function makeBuilder(table: string) {
    const b: Record<string, unknown> = {};
    b.select = () => b;
    b.eq = () => b;
    b.maybeSingle = () => {
      if (table === "jobs") {
        return Promise.resolve({
          data: { role_title: "VP RevOps", company: "Acme", posting: null },
          error: null,
        });
      }
      // resume_chats: whatever the test set up, or no thread yet.
      return Promise.resolve({
        data: state.storedThreadMessages ? { messages: state.storedThreadMessages } : null,
        error: null,
      });
    };
    b.upsert = (payload: Record<string, unknown>) => {
      if (table === "tailored_resumes") state.tailoredResumesUpsertCalled = true;
      if (table === "resume_chats") state.chatMessagesWritten = payload.messages;
      return Promise.resolve({ data: [], error: null });
    };
    return b;
  }
  return { state, makeBuilder };
});

vi.mock("@/lib/supabase", () => ({
  supabase: {
    forTenant: () => ({ from: (table: string) => h.makeBuilder(table) }),
  },
  rawQuery: async () => ({ data: [], error: null }),
}));

// Isolated from lib/settings-store's own logic (covered by that module's own
// tests) — acceptProposedBullets' contract with it is a plain read/merge/write
// of OverlayBullet[], and a full careerOverlayFrom/rawQuery chain would test
// settings-store a second time rather than the id-resolution logic under test
// here.
const writeCareerOverlay = vi.fn(async () => ({}) as { error?: string });
vi.mock("@/lib/settings-store", () => ({
  readAllSettingsResult: async () => ({ rows: [] }),
  careerOverlayFrom: () => [] as unknown[],
  writeCareerOverlay: (overlay: unknown) => writeCareerOverlay(overlay),
}));

import { acceptProposedBullets, sendChatTurn } from "./resume-chat";

beforeEach(() => {
  vi.clearAllMocks();
  h.state.tailoredResumesUpsertCalled = false;
  h.state.chatMessagesWritten = null;
  h.state.storedThreadMessages = null;
  writeCareerOverlay.mockResolvedValue({});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("sendChatTurn: truncation", () => {
  test("a response cut off at max_tokens is refused, not partially applied", async () => {
    completeDetailed.mockResolvedValue({
      // Deliberately not valid JSON — a truncated response never reaches
      // parseTurn at all, since stopReason is checked first.
      text: '{"reply":"Sure, I\'ll re',
      stopReason: "max_tokens",
    });

    const res = await sendChatTurn("job-1", "lead with the systems work");

    expect(res.rejected).toBe("That answer was cut short — try asking for one change at a time");
    expect(res.applied).toEqual([]);
    // The selection is untouched — nothing was applied.
    expect(res.selection).toEqual(SELECTION);
    expect(h.state.tailoredResumesUpsertCalled).toBe(false);
    // The turn still lands in the thread: the user's message and the refusal.
    expect(h.state.chatMessagesWritten).toEqual([
      { role: "user", text: "lead with the systems work" },
      { role: "assistant", text: "That answer was cut short — try asking for one change at a time" },
    ]);
  });
});

describe("sendChatTurn: invalid operations", () => {
  test("an operation that fails validation is rejected with the reason, selection unchanged", async () => {
    completeDetailed.mockResolvedValue({
      text: JSON.stringify({
        reply: "Done!",
        operations: [{ op: "add_bullet", roleId: "principal", bulletId: "does-not-exist" }],
      }),
      stopReason: "end_turn",
    });

    const res = await sendChatTurn("job-1", "add a bullet that doesn't exist");

    expect(res.rejected).toBe('"does-not-exist" is not a bullet on role "principal".');
    expect(res.applied).toEqual([]);
    expect(res.selection).toEqual(SELECTION);
    expect(res.overrides).toEqual({});
    expect(h.state.tailoredResumesUpsertCalled).toBe(false);
    expect(h.state.chatMessagesWritten).toEqual([
      { role: "user", text: "add a bullet that doesn't exist" },
      { role: "assistant", text: '"does-not-exist" is not a bullet on role "principal".' },
    ]);
  });
});

describe("sendChatTurn: a valid operation applies and merges into the returned selection", () => {
  test("add_bullet is reflected in the returned selection, persisted, and coverage is recomputed", async () => {
    completeDetailed.mockResolvedValue({
      text: JSON.stringify({
        reply: "Added it.",
        operations: [{ op: "add_bullet", roleId: "principal", bulletId: "p-b1" }],
      }),
      stopReason: "end_turn",
    });

    const res = await sendChatTurn("job-1", "add the reporting bullet too");

    expect(res.error).toBeUndefined();
    expect(res.rejected).toBeUndefined();
    expect(res.reply).toBe("Added it.");
    expect(res.applied).toEqual(["added bullet p-b1 to principal"]);
    // The base ResumeSelection is untouched; the override layers a bullet on
    // top, and the RETURNED selection reflects that merge — the whole reason
    // mergedSelection exists, since nothing else applies overrides.selection
    // before handing the document to a renderer.
    expect(res.selection).toEqual({ positioningId: "operator", bullets: { principal: ["p-b0", "p-b1"] } });
    expect(res.overrides).toEqual({ selection: { bullets: { principal: ["p-b0", "p-b1"] } } });
    expect(res.coverage).not.toBeNull();
    expect(h.state.tailoredResumesUpsertCalled).toBe(true);
    expect(h.state.chatMessagesWritten).toEqual([
      { role: "user", text: "add the reporting bullet too" },
      { role: "assistant", text: "Added it." },
    ]);
  });

  test("an empty operations array (a question) changes nothing and skips the tailored_resumes write", async () => {
    completeDetailed.mockResolvedValue({
      text: JSON.stringify({ reply: "Your strongest theme right now is systems.", operations: [] }),
      stopReason: "end_turn",
    });

    const res = await sendChatTurn("job-1", "what's my strongest theme?");

    expect(res.error).toBeUndefined();
    expect(res.applied).toEqual([]);
    expect(res.selection).toEqual(SELECTION);
    expect(res.overrides).toEqual({});
    expect(h.state.tailoredResumesUpsertCalled).toBe(false);
  });
});

describe("acceptProposedBullets", () => {
  const PROPOSAL = { id: "ov-abc123", roleId: "principal", text: "Shipped the thing.", themes: ["systems"] };

  test("resolves an id from a proposal persisted on an earlier assistant message", async () => {
    h.state.storedThreadMessages = [
      { role: "user", text: "propose a bullet" },
      { role: "assistant", text: "How about this:", proposals: [PROPOSAL] },
    ];

    const res = await acceptProposedBullets("job-1", ["ov-abc123"]);

    expect(res.error).toBeUndefined();
    expect(writeCareerOverlay).toHaveBeenCalledWith([PROPOSAL]);
  });

  test("an id absent from the thread is reported, never invented — nothing is written", async () => {
    h.state.storedThreadMessages = [{ role: "assistant", text: "How about this:", proposals: [PROPOSAL] }];

    const res = await acceptProposedBullets("job-1", ["ov-does-not-exist"]);

    expect(res.error).toBe("Could not find the proposed bullet(s): ov-does-not-exist.");
    expect(writeCareerOverlay).not.toHaveBeenCalled();
  });
});
