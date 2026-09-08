"use server";

import { ingestRoles } from "@/lib/ingest-roles";
import { intakeIdentity, needsPaste, normalizeIntakeUrl } from "@/lib/manual-intake";
import { withBudget } from "@/lib/metered";
import { readDetail, readPosting, readPostingText, type PostingRead } from "@/lib/posting-read";
import { relinkPatch } from "@/lib/relink";
import { requireActor } from "@/lib/require-actor";
import { NORMALIZED_COMPANY_SQL, normalizeCompanyName } from "@/lib/role-key";
import { rawQuery } from "@/lib/supabase";
import { resolveTenantId } from "@/lib/tenant";
import { getJobStatuses, updateJob } from "@/app/actions/jobs";
import { scoreFit } from "@/app/actions/parse-role";
import { autoFileStatus, shouldAutoFile } from "@/lib/fit-cutoff";
import { describeWriteFailure } from "@/lib/write-failure";
import type { Job } from "@/lib/types";
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
    if (result.skipped.length === 0) return { error: "That role could not be stored." };
    // A duplicate is not a dead end when we are holding a job description the
    // stored row does not have. The user pasted a live posting URL for a role
    // already tracked — refusing threw away the one thing they came for.
    return attachToExisting(identity, url, read);
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

/**
 * Attaches a freshly read posting to the row the user already had.
 *
 * The pasted URL replaces the stored link, because the user found this posting
 * themselves and that is better evidence than whatever a search returned — and
 * relinkPatch keeps the old link in `source_url`, so the repair is never lossy.
 *
 * Only ever FILLS the summary columns, matching ingest: a value a human typed,
 * or an earlier read stored, is not overwritten by this.
 */
async function attachToExisting(
  identity: { company: string; roleTitle: string },
  url: string,
  read: PostingRead
): Promise<AddRoleResult> {
  if (read.kind !== "read") {
    return { error: "You already have that role, and this posting could not be read." };
  }

  const tenantId = await resolveTenantId();
  const { data, error } = await rawQuery<{ id: string; source_url: string | null; status: string }>(
    `select id, source_url, status from jobs
      where tenant_id = $3 and ${NORMALIZED_COMPANY_SQL} = $1 and lower(role_title) = lower($2)
      order by created_at desc limit 1`,
    [normalizeCompanyName(identity.company), identity.roleTitle, tenantId],
    tenantId
  );
  const row = (data ?? [])[0];
  if (error !== null || !row) {
    return { error: "You already have that role, but it could not be found to update." };
  }

  const patch: Partial<Job> = {
    posting: readDetail(read),
    ...relinkPatch(row, url, url),
  };
  if (read.department) patch.department = read.department;
  if (read.summary) patch.key_skills = read.summary;

  // RE-SCORED here, not left to the rescore offer. The row's number was
  // computed without the posting — that is why it was worth attaching one — and
  // a stale score sitting on screen next to a description the app now holds is
  // the defect this whole evening is about. One non-search call.
  //
  // The fit cutoff runs with it, because this is a place a score is WRITTEN and
  // that is where the cutoff lives. A read role below the bar files itself, the
  // same as at ingest.
  const { fitInputs: inputs } = await loadCriteriaAndScoringInputs();
  const scored = await scoreFit({
    company: identity.company,
    role_title: identity.roleTitle,
    company_description: "",
    key_skills: read.summary,
    fit_summary: "",
    department: read.department,
    location: "",
    salary_range: "",
    fitInputs: inputs,
  });
  // scoreFit answers 0 when the call or the parse failed, and writing that
  // would violate the 1-5 check and wipe a real score.
  if (scored.score > 0) {
    patch.fit_score = scored.score;
    if (scored.rationale) patch.fit_summary = scored.rationale;
    const statuses = (await getJobStatuses()).statuses;
    const fileInto = autoFileStatus(statuses);
    if (
      fileInto !== null &&
      shouldAutoFile({ score: scored.score, wasRead: true, status: row.status })
    ) {
      patch.status = fileInto;
    }
  }

  const failure = describeWriteFailure(
    (await updateJob(row.id, patch)).error,
    `attach that posting to ${identity.company} / ${identity.roleTitle}`
  );
  if (failure !== undefined) return { error: failure };
  return { added: { company: identity.company, roleTitle: identity.roleTitle, read: true } };
}
