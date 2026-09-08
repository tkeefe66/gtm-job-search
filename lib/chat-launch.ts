// What sending a chat message should DO, given where the chat was opened.
//
// The dock renders on two screens with the same component, and they differ in
// one load-bearing way: the tailor screen is editing a live draft, while a
// saved résumé is frozen HTML with no selection attached. Every chat operation
// rewrites a selection (lib/resume-ops.ts), so a turn sent from a saved screen
// with no restore would apply to whatever draft happens to be current — editing
// a different document than the one on the page, with nothing to show for it.
//
// A pure function for the same reason savedEditAffordance is one: this decides
// a branch inside a client component, and the choice it gets wrong is silent.

export type ChatContext = "draft" | "saved";

export type ChatSendPlan =
  | { kind: "send" }
  | { kind: "restoreThenSend"; jobId: string }
  | { kind: "blocked"; note: string };

export function chatSendPlan(input: {
  context: ChatContext;
  hasContent: boolean;
  jobId: string | null;
}): ChatSendPlan {
  if (input.context === "draft") return { kind: "send" };

  // Order matters, and it is the same order savedEditAffordance uses: with no
  // job there is no tailored_resumes row to restore into (its job_id is NOT
  // NULL) and no resume_chats thread either, so checking hasContent first would
  // promise a restore that cannot run.
  if (input.jobId === null) {
    return {
      kind: "blocked",
      note: "The tracked role this résumé came from was deleted, so it can no longer be edited.",
    };
  }
  if (!input.hasContent) {
    return {
      kind: "blocked",
      note: "This résumé was saved before résumés recorded how they were built, so there is nothing to reopen and edit.",
    };
  }
  return { kind: "restoreThenSend", jobId: input.jobId };
}
