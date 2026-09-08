"use server";
// Every export here is an RPC endpoint reachable by id from the client bundle.
//
// One chat turn, end to end: build the prompt (lib/resume-chat-prompt.ts),
// call the model through the ONE schema-constrained path that can tell a
// truncated response from a complete one, validate and atomically apply what
// comes back (lib/resume-ops.ts), and persist. Every module built across this
// branch's earlier tasks meets here.
//
// Two invariants shape almost every branch below:
//   1. A failed turn still persists the user's message and the assistant's
//      reply — a user who asks for something impossible must see their own
//      message and the refusal after a reload, not an empty box. Nothing
//      ELSE changes on a failure: no overrides, no themes, no overlay.
//   2. Coverage is recomputed and returned, never stored — tailored_resumes
//      keeps only what makes the document (themes/selection/overrides); the
//      coverage panel is a read-time report over that.

import { requireResumeAdmin } from "@/lib/require-resume-admin";
import { withBudget } from "@/lib/metered";
import { completeDetailed, parseJson, type DetailedResponse } from "@/lib/model-call";
import { supabase } from "@/lib/supabase";
import { describeWriteFailure } from "@/lib/write-failure";
import { buildChatPrompt, type ChatMessage } from "@/lib/resume-chat-prompt";
import { applyOperations, OPERATION_SCHEMA, type Operation } from "@/lib/resume-ops";
import { coverageReport, type CoverageReport } from "@/lib/resume-coverage";
import {
  careerOverlayFrom,
  readAllSettingsResult,
  writeCareerOverlay,
  type OverlayBullet,
} from "@/lib/settings-store";
import { loadResumeContext, type ResumeOverrides } from "@/app/actions/resume";
import type { PostingDetail } from "@/lib/posting-detail";
import type { ResumeSelection, ThemeVocabulary } from "@/lib/resume-render/render";
import themeVocabularyJson from "@/lib/resume-render/content/themes.json";

const themeVocabulary = themeVocabularyJson as ThemeVocabulary;

/**
 * A stored chat message. `proposals` is set ONLY on an assistant message that
 * proposed new career bullets in that turn — the thread is where a proposal
 * lives between the model emitting it and the user accepting it, because
 * client state alone loses it on reload, which is the whole reason this
 * thread is persisted at all (see acceptProposedBullets below, which resolves
 * ids against exactly this field).
 */
export interface StoredChatMessage extends ChatMessage {
  proposals?: OverlayBullet[];
}

const TRUNCATED_REPLY =
  "That answer was cut short — try asking for one change at a time";
const UNREADABLE_REPLY = "Could not read that answer — try rephrasing your request.";
const MODEL_FAILED_REPLY = "Could not reach the model — try again.";
const NOT_TAILORED_REPLY = "Tailor this résumé before chatting about it.";

interface TurnResult {
  reply: string;
  applied: string[];
  rejected?: string;
  selection: ResumeSelection | null;
  overrides: ResumeOverrides;
  coverage: CoverageReport | null;
  messages: StoredChatMessage[];
  error?: string;
}

function isOverlayBulletShape(b: unknown): b is OverlayBullet {
  if (!b || typeof b !== "object") return false;
  const o = b as Record<string, unknown>;
  return (
    typeof o.id === "string" &&
    typeof o.roleId === "string" &&
    typeof o.text === "string" &&
    Array.isArray(o.themes)
  );
}

/** REPAIRS whatever is in the row rather than rejecting it — the same
 *  contract careerOverlayFrom/resolveProfile/resolveStatuses follow
 *  elsewhere in this app. A malformed message is dropped; a malformed ROW
 *  reads as an empty thread rather than throwing. */
function sanitizeStoredMessages(value: unknown): StoredChatMessage[] {
  if (!Array.isArray(value)) return [];
  const out: StoredChatMessage[] = [];
  for (const m of value) {
    if (!m || typeof m !== "object") continue;
    const o = m as Record<string, unknown>;
    if (o.role !== "user" && o.role !== "assistant") continue;
    if (typeof o.text !== "string") continue;
    const msg: StoredChatMessage = { role: o.role, text: o.text };
    if (Array.isArray(o.proposals)) {
      const proposals = o.proposals.filter(isOverlayBulletShape);
      if (proposals.length > 0) msg.proposals = proposals;
    }
    out.push(msg);
  }
  return out;
}

async function readThread(
  tenantId: string,
  jobId: string
): Promise<{ messages: StoredChatMessage[]; error?: string }> {
  const { data, error } = await supabase
    .forTenant(tenantId)
    .from("resume_chats")
    .select("messages")
    .eq("job_id", jobId)
    .maybeSingle();
  if (error) {
    console.error("resume-chat readThread error:", error);
    return { messages: [], error: describeWriteFailure(error.message, "load the chat thread") };
  }
  if (!data) return { messages: [] };
  const row = data as { messages: unknown };
  return { messages: sanitizeStoredMessages(row.messages) };
}

/** Verbatim `{ error }`, empty message included — this is a WRITER, so the
 *  reader (persistTurn, below) is where describeWriteFailure applies. */
async function writeThread(
  tenantId: string,
  jobId: string,
  messages: StoredChatMessage[]
): Promise<{ error?: string }> {
  const { error } = await supabase
    .forTenant(tenantId)
    .from("resume_chats")
    .upsert(
      { job_id: jobId, messages, updated_at: new Date().toISOString() },
      { onConflict: "tenant_id,job_id" }
    );
  return { error: error?.message };
}

/** Writes the thread and describes any failure — the one place that turns
 *  writeThread's verbatim (possibly empty) message into a sentence. */
async function persistTurn(
  tenantId: string,
  jobId: string,
  messages: StoredChatMessage[]
): Promise<{ error?: string }> {
  const res = await writeThread(tenantId, jobId, messages);
  return { error: describeWriteFailure(res.error, "save that chat message") };
}

interface JobFields {
  roleTitle: string;
  company: string;
  requirements: string[];
  niceToHaves: string[];
}

/** Just enough of the job row to render the JOB block of the chat prompt.
 *  Mirrors app/actions/resume.ts's loadJobForTenant/toSummaryFields — kept
 *  separate rather than exported from there, since that file's own reader
 *  selects different columns for a different purpose. */
async function loadJobFields(
  tenantId: string,
  jobId: string
): Promise<{ job: JobFields | null; error?: string }> {
  const { data, error } = await supabase
    .forTenant(tenantId)
    .from("jobs")
    .select("role_title, company, posting")
    .eq("id", jobId)
    .maybeSingle();
  if (error) {
    console.error("resume-chat loadJobFields error:", error);
    return { job: null, error: describeWriteFailure(error.message, "load that job") };
  }
  if (!data) return { job: null };
  const row = data as { role_title: string; company: string; posting: PostingDetail | null };
  return {
    job: {
      roleTitle: row.role_title,
      company: row.company,
      requirements: (row.posting ?? null)?.requirements ?? [],
      niceToHaves: (row.posting ?? null)?.niceToHaves ?? [],
    },
  };
}

/** Never throws. Auth/network/rate-limit/an unreachable model all collapse
 *  into `{ failed }` here, exactly the way deriveThemes (app/actions/resume.ts)
 *  isolates the model call's own failure from everything around it — the SDK's
 *  error text can embed the request URL and sometimes the key itself, so it is
 *  logged and never returned. */
async function callChatModel(
  system: string,
  prompt: string
): Promise<{ completion?: DetailedResponse; failed?: string }> {
  try {
    const completion = await completeDetailed({
      system,
      prompt,
      maxTokens: 2000,
      jsonSchema: OPERATION_SCHEMA,
    });
    return { completion };
  } catch (err) {
    console.error("sendChatTurn: model call failed —", err);
    return { failed: MODEL_FAILED_REPLY };
  }
}

interface ParsedTurn {
  reply: string;
  operations: Operation[];
}

/**
 * The base ResumeSelection with a bullet-level/positioning override layered
 * on top — what is actually on the page right now, as opposed to what
 * tailoring alone produced.
 *
 * Needed for two things: `applyOperations`'s `set_text` check asks whether a
 * target bullet is "on the page" against whatever `ResumeSelection` it is
 * handed, and without this merge a bullet ADDED by an earlier turn's
 * `add_bullet` could never be text-edited by a later one, because it would
 * still be absent from the unmerged base. And the `selection` this action
 * returns is what a caller renders directly against `career` — TailorPanel
 * has no separate step that applies `overrides.selection` on its own, so a
 * `set_lead`/`set_positioning`/bullet-level change would otherwise never
 * visibly take effect.
 *
 * `lead`/`taper`/`compressAfter` are NOT folded in: `ResumeSelection` has no
 * fields for them (only `positioningId` and `bullets`), so those overrides
 * stay exactly where `applyOperations` already puts them, in
 * `overrides.selection` — wiring them into rendering is a later task's job,
 * the same way `overrides.design`/`overrides.pageMargin` are consumed
 * outside `ResumeSelection` today.
 *
 * `tailored_resumes.content.selection` always stores the UNMERGED base — this
 * function's result is never what gets persisted, only what gets returned and
 * validated against, so Regenerate's "discard every chat override" contract
 * is unaffected.
 */
function mergedSelection(base: ResumeSelection, sel?: ResumeOverrides["selection"]): ResumeSelection {
  if (!sel) return base;
  const bullets: Record<string, string[]> = { ...base.bullets };
  if (sel.bullets) {
    Object.keys(sel.bullets).forEach((roleId) => {
      bullets[roleId] = sel.bullets![roleId];
    });
  }
  return {
    positioningId: sel.positioning !== undefined ? sel.positioning : base.positioningId,
    bullets,
  };
}

function parseTurn(raw: string): ParsedTurn | null {
  let parsed: unknown;
  try {
    parsed = parseJson<unknown>(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const o = parsed as Record<string, unknown>;
  if (typeof o.reply !== "string" || !Array.isArray(o.operations)) return null;
  return { reply: o.reply, operations: o.operations as Operation[] };
}

export async function sendChatTurn(jobId: string, message: string): Promise<TurnResult> {
  const actor = await requireResumeAdmin();

  const threadRes = await readThread(actor.tenantId, jobId);
  if (threadRes.error !== undefined) {
    return {
      reply: "",
      applied: [],
      selection: null,
      overrides: {},
      coverage: null,
      messages: [],
      error: threadRes.error,
    };
  }
  const priorMessages = threadRes.messages;

  const jobRes = await loadJobFields(actor.tenantId, jobId);
  if (jobRes.error !== undefined) {
    return {
      reply: "",
      applied: [],
      selection: null,
      overrides: {},
      coverage: null,
      messages: priorMessages,
      error: jobRes.error,
    };
  }
  if (!jobRes.job) {
    return {
      reply: "",
      applied: [],
      selection: null,
      overrides: {},
      coverage: null,
      messages: priorMessages,
      error: "Could not find that job",
    };
  }

  const context = await loadResumeContext(jobId);
  if (context.error !== undefined) {
    return {
      reply: "",
      applied: [],
      selection: null,
      overrides: {},
      coverage: null,
      messages: priorMessages,
      error: context.error,
    };
  }
  // Nothing to chat about yet: the operations this action applies all act on
  // an existing selection, and buildChatPrompt requires one — a precondition
  // failure, not a conversational turn, so it is reported without being
  // written to the thread (there is no document state a refusal would even
  // describe).
  if (!context.career || !context.selection || !context.coverage) {
    return {
      reply: "",
      applied: [],
      selection: context.selection,
      overrides: context.overrides,
      coverage: context.coverage,
      messages: priorMessages,
      error: NOT_TAILORED_REPLY,
    };
  }

  const career = context.career;
  const selection = context.selection;
  const overrides = context.overrides;
  // What is actually on the page right now, prior overrides included — see
  // mergedSelection's own doc for why this differs from the base `selection`.
  const effectiveSelection = mergedSelection(selection, overrides.selection);

  const messagesForPrompt: ChatMessage[] = [...priorMessages, { role: "user", text: message }];

  const { system, prompt } = buildChatPrompt({
    career,
    vocabulary: themeVocabulary,
    themes: context.themes,
    selection,
    overrides,
    coverage: context.coverage,
    requirements: jobRes.job.requirements,
    niceToHaves: jobRes.job.niceToHaves,
    roleTitle: jobRes.job.roleTitle,
    company: jobRes.job.company,
    messages: messagesForPrompt,
  });

  const budget = await withBudget({
    action: "resume-chat",
    estimateCents: 3,
    isAdmin: actor.isAdmin,
    fn: () => callChatModel(system, prompt),
  });

  // A refusal, not a failure — nothing ran, so nothing is persisted. Mirrors
  // tailorResumeForJob's own handling of `capped`/`error` from withBudget.
  if (budget.capped !== undefined) {
    return {
      reply: "",
      applied: [],
      selection: effectiveSelection,
      overrides,
      coverage: context.coverage,
      messages: priorMessages,
      error: budget.capped,
    };
  }
  if (budget.error !== undefined) {
    return {
      reply: "",
      applied: [],
      selection: effectiveSelection,
      overrides,
      coverage: context.coverage,
      messages: priorMessages,
      error: budget.error,
    };
  }

  const { completion, failed } = budget.result!;
  if (failed !== undefined) {
    return {
      reply: "",
      applied: [],
      selection: effectiveSelection,
      overrides,
      coverage: context.coverage,
      messages: priorMessages,
      error: failed,
    };
  }

  // Truncation is checked BEFORE parsing. The forced-tool path returns
  // JSON.stringify(toolBlock.input) regardless of how the call stopped, so a
  // response cut off at max_tokens still parses into a valid-LOOKING object
  // with operations silently missing — a turn like that is refused outright,
  // never partially applied.
  if (completion!.stopReason === "max_tokens") {
    const updated: StoredChatMessage[] = [
      ...priorMessages,
      { role: "user", text: message },
      { role: "assistant", text: TRUNCATED_REPLY },
    ];
    const persisted = await persistTurn(actor.tenantId, jobId, updated);
    return {
      reply: TRUNCATED_REPLY,
      applied: [],
      rejected: TRUNCATED_REPLY,
      selection: effectiveSelection,
      overrides,
      coverage: context.coverage,
      messages: persisted.error !== undefined ? priorMessages : updated,
      error: persisted.error,
    };
  }

  const parsed = parseTurn(completion!.text);
  if (parsed === null) {
    console.error("sendChatTurn: model returned an unreadable response —", completion!.text);
    const updated: StoredChatMessage[] = [
      ...priorMessages,
      { role: "user", text: message },
      { role: "assistant", text: UNREADABLE_REPLY },
    ];
    const persisted = await persistTurn(actor.tenantId, jobId, updated);
    return {
      reply: UNREADABLE_REPLY,
      applied: [],
      rejected: UNREADABLE_REPLY,
      selection: effectiveSelection,
      overrides,
      coverage: context.coverage,
      messages: persisted.error !== undefined ? priorMessages : updated,
      error: persisted.error,
    };
  }

  const result = applyOperations(parsed.operations, career, effectiveSelection, overrides, themeVocabulary);

  if (result.error !== undefined) {
    const updated: StoredChatMessage[] = [
      ...priorMessages,
      { role: "user", text: message },
      { role: "assistant", text: result.error },
    ];
    const persisted = await persistTurn(actor.tenantId, jobId, updated);
    return {
      reply: result.error,
      applied: [],
      rejected: result.error,
      selection: effectiveSelection,
      overrides,
      coverage: context.coverage,
      messages: persisted.error !== undefined ? priorMessages : updated,
      error: persisted.error,
    };
  }

  // Success. `propose_career_bullet` results are PENDING — returned to the
  // client and persisted on this message as `proposals`, never written to the
  // overlay here. Only acceptProposedBullets, triggered explicitly by the
  // user, does that.
  const newOverrides = result.overrides!;
  const newThemes = result.themes ?? context.themes;

  const assistantMessage: StoredChatMessage = { role: "assistant", text: parsed.reply };
  if (result.overlayAdds && result.overlayAdds.length > 0) {
    assistantMessage.proposals = result.overlayAdds;
  }
  const updated: StoredChatMessage[] = [...priorMessages, { role: "user", text: message }, assistantMessage];

  // Only write tailored_resumes when something was actually asked to change —
  // a pure question (an empty operations array) leaves the document as is,
  // and rewriting an unchanged value would only be a wasted write.
  let saveError: string | undefined;
  if (parsed.operations.length > 0) {
    const { error } = await supabase
      .forTenant(actor.tenantId)
      .from("tailored_resumes")
      .upsert(
        { job_id: jobId, content: { themes: newThemes, selection, overrides: newOverrides } },
        { onConflict: "tenant_id,job_id" }
      );
    saveError = describeWriteFailure(error?.message, "save that tailored resume");
  }

  if (saveError !== undefined) {
    // The document did not durably change, so the chat thread is not written
    // either — persisting an assistant message that claims changes were made
    // would describe a state the database does not hold.
    return {
      reply: parsed.reply,
      applied: result.applied ?? [],
      selection: effectiveSelection,
      overrides,
      coverage: context.coverage,
      messages: priorMessages,
      error: saveError,
    };
  }

  // The new effective selection — base plus this turn's bullet/positioning
  // overrides — is what a caller renders and what coverage is recomputed
  // against. Never stored: tailored_resumes.content.selection above kept the
  // unmerged base.
  const finalSelection = mergedSelection(selection, newOverrides.selection);

  // Coverage is recomputed here and never stored — tailored_resumes keeps
  // only what makes the document; the coverage panel is a read-time report.
  const coverage = coverageReport(career, newThemes, finalSelection, themeVocabulary);

  const persisted = await persistTurn(actor.tenantId, jobId, updated);

  return {
    reply: parsed.reply,
    applied: result.applied ?? [],
    selection: finalSelection,
    overrides: newOverrides,
    coverage,
    messages: persisted.error !== undefined ? priorMessages : updated,
    error: persisted.error,
  };
}

export async function loadChatThread(jobId: string): Promise<{ messages: StoredChatMessage[]; error?: string }> {
  const actor = await requireResumeAdmin();
  return readThread(actor.tenantId, jobId);
}

export async function acceptProposedBullets(jobId: string, ids: string[]): Promise<{ error?: string }> {
  const actor = await requireResumeAdmin();

  const threadRes = await readThread(actor.tenantId, jobId);
  if (threadRes.error !== undefined) return { error: threadRes.error };

  // Resolved server-side against every proposal this thread has ever carried
  // — client state alone loses a proposal on reload, which is the whole
  // reason it is persisted on the assistant message in the first place.
  const byId = new Map<string, OverlayBullet>();
  threadRes.messages.forEach((m) => {
    (m.proposals || []).forEach((p) => byId.set(p.id, p));
  });

  const requested = Array.from(new Set(ids));
  const missing = requested.filter((id) => !byId.has(id));
  if (missing.length > 0) {
    // Reported, never invented: an id absent from the thread is not silently
    // dropped or fabricated into a bullet nobody proposed.
    return { error: "Could not find the proposed bullet(s): " + missing.join(", ") + "." };
  }

  const rowsResult = await readAllSettingsResult();
  if (rowsResult.error !== undefined) return { error: rowsResult.error };
  const overlay = careerOverlayFrom(rowsResult.rows);
  const existingIds = new Set(overlay.map((b) => b.id));

  // Idempotent: an id already in the overlay (a double accept) is skipped
  // rather than duplicated.
  const toAdd = requested.filter((id) => !existingIds.has(id)).map((id) => byId.get(id) as OverlayBullet);
  if (toAdd.length === 0) return {};

  const writeRes = await writeCareerOverlay(overlay.concat(toAdd));
  return { error: describeWriteFailure(writeRes.error, "save the accepted bullet") };
}
