import { describe, expect, it } from "vitest";
import { chatSendPlan } from "@/lib/chat-launch";
import { takePendingMessage, stashPendingMessage } from "@/lib/pending-chat-message";

describe("chatSendPlan", () => {
  // Mutation this catches: treating every context the same and always sending.
  // On the tailor screen the draft IS live, so a restore would checkpoint and
  // re-restore the document the user is already editing.
  it("sends directly when the chat is already on the working draft", () => {
    expect(chatSendPlan({ context: "draft", hasContent: false, jobId: "j1" }).kind).toBe("send");
  });

  // Mutation this catches: sending straight from a saved résumé. The chat
  // rewrites a selection, and a frozen row has none — the turn would apply to
  // whatever draft happens to be current, silently editing a different document
  // than the one on screen.
  it("restores first when the chat is opened on a reproducible saved résumé", () => {
    const plan = chatSendPlan({ context: "saved", hasContent: true, jobId: "j1" });
    expect(plan.kind).toBe("restoreThenSend");
    expect(plan.kind === "restoreThenSend" && plan.jobId).toBe("j1");
  });

  // Mutation this catches: offering the chat on a pre-021 row. There is no
  // stored selection to restore, so "restore then send" would upsert null over
  // the draft — the data-loss path lib/checkpoint-decision.ts exists to prevent.
  it("blocks on a saved résumé that records no content", () => {
    const plan = chatSendPlan({ context: "saved", hasContent: false, jobId: "j1" });
    expect(plan.kind).toBe("blocked");
    expect(plan.kind === "blocked" && plan.note).toContain("before");
  });

  // Mutation this catches: checking hasContent BEFORE jobId. Both orderings
  // return "blocked" for this input, so asserting the KIND cannot discriminate
  // them — only the note says which rule fired. With no job the honest reason is
  // the deleted role: telling the user their résumé is merely too old implies
  // that saving a new one would help, and it would not.
  it("blames the deleted role, not the missing content, when both are true", () => {
    const plan = chatSendPlan({ context: "saved", hasContent: false, jobId: null });
    expect(plan.kind).toBe("blocked");
    expect(plan.kind === "blocked" && plan.note).toContain("deleted");
  });

  // Mutation this catches: checking hasContent before jobId. With no job there
  // is no tailored_resumes row to restore into and no chat thread — the same
  // ordering savedEditAffordance gets right, and the same fixture that would
  // hide it if content were absent too.
  it("blocks when the tracked role is gone even though content exists", () => {
    const plan = chatSendPlan({ context: "saved", hasContent: true, jobId: null });
    expect(plan.kind).toBe("blocked");
    expect(plan.kind === "blocked" && plan.note).toContain("deleted");
  });
});

/** A stand-in for sessionStorage — the real one does not exist under vitest's
 *  node environment, and the point of the module is that it survives ONE
 *  navigation, which a fake models exactly. */
function fakeStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    size: () => map.size,
  };
}

describe("pending chat message", () => {
  it("hands the stashed message to the job it was stashed for", () => {
    const s = fakeStorage();
    stashPendingMessage(s, "j1", "cut every role to three bullets");
    expect(takePendingMessage(s, "j1")).toBe("cut every role to three bullets");
  });

  // Mutation this catches: `take` reading without removing. The tailor screen
  // sends the pending message on mount, so a message that survives the read
  // re-sends — and every re-send is a billed model call that re-edits the
  // document, on every reload, forever.
  it("clears the message once taken", () => {
    const s = fakeStorage();
    stashPendingMessage(s, "j1", "hello");
    takePendingMessage(s, "j1");
    expect(takePendingMessage(s, "j1")).toBeNull();
    expect(s.size()).toBe(0);
  });

  // Mutation this catches: keying the stash globally rather than per job. A
  // message meant for one résumé would fire against whichever job you opened
  // next, editing the wrong document with no sign anything was wrong.
  it("does not hand a message to a different job", () => {
    const s = fakeStorage();
    stashPendingMessage(s, "j1", "hello");
    expect(takePendingMessage(s, "j2")).toBeNull();
    expect(takePendingMessage(s, "j1")).toBe("hello");
  });

  // Mutation this catches: stashing whitespace, which would leave a key behind
  // for every cancelled send. Asserting only that the TAKE returns null cannot
  // see it — take's own empty-string guard rescues a blank write — so this
  // asserts nothing was written at all.
  it("writes nothing at all for a blank message", () => {
    const s = fakeStorage();
    stashPendingMessage(s, "j1", "   ");
    expect(s.size()).toBe(0);
    expect(takePendingMessage(s, "j1")).toBeNull();
  });

  // Mutation this catches: letting a storage exception escape. Safari in private
  // mode throws on setItem; the repo's own artifact guidance treats storage as
  // able to throw. A thrown error here would break the click, not just the
  // hand-off.
  it("survives storage that throws", () => {
    const hostile = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
      removeItem: () => {
        throw new Error("denied");
      },
    };
    expect(() => stashPendingMessage(hostile, "j1", "hello")).not.toThrow();
    expect(takePendingMessage(hostile, "j1")).toBeNull();
  });
});
