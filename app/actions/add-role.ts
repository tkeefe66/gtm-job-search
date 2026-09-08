"use server";

import { ingestRoles } from "@/lib/ingest-roles";
import { intakeIdentity, needsPaste, normalizeIntakeUrl } from "@/lib/manual-intake";
import { withBudget } from "@/lib/metered";
import { readPosting, readPostingText, type PostingRead } from "@/lib/posting-read";
import { requireActor } from "@/lib/require-actor";
import { loadCriteriaAndScoringInputs } from "@/lib/search-criteria";
import { readOnboardedAtFor } from "@/lib/settings-store";
import type { Role } from "@/lib/types";

/**
 * Adds ONE role the user found themselves, from its URL.
 *
 * Step 1 of docs/superpowers/specs/2026-09-07-verifiable-sourcing-design.md, and
 * the only mechanism in this app that reaches the hosts which block automated
 * readers in principle — Indeed, ZipRecruiter, LinkedIn, Workday tenants,
 * openai.com. Measured 2026-09-07, those hosts are almost the whole of the
 * unread-and-open backlog.
 *
 * URL first, paste as the fallback, because the URL carries IDENTITY: the
 * employer's own name and title from the posting's structured data, a canonical
 * link, and on an ATS deep link a posting id that stays re-checkable. Pasted
 * text has none of that, so a paste-only intake would need the user to type
 * what the URL already knows and would leave a row whose liveness can never be
 * checked again.
 */
export interface AddRoleResult {
  /** The role landed, with the posting's own words. */
  added?: { company: string; roleTitle: string; read: boolean };
  /**
   * The page could not be read (or named no role), so the UI should offer the
   * paste box. `reason` is shown to the user — a silent empty box is not
   * actionable.
   */
  needsPaste?: { url: string; reason: string; company: string; roleTitle: string };
  error?: string;
}

export async function addRoleFromUrl(input: {
  url: string;
  /** What the user typed, which wins over the page — they can see it. */
  company?: string;
  roleTitle?: string;
  /** The JD, when the fetch failed and the user pasted it instead. */
  pastedText?: string;
}): Promise<AddRoleResult> {
  // Session required, and the action's OWN onboarding check: a Server Action is
  // an RPC endpoint addressed by an ID in the client bundle, so the page guard
  // covers nothing here.
  const actor = await requireActor();
  if ((await readOnboardedAtFor(actor.tenantId)) === null) {
    return { error: "Finish onboarding before adding roles — there is no profile to score against." };
  }

  const url = normalizeIntakeUrl(input.url);
  if (url === null) return { error: "That does not look like a link to a job posting." };

  const budget = await withBudget({
    action: "add-role",
    // One read plus one score, both non-search.
    estimateCents: 2,
    isAdmin: actor.isAdmin,
    fn: () => addRoleInner(url, input),
  });
  if (budget.capped) return { error: budget.capped };
  if (budget.error !== undefined) return { error: budget.error };
  return budget.result!;
}

async function addRoleInner(
  url: string,
  input: { company?: string; roleTitle?: string; pastedText?: string }
): Promise<AddRoleResult> {
  const pasted = (input.pastedText ?? "").trim();

  // A paste SKIPS the fetch entirely rather than racing it: the user is pasting
  // precisely because the fetch cannot work, and trying anyway spends a request
  // to learn what they already told us.
  const read: PostingRead = pasted !== ""
    ? await readPostingText({
        text: pasted,
        company: input.company ?? "",
        roleTitle: input.roleTitle ?? "",
        label: "addRoleFromUrl(pasted)",
      })
    : await readPosting({
        url,
        company: input.company,
        roleTitle: input.roleTitle,
        label: "addRoleFromUrl",
      });

  const identity = intakeIdentity(
    read.kind === "read"
      ? { title: read.title, employer: read.employer }
      : { title: "", employer: "" },
    input
  );

  if (needsPaste(read) || !identity.complete) {
    return {
      needsPaste: {
        url,
        reason: reasonFor(read, identity.complete),
        company: identity.company,
        roleTitle: identity.roleTitle,
      },
    };
  }

  const role: Role = {
    role_title: identity.roleTitle,
    job_url: url,
    location: "",
    seniority: "",
    salary_range: "",
    description_summary: read.kind === "read" ? read.summary : "",
    fit_signal: "",
    ic_flag: false,
    requirements: read.kind === "read" ? read.detail.requirements : [],
    nice_to_haves: read.kind === "read" ? read.detail.niceToHaves : [],
    department: read.kind === "read" ? read.department : "",
  };

  const { fitInputs } = await loadCriteriaAndScoringInputs();
  // Through ingestRoles like every other path, so this row gets the same
  // dedupe, the same liveness check, the same scoring and the same fit cutoff.
  // preRead hands over the posting we just read, so ingest does not fetch and
  // bill for it a second time.
  const result = await ingestRoles({
    company: identity.company,
    roles: [role],
    source: "Added by URL",
    fitInputs,
    preRead: { [url]: read },
  });

  if (result.added.length === 0) {
    return result.skipped.length > 0
      ? { error: "You already have that role." }
      : { error: "That role could not be stored." };
  }
  return {
    added: { company: identity.company, roleTitle: identity.roleTitle, read: true },
  };
}

function reasonFor(read: PostingRead, identityComplete: boolean): string {
  if (read.kind === "unreadable") {
    return "This site blocks automated readers, so the posting could not be fetched. Paste the job description and it will be stored against this link.";
  }
  if (read.kind === "failed") {
    return "The posting was fetched but could not be read. Paste the job description to store it against this link.";
  }
  if (!identityComplete) {
    return "The posting did not say which role at which company this is. Fill those in and it will be stored.";
  }
  return "The page loaded but said nothing usable. Paste the job description to store it against this link.";
}
