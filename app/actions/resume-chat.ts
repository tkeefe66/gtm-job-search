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
import { parseGeometry } from "@/lib/page-geometry";
import { evaluateHouseStyle } from "@/lib/house-style";
import { withBudget } from "@/lib/metered";
import { isModelComplete } from "@/lib/model-response";
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
import { effectiveDocument } from "@/lib/effective-document";
import { effectiveCareer } from "@/lib/effective-career";
import { selectBullets } from "@/lib/resume-render/render";
import type { PostingDetail } from "@/lib/posting-detail";
import type { CareerRecord, ResumeSelection, ThemeVocabulary } from "@/lib/resume-render/render";
import shippedCareer from "@/lib/resume-render/content/resume.json";
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
  /**
   * `request_rule_change`'s record. The spec's whole reason for that
   * operation is that a layout change needing a CSS RULE "is recorded in the
   * thread so it can become a real repo change with a build, a fixture diff
   * and a DESIGN_VERSION bump" — until this field existed, applyOperations
   * collected the descriptions and sendChatTurn dropped them on the floor,
   * leaving the only trace in session-only client state that a reload
   * discarded. The one operation whose entire purpose is to capture something
   * for later captured nothing.
   */
  ruleRequests?: string[];
}

const TRUNCATED_REPLY =
  "That answer was cut short — try asking for one change at a time";
const UNREADABLE_REPLY = "Could not read that answer — try rephrasing your request.";
const MODEL_FAILED_REPLY = "Could not reach the model — try again.";
const NOT_TAILORED_REPLY = "Tailor this résumé before chatting about it.";
const SAVE_FAILED_REPLY = "Could not save that change — try again.";

interface TurnResult {
  reply: string;
  applied: string[];
  /**
   * Whether the DOCUMENT changed, from lib/resume-ops.ts's own decision — not
   * `applied.length > 0`, which is true for a rule-change request or a bullet
   * proposal that changed nothing. The client re-renders on this, and a
   * re-render discards the user's unsaved hand edits.
   */
  changedDocument: boolean;
  /** House-style rules the document breaks AFTER this turn. Advisory, never an
   *  error: the user asked for the change and got it. The client shows them so
   *  a request that quietly degrades the page says so out loud. */
  houseFindings?: { rule: string; detail: string }[];
  rejected?: string;
  /**
   * The record the returned `selection` is meant to render against: the
   * overlay and this job's text overrides merged in, and rules.compressAfter
   * carrying a set_compress_after override. Returned rather than left to the
   * client's existing copy because a set_text edit and a compress-after
   * change are BOTH record changes — without this, the server stored them
   * correctly and the document on screen did not move until a reload.
   */
  career: CareerRecord | null;
  selection: ResumeSelection | null;
  overrides: ResumeOverrides;
  coverage: CoverageReport | null;
  messages: StoredChatMessage[];
  error?: string;
  /**
   * Present ONLY when the document itself already saved successfully and the
   * SEPARATE write that appends this turn to resume_chats then failed. Two
   * writes with no shared transaction is an accepted limitation (see the
   * success path below) — but the result must not describe that as `error`:
   * every existing caller in this repo treats `error !== undefined` as "the
   * turn failed, offer a retry" (TailorPanel.tsx's own
   * `if (res.error !== undefined)` is the precedent), and a retried
   * add_bullet or propose_career_bullet against a change that ALREADY landed
   * would duplicate it. `selection`/`overrides`/`coverage`/`applied` above
   * and `messages` below all already reflect the real, saved outcome — this
   * field is only a signal that the transcript entry may not survive a
   * reload. Do not collapse this back into `error`.
   */
  transcriptSaveError?: string;
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
    if (Array.isArray(o.ruleRequests)) {
      const requests = o.ruleRequests.filter((r): r is string => typeof r === "string" && r !== "");
      if (requests.length > 0) msg.ruleRequests = requests;
    }
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

export async function sendChatTurn(jobId: string, message: string, geometry?: unknown): Promise<TurnResult> {
  const actor = await requireResumeAdmin();

  const threadRes = await readThread(actor.tenantId, jobId);
  if (threadRes.error !== undefined) {
    return {
      reply: "",
      applied: [],
      changedDocument: false,
      career: null,
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
      changedDocument: false,
      career: null,
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
      changedDocument: false,
      career: null,
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
      changedDocument: false,
      career: null,
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
      changedDocument: false,
      career: null,
      selection: context.selection,
      overrides: context.overrides,
      coverage: context.coverage,
      messages: priorMessages,
      error: NOT_TAILORED_REPLY,
    };
  }

  // `career` and `selection` here are ALREADY the effective document:
  // loadResumeContext runs effectiveDocument, so the record carries this
  // job's text overrides and any compress-after override, and the selection
  // carries taper/lead/per-role overrides. That is what the model is shown,
  // what operations validate against, and what a rejected turn returns
  // unchanged.
  const career = context.career;
  const currentSelection = context.selection;
  const overrides = context.overrides;

  const messagesForPrompt: ChatMessage[] = [...priorMessages, { role: "user", text: message }];

  const { system, prompt } = buildChatPrompt({
    career,
    vocabulary: themeVocabulary,
    themes: context.themes,
    selection: currentSelection,
    overrides,
    coverage: context.coverage,
    requirements: jobRes.job.requirements,
    niceToHaves: jobRes.job.niceToHaves,
    roleTitle: jobRes.job.roleTitle,
    company: jobRes.job.company,
    messages: messagesForPrompt,
    // Evaluated against the document as it stands BEFORE this turn, so the
    // model knows what it is already breaking rather than discovering it after
    // its own edit lands.
    houseFindings: evaluateHouseStyle(career, currentSelection),
    // Measured in the browser and validated here, never trusted: parseGeometry
    // refuses anything that is not a finite number in a sane range, because
    // this value is interpolated into a model prompt.
    geometry: parseGeometry(geometry),
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
      changedDocument: false,
      career: null,
      selection: currentSelection,
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
      changedDocument: false,
      career: null,
      selection: currentSelection,
      overrides,
      coverage: context.coverage,
      messages: priorMessages,
      error: budget.error,
    };
  }

  const { completion, failed } = budget.result!;
  if (failed !== undefined) {
    // Unlike the precondition refusals above, the model WAS invoked with the
    // user's message here — a network or rate-limit failure is exactly the
    // case the "a failed turn still persists" invariant is for, and it is
    // also the most retry-worthy of the four rejection shapes.
    const updated: StoredChatMessage[] = [
      ...priorMessages,
      { role: "user", text: message },
      { role: "assistant", text: failed },
    ];
    const persisted = await persistTurn(actor.tenantId, jobId, updated);
    return {
      reply: failed,
      applied: [],
      changedDocument: false,
      career: null,
      rejected: failed,
      selection: currentSelection,
      overrides,
      coverage: context.coverage,
      messages: persisted.error !== undefined ? priorMessages : updated,
      error: persisted.error,
    };
  }

  // Truncation is checked BEFORE parsing. The forced-tool path returns
  // JSON.stringify(toolBlock.input) regardless of how the call stopped, so a
  // response cut off at max_tokens still parses into a valid-LOOKING object
  // with operations silently missing — a turn like that is refused outright,
  // never partially applied.
  if (!isModelComplete(completion!.stopReason, true)) {
    const refusal = ["max_tokens", "MAX_TOKENS", "incomplete"].includes(completion!.stopReason ?? "")
      ? TRUNCATED_REPLY : UNREADABLE_REPLY;
    const updated: StoredChatMessage[] = [
      ...priorMessages,
      { role: "user", text: message },
      { role: "assistant", text: refusal },
    ];
    const persisted = await persistTurn(actor.tenantId, jobId, updated);
    return {
      reply: refusal,
      applied: [],
      changedDocument: false,
      career: null,
      rejected: refusal,
      selection: currentSelection,
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
      changedDocument: false,
      career: null,
      rejected: UNREADABLE_REPLY,
      selection: currentSelection,
      overrides,
      coverage: context.coverage,
      messages: persisted.error !== undefined ? priorMessages : updated,
      error: persisted.error,
    };
  }

  const result = applyOperations(parsed.operations, career, currentSelection, overrides, themeVocabulary);

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
      changedDocument: false,
      career: null,
      rejected: result.error,
      selection: currentSelection,
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

  // The record the new document renders against. effectiveCareer is run a
  // SECOND time, over the already-merged record from loadResumeContext with
  // no overlay and this turn's full text map: the overlay bullets are already
  // folded into `career` (so passing them again would duplicate them), and
  // re-applying a text override that was already applied is a no-op because
  // sanitizeBulletText is idempotent — verified in the final review's
  // three-boundary trace. Merging from the shipped record instead would need
  // a second settings read for the overlay on every turn.
  const { career: newCareer } = effectiveCareer(career, [], newOverrides.text || {});

  // set_themes re-derives the BASE selection, and the new base is what gets
  // stored. Without this the row keeps the themes the user just asked for
  // beside the selection the OLD themes produced — a document nobody asked
  // for, described by a coverage panel computed from the new themes, and
  // reproduced identically on every later page load. Overrides still layer on
  // top below, so a bullet the user picked by hand survives a theme change.
  // `|| currentSelection` is unreachable: a context with a non-null effective
  // selection always carries the base it was derived from, and this path
  // already returned early when the selection was null. It is here so the
  // type narrows without a cast.
  const newBase =
    result.themes !== undefined
      ? selectBullets(newCareer, { themes: newThemes })
      : context.baseSelection || currentSelection;

  const assistantMessage: StoredChatMessage = { role: "assistant", text: parsed.reply };
  if (result.overlayAdds && result.overlayAdds.length > 0) {
    assistantMessage.proposals = result.overlayAdds;
  }
  if (result.ruleRequests && result.ruleRequests.length > 0) {
    assistantMessage.ruleRequests = result.ruleRequests;
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
        { job_id: jobId, content: { themes: newThemes, selection: newBase, overrides: newOverrides } },
        { onConflict: "tenant_id,job_id" }
      );
    saveError = describeWriteFailure(error?.message, "save that tailored resume");
  }

  if (saveError !== undefined) {
    // The document did not durably change. The turn is still persisted —
    // omitting it entirely would silently discard the message the user just
    // typed, and after a reload they would see an empty box for it, which is
    // exactly the outcome the "a failed turn still persists" invariant
    // exists to prevent. What must NOT be persisted is `parsed.reply`: the
    // model's own text may describe a change ("Added it.") that never
    // landed, so a fixed sentence is used instead. Retrying this turn is
    // safe — nothing was applied, so a retried add_bullet/propose_career_bullet
    // cannot duplicate anything.
    const updated: StoredChatMessage[] = [
      ...priorMessages,
      { role: "user", text: message },
      { role: "assistant", text: SAVE_FAILED_REPLY },
    ];
    const persisted = await persistTurn(actor.tenantId, jobId, updated);
    if (persisted.error !== undefined) {
      console.error("sendChatTurn: could not persist the save-failure turn either —", persisted.error);
    }
    return {
      reply: SAVE_FAILED_REPLY,
      applied: [],
      changedDocument: false,
      career: null,
      rejected: SAVE_FAILED_REPLY,
      selection: currentSelection,
      overrides,
      coverage: context.coverage,
      messages: persisted.error !== undefined ? priorMessages : updated,
      error: saveError,
    };
  }

  // The new effective document — the stored base plus this turn's overrides,
  // re-derived through the SAME function loadResumeContext uses, so what this
  // turn reports and what the next reload renders cannot differ. Never
  // stored: tailored_resumes.content.selection above kept the unmerged base.
  const doc = effectiveDocument(newCareer, newBase, newThemes, newOverrides);

  // Coverage is recomputed here and never stored — tailored_resumes keeps
  // only what makes the document; the coverage panel is a read-time report.
  // Computed from doc.career/doc.selection rather than the pre-turn record,
  // so a set_themes turn can never describe a document that does not exist.
  const coverage = coverageReport(doc.career, newThemes, doc.selection, themeVocabulary);

  // The document already saved successfully above — a failure of THIS write
  // (appending the turn to resume_chats) must not be reported as `error`:
  // every existing caller in this repo treats `error !== undefined` as "the
  // turn failed, retry it" (TailorPanel.tsx's own `if (res.error !== undefined)`
  // is the precedent), and retrying an already-applied add_bullet or
  // propose_career_bullet would duplicate it. `messages` still reflects this
  // turn — the conversation genuinely happened — `transcriptSaveError` is
  // only a signal that it may not survive a reload.
  const persisted = await persistTurn(actor.tenantId, jobId, updated);

  return {
    reply: parsed.reply,
    applied: result.applied ?? [],
    changedDocument: result.changedDocument === true,
    career: doc.career,
    selection: doc.selection,
    overrides: newOverrides,
    coverage,
    messages: updated,
    transcriptSaveError: persisted.error,
    // Evaluated against the document this turn PRODUCED, so a change that
    // broke a rule is reported with the change rather than discovered on the
    // next turn. Same argument as coverage above: computed from
    // doc.career/doc.selection, never the pre-turn record.
    houseFindings: evaluateHouseStyle(doc.career, doc.selection),
  };
}

export async function loadChatThread(jobId: string): Promise<{ messages: StoredChatMessage[]; error?: string }> {
  const actor = await requireResumeAdmin();
  return readThread(actor.tenantId, jobId);
}

/** The tailored_resumes row as stored, read directly rather than through
 *  app/actions/resume.ts's getTailoredResume: acceptProposedBullets needs the
 *  UNMERGED base to write back, and importing another "use server" module's
 *  export for it would make this file's import graph load-bearing for a
 *  single query shape. Repairs the row rather than trusting it — a row
 *  written before `overrides` existed has no such key. */
async function readTailoredRow(
  tenantId: string,
  jobId: string
): Promise<{ themes: string[]; selection: ResumeSelection | null; overrides: ResumeOverrides; error?: string }> {
  const { data, error } = await supabase
    .forTenant(tenantId)
    .from("tailored_resumes")
    .select("content")
    .eq("job_id", jobId)
    .maybeSingle();
  if (error) {
    console.error("resume-chat readTailoredRow error:", error);
    return {
      themes: [],
      selection: null,
      overrides: {},
      error: describeWriteFailure(error.message, "load that tailored resume"),
    };
  }
  const content = (data as { content?: unknown } | null)?.content as
    | { themes?: unknown; selection?: unknown; overrides?: unknown }
    | undefined;
  if (!content || !content.selection || typeof content.selection !== "object") {
    return { themes: [], selection: null, overrides: {} };
  }
  return {
    themes: Array.isArray(content.themes) ? (content.themes as string[]) : [],
    selection: content.selection as ResumeSelection,
    overrides: (content.overrides as ResumeOverrides) || {},
  };
}

/**
 * The accepted bullet is written to the career overlay AND placed on the
 * page. Placing it is the difference between the feature working and the
 * user clicking Accept, watching the button vanish, and seeing nothing change
 * anywhere — before this, the new `ov-*` id was in the record's pool but in
 * no selection, so render.js drew it nowhere, on this screen or after a
 * reload, until some later turn happened to add_bullet it.
 */
export async function acceptProposedBullets(
  jobId: string,
  ids: string[]
): Promise<{
  career?: CareerRecord;
  selection?: ResumeSelection;
  overrides?: ResumeOverrides;
  coverage?: CoverageReport;
  error?: string;
}> {
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
  // readAllSettingsResult is a TRANSPORT (lib/settings-store.ts:371-384) —
  // it passes the driver's message through verbatim, empty string included —
  // so the reader here must describe it, the same as the other two DB reads
  // in this file (readThread, loadJobFields).
  if (rowsResult.error !== undefined) {
    return { error: describeWriteFailure(rowsResult.error, "load your career overlay") };
  }
  const overlay = careerOverlayFrom(rowsResult.rows);
  const existingIds = new Set(overlay.map((b) => b.id));

  // Idempotent: an id already in the overlay (a double accept) is skipped
  // rather than duplicated.
  const toAdd = requested.filter((id) => !existingIds.has(id)).map((id) => byId.get(id) as OverlayBullet);
  if (toAdd.length === 0) return {};

  const nextOverlay = overlay.concat(toAdd);
  const writeRes = await writeCareerOverlay(nextOverlay);
  const overlayError = describeWriteFailure(writeRes.error, "save the accepted bullet");
  if (overlayError !== undefined) return { error: overlayError };

  // The bullet is in the record now; put it on the page. A failure from here
  // on is reported, but the accept itself already landed — which is why the
  // overlay write is what gates `error` above.
  const stored = await readTailoredRow(actor.tenantId, jobId);
  if (stored.error !== undefined) return { error: stored.error };
  // Nothing tailored yet (or a row too old to read): the bullet is in the
  // pool and the next Tailor will consider it. Nothing to place.
  if (!stored.selection) return {};

  const { career: merged } = effectiveCareer(
    shippedCareer as CareerRecord,
    nextOverlay,
    stored.overrides.text || {}
  );
  const before = effectiveDocument(merged, stored.selection, stored.themes, stored.overrides);

  // Absolute lists, appended to what is on the page right now — the same
  // shape lib/resume-ops.ts's add_bullet writes, so nothing downstream can
  // tell the two apart.
  const nextOverrides: ResumeOverrides = {
    ...stored.overrides,
    selection: { ...(stored.overrides.selection || {}), bullets: { ...(stored.overrides.selection?.bullets || {}) } },
  };
  toAdd.forEach((b) => {
    const current = nextOverrides.selection!.bullets![b.roleId] || before.selection.bullets[b.roleId] || [];
    if (current.indexOf(b.id) === -1) {
      nextOverrides.selection!.bullets![b.roleId] = current.concat([b.id]);
    }
  });

  const { error: saveError } = await supabase
    .forTenant(actor.tenantId)
    .from("tailored_resumes")
    .upsert(
      { job_id: jobId, content: { themes: stored.themes, selection: stored.selection, overrides: nextOverrides } },
      { onConflict: "tenant_id,job_id" }
    );
  const described = describeWriteFailure(saveError?.message, "place the accepted bullet on the page");
  if (described !== undefined) return { error: described };

  const after = effectiveDocument(merged, stored.selection, stored.themes, nextOverrides);
  return {
    career: after.career,
    selection: after.selection,
    overrides: nextOverrides,
    coverage: coverageReport(after.career, stored.themes, after.selection, themeVocabulary),
  };
}
