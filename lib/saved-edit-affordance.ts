// lib/saved-edit-affordance.ts
//
// What the archive screen may offer for one saved row.
//
// A pure function rather than a ternary in the component, for the reason
// signInBody (lib/auth-policy.ts:246), enrichGate (lib/enrich-scope.ts:89) and
// compRescoreOffer (lib/rescore-progress.ts:123) are: a server component's JSX
// is reachable from no test in this repo, so a branch written inline is green
// under a suite that cannot see it.

export type SavedEditAffordance =
  | { kind: "restore" }
  | { kind: "draftOnly"; note: string }
  | { kind: "unavailable"; note: string };

export function savedEditAffordance(input: {
  hasContent: boolean;
  jobId: string | null;
}): SavedEditAffordance {
  // Order matters. With no job there is no tailored_resumes row to restore into
  // (its job_id is NOT NULL) and no resume_chats thread either, so the whole
  // feature is permanently unreachable for this row — not merely the button.
  // Checking hasContent first would offer a restore that cannot run.
  if (input.jobId === null) {
    return {
      kind: "unavailable",
      note: "The tracked role this résumé came from was deleted, so it can no longer be edited.",
    };
  }
  if (!input.hasContent) {
    return {
      kind: "draftOnly",
      note: "Saved before résumés recorded how they were built, so this opens the current draft, which may differ from the document above.",
    };
  }
  return { kind: "restore" };
}
