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
    // The stored, unmerged base — sendChatTurn writes it back unchanged
    // unless the turn re-derives it, which only set_themes does.
    baseSelection: SELECTION,
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
    tailoredResumesUpsertPayload: null as Record<string, unknown> | null,
    tailoredResumesShouldFail: false,
    chatMessagesWritten: null as unknown,
    chatWriteShouldFail: false,
    storedThreadMessages: null as unknown,
    tailoredRow: null as unknown,
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
      if (table === "tailored_resumes") {
        return Promise.resolve({ data: state.tailoredRow, error: null });
      }
      // resume_chats: whatever the test set up, or no thread yet.
      return Promise.resolve({
        data: state.storedThreadMessages ? { messages: state.storedThreadMessages } : null,
        error: null,
      });
    };
    b.upsert = (payload: Record<string, unknown>) => {
      if (table === "tailored_resumes") {
        state.tailoredResumesUpsertCalled = true;
        state.tailoredResumesUpsertPayload = payload;
        if (state.tailoredResumesShouldFail) {
          return Promise.resolve({ data: null, error: { message: "insert failed" } });
        }
      }
      if (table === "resume_chats") {
        if (state.chatWriteShouldFail) {
          return Promise.resolve({ data: null, error: { message: "chat write failed" } });
        }
        state.chatMessagesWritten = payload.messages;
      }
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
const readAllSettingsResult = vi.fn(async () => ({ rows: [] as unknown[], error: undefined as string | undefined }));
vi.mock("@/lib/settings-store", () => ({
  readAllSettingsResult: (...args: unknown[]) => readAllSettingsResult(...args),
  careerOverlayFrom: () => [] as unknown[],
  writeCareerOverlay: (overlay: unknown) => writeCareerOverlay(overlay),
}));

import { effectiveDocument } from "@/lib/effective-document";
import { selectBullets } from "@/lib/resume-render/render";
import shippedCareer from "@/lib/resume-render/content/resume.json";
import type { CareerRecord, ResumeSelection } from "@/lib/resume-render/render";
import type { ResumeOverrides } from "@/lib/resume-overrides";
import { acceptProposedBullets, sendChatTurn } from "./resume-chat";

beforeEach(() => {
  vi.clearAllMocks();
  h.state.tailoredResumesUpsertCalled = false;
  h.state.tailoredResumesUpsertPayload = null;
  h.state.tailoredResumesShouldFail = false;
  h.state.chatMessagesWritten = null;
  h.state.chatWriteShouldFail = false;
  h.state.storedThreadMessages = null;
  h.state.tailoredRow = null;
  writeCareerOverlay.mockResolvedValue({});
  readAllSettingsResult.mockResolvedValue({ rows: [], error: undefined });
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

describe("sendChatTurn: model unreachable (finding 4)", () => {
  test("a thrown model error is refused, persisted, and never claims a change", async () => {
    completeDetailed.mockRejectedValue(new Error("ECONNRESET"));

    const res = await sendChatTurn("job-1", "lead with the systems work");

    expect(res.rejected).toBe("Could not reach the model — try again.");
    expect(res.applied).toEqual([]);
    expect(res.selection).toEqual(SELECTION);
    expect(h.state.tailoredResumesUpsertCalled).toBe(false);
    // The model WAS invoked with the user's message — unlike a precondition
    // refusal, this turn is persisted, same as truncation/unreadable/rejection.
    expect(h.state.chatMessagesWritten).toEqual([
      { role: "user", text: "lead with the systems work" },
      { role: "assistant", text: "Could not reach the model — try again." },
    ]);
  });
});

describe("sendChatTurn: a tailored_resumes save failure (finding 1)", () => {
  test("still persists the user's message, but never the model's own claimed reply", async () => {
    h.state.tailoredResumesShouldFail = true;
    completeDetailed.mockResolvedValue({
      text: JSON.stringify({
        reply: "Added it.", // must NOT be what gets persisted — the save never landed
        operations: [{ op: "add_bullet", roleId: "principal", bulletId: "p-b1" }],
      }),
      stopReason: "end_turn",
    });

    const res = await sendChatTurn("job-1", "add the reporting bullet too");

    expect(res.error).toBeDefined();
    expect(res.error).not.toBe("");
    expect(res.rejected).toBe("Could not save that change — try again.");
    expect(res.applied).toEqual([]);
    // Nothing was actually applied — the base selection is unchanged.
    expect(res.selection).toEqual(SELECTION);
    // The user's message is not silently discarded: it lands in the thread
    // alongside a fixed refusal, never the model's own ("Added it.") claim.
    expect(h.state.chatMessagesWritten).toEqual([
      { role: "user", text: "add the reporting bullet too" },
      { role: "assistant", text: "Could not save that change — try again." },
    ]);
  });
});

describe("sendChatTurn: the document saves but the transcript write fails (finding 2)", () => {
  test("reports transcriptSaveError, not error — a caller must not offer a retry that would duplicate the change", async () => {
    h.state.chatWriteShouldFail = true;
    completeDetailed.mockResolvedValue({
      text: JSON.stringify({
        reply: "Added it.",
        operations: [{ op: "add_bullet", roleId: "principal", bulletId: "p-b1" }],
      }),
      stopReason: "end_turn",
    });

    const res = await sendChatTurn("job-1", "add the reporting bullet too");

    // The document DID change — this must never read as a failed turn.
    expect(res.error).toBeUndefined();
    expect(res.rejected).toBeUndefined();
    expect(res.reply).toBe("Added it.");
    expect(res.applied).toEqual(["added bullet p-b1 to principal"]);
    expect(res.selection).toEqual({ positioningId: "operator", bullets: { principal: ["p-b0", "p-b1"] } });
    expect(h.state.tailoredResumesUpsertCalled).toBe(true);
    // The distinct field carries the (non-empty) reason instead.
    expect(res.transcriptSaveError).toBeDefined();
    expect(res.transcriptSaveError).not.toBe("");
    // messages still reflects the turn that genuinely happened, even though
    // the resume_chats write itself failed.
    expect(res.messages).toEqual([
      { role: "user", text: "add the reporting bullet too" },
      { role: "assistant", text: "Added it." },
    ]);
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

  // Finding 3: readAllSettingsResult is a TRANSPORT (lib/settings-store.ts) —
  // its error can legitimately be the empty string (pg's AggregateError on an
  // unreachable database). Presence-detection alone (`!== undefined`) passes
  // whether or not the text is described, so this test bites specifically on
  // the TEXT: it fails if the fix regresses back to `error: rowsResult.error`.
  test("an undescribed (empty-string) settings-read failure still returns a real sentence", async () => {
    h.state.storedThreadMessages = [
      { role: "assistant", text: "How about this:", proposals: [PROPOSAL] },
    ];
    readAllSettingsResult.mockResolvedValueOnce({ rows: [], error: "" });

    const res = await acceptProposedBullets("job-1", ["ov-abc123"]);

    expect(res.error).toBeDefined();
    expect(res.error).not.toBe("");
    expect(res.error).toContain("Could not load your career overlay");
    expect(writeCareerOverlay).not.toHaveBeenCalled();
  });
});

// The five operations the final pre-merge review found inert. Each test below
// asserts the OUTCOME — what a renderer would draw, or what the stored row
// says — never the override object, which is exactly what per-task review
// asserted while all five changed nothing.
describe("sendChatTurn: the wiring the final review found missing", () => {
  test("C1d set_themes re-derives the stored base, so the row is self-consistent", async () => {
    completeDetailed.mockResolvedValue({
      text: JSON.stringify({
        reply: "More data-focused now.",
        operations: [{ op: "set_themes", themes: ["data"] }],
      }),
      stopReason: "end_turn",
    });

    const res = await sendChatTurn("job-1", "make this more data-focused");

    expect(res.error).toBeUndefined();
    // The document actually moved: the data bullet now leads the role, and
    // list order IS render order.
    expect(res.selection).toEqual({ positioningId: "operator", bullets: { principal: ["p-b1", "p-b0"] } });

    const content = (h.state.tailoredResumesUpsertPayload as { content: Record<string, unknown> }).content;
    expect(content.themes).toEqual(["data"]);
    // Not the old selection beside the new themes — that mismatch was
    // reproduced on every later page load and fed to the next turn's prompt.
    expect(content.selection).toEqual({ positioningId: "operator", bullets: { principal: ["p-b1", "p-b0"] } });
    // And the row renders back to exactly what this turn reported.
    const reloaded = effectiveDocument(
      CAREER as unknown as CareerRecord,
      content.selection as ResumeSelection,
      content.themes as string[],
      content.overrides as ResumeOverrides
    );
    expect(reloaded.selection).toEqual(res.selection);
  });

  test("C1e request_rule_change is recorded on the stored assistant message", async () => {
    completeDetailed.mockResolvedValue({
      text: JSON.stringify({
        reply: "That needs a CSS rule, so I've noted it.",
        operations: [{ op: "request_rule_change", description: "make the header two columns" }],
      }),
      stopReason: "end_turn",
    });

    const res = await sendChatTurn("job-1", "make the header two columns");

    expect(res.error).toBeUndefined();
    expect(h.state.chatMessagesWritten).toEqual([
      { role: "user", text: "make the header two columns" },
      {
        role: "assistant",
        text: "That needs a CSS rule, so I've noted it.",
        ruleRequests: ["make the header two columns"],
      },
    ]);
    // I2: it ran, but it changed nothing — a caller that re-renders on this
    // discards the user's unsaved hand edits for a turn with no effect.
    expect(res.applied).toEqual(["requested: make the header two columns"]);
    expect(res.changedDocument).toBe(false);
  });

  test("set_text changes the record the turn hands back, not only the stored row", async () => {
    completeDetailed.mockResolvedValue({
      text: JSON.stringify({
        reply: "Tightened.",
        operations: [{ op: "set_text", target: "bullet:principal:p-b0", text: "Rebuilt the pipeline end to end." }],
      }),
      stopReason: "end_turn",
    });

    const res = await sendChatTurn("job-1", "tighten that bullet");

    expect(res.error).toBeUndefined();
    expect(res.changedDocument).toBe(true);
    const bullet = res.career!.roles[0].bullets.filter((b) => b.id === "p-b0")[0];
    expect(bullet.text).toBe("Rebuilt the pipeline end to end.");
    expect(bullet.edited).toBe(true);
  });

  test("a document-changing operation reports changedDocument", async () => {
    completeDetailed.mockResolvedValue({
      text: JSON.stringify({
        reply: "Added it.",
        operations: [{ op: "add_bullet", roleId: "principal", bulletId: "p-b1" }],
      }),
      stopReason: "end_turn",
    });

    const res = await sendChatTurn("job-1", "add the reporting bullet too");
    expect(res.changedDocument).toBe(true);
  });
});

// I5: before this, Accept wrote the overlay, the chip vanished, and nothing
// changed on screen or after a reload — the new ov-* id was in the record's
// pool but in no selection, so render.js drew it nowhere.
describe("acceptProposedBullets places the accepted bullet on the page", () => {
  test("the id lands in the stored override and in the returned selection", async () => {
    const proposal = {
      id: "ov-abc123",
      roleId: "principal",
      text: "Shipped the thing.",
      themes: ["systems"],
    };
    h.state.storedThreadMessages = [
      { role: "assistant", text: "How about this:", proposals: [proposal] },
    ];
    const shipped = shippedCareer as unknown as CareerRecord;
    const storedSelection = selectBullets(shipped, { themes: ["systems"] });
    h.state.tailoredRow = {
      content: { themes: ["systems"], selection: storedSelection, overrides: {} },
    };

    const res = await acceptProposedBullets("job-1", ["ov-abc123"]);

    expect(res.error).toBeUndefined();
    expect(writeCareerOverlay).toHaveBeenCalledWith([proposal]);
    const content = (h.state.tailoredResumesUpsertPayload as { content: Record<string, unknown> }).content;
    const overrides = content.overrides as ResumeOverrides;
    expect(overrides.selection!.bullets!["principal"]).toContain("ov-abc123");
    // The base is written back untouched — placement is an override.
    expect(content.selection).toEqual(storedSelection);
    // And it is on the page the caller re-renders.
    expect(res.selection!.bullets["principal"]).toContain("ov-abc123");
    expect(res.career!.roles.filter((r) => r.id === "principal")[0].bullets.some((b) => b.id === "ov-abc123")).toBe(
      true
    );
  });
});
