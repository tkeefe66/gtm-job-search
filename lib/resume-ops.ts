/**
 * The trust boundary between what the model proposes and what the document
 * becomes. The chat model (app/actions/resume-chat.ts, Task 12) returns a
 * JSON array of operations; nothing here trusts an id, a token name, or a
 * value merely because the model emitted it — every one is checked against
 * the CAREER RECORD, the CURRENT SELECTION, the THEME VOCABULARY, or the
 * design-token allowlist, and text goes through the one sanitizer boundary
 * (lib/resume-text.ts) before it can reach the document.
 *
 * A turn is ATOMIC: every operation in the array is validated against the
 * ORIGINAL, unmodified inputs before any of them is applied. If any one
 * operation fails, applyOperations returns `{ error }` and nothing else —
 * no partial `overrides`, no partial `themes`. A half-applied turn would
 * leave the document, the coverage panel and the persisted transcript each
 * describing a different state, and the user has no way to tell which half
 * happened. Because validation never depends on another operation's effect
 * (role/bullet pools, the vocabulary, the token allowlist and the selection
 * are all fixed for the whole turn), validating everything first and only
 * then applying is exact, not an approximation of atomicity.
 */
import { randomBytes } from "node:crypto";
import { sanitizeBulletText } from "@/lib/resume-text";
import { parseTokenValue, parsePageMargin } from "@/lib/resume-design-tokens";
import type { ResumeOverrides } from "@/lib/resume-overrides";
import type { OverlayBullet } from "@/lib/settings-store";
import type { CareerRecord, ResumeRole, ResumeSelection, ThemeVocabulary } from "@/lib/resume-render/render";

export interface Operation {
  op: string;
  [k: string]: unknown;
}

export interface ApplyResult {
  overrides?: ResumeOverrides;
  themes?: string[];
  overlayAdds?: OverlayBullet[];
  ruleRequests?: string[];
  applied?: string[];
  /**
   * Whether this turn changed the DOCUMENT, as opposed to merely running an
   * operation. `applied` conflates the two: `request_rule_change` and
   * `propose_career_bullet` both push a line into it while the rendered
   * document is byte-identical afterwards. A caller that re-renders on
   * `applied.length > 0` therefore re-sets dangerouslySetInnerHTML — which
   * discards the user's unsaved contentEditable hand edits — for a turn that
   * changed nothing. Decided HERE, next to the operations themselves, rather
   * than by pattern-matching the transcript strings in the client.
   */
  changedDocument?: boolean;
  error?: string;
}

/**
 * ONE flat object, not a 13-branch `anyOf` keyed on `op`. This schema is
 * passed straight through as the model tool's `input_schema`
 * (lib/providers/anthropic.ts:85) — the API only checks that a call's input
 * has the right SHAPE, never whether it is legal, and legality is entirely
 * this module's job regardless of how tightly the schema is carved into
 * per-operation branches. A nested union here would buy no extra safety
 * (every branch still needs the same runtime checks against the career
 * record, the vocabulary, the current selection and the token allowlist
 * that `applyOperations` already does) while costing something real: a
 * large `anyOf`/`oneOf` tool schema is harder for the model to reliably
 * satisfy than one flat object with every field marked optional, so the
 * union would only produce more malformed calls for `applyOperations` to
 * reject. Every field used by any operation is declared here as optional;
 * `applyOperations` alone decides which combination is coherent for a
 * given `op`.
 */
export const OPERATION_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    reply: {
      type: "string",
      description: "The conversational reply shown to the user in the chat transcript.",
    },
    operations: {
      type: "array",
      description: "Zero or more document operations to apply, in order.",
      items: {
        type: "object",
        properties: {
          op: {
            type: "string",
            enum: [
              "set_themes",
              "add_bullet",
              "drop_bullet",
              "swap_bullet",
              "set_lead",
              "set_positioning",
              "set_taper",
              "set_compress_after",
              "set_text",
              "propose_career_bullet",
              "set_design_token",
              "set_page_margin",
              "reset_design",
              "request_rule_change",
            ],
          },
          themes: { type: "array", items: { type: "string" } },
          roleId: { type: "string" },
          bulletId: { type: "string" },
          outId: { type: "string" },
          inId: { type: "string" },
          target: { type: "string" },
          text: { type: "string" },
          name: { type: "string" },
          value: { type: "string" },
          taper: { type: "array", items: { type: "integer" } },
          n: { type: "integer" },
          positioningId: { type: "string" },
          description: { type: "string" },
        },
        required: ["op"],
      },
    },
  },
  required: ["reply", "operations"],
};

function findRole(career: CareerRecord, roleId: unknown): ResumeRole | undefined {
  if (typeof roleId !== "string") return undefined;
  return career.roles.filter((r) => r.id === roleId)[0];
}

function roleError(roleId: unknown): string {
  return 'There is no role "' + String(roleId) + '" in the career record.';
}

function bulletInPool(role: ResumeRole, bulletId: unknown): boolean {
  return typeof bulletId === "string" && role.bullets.some((b) => b.id === bulletId);
}

function bulletPoolError(bulletId: unknown, role: ResumeRole): string {
  return '"' + String(bulletId) + '" is not a bullet on role "' + role.id + '".';
}

/** Shared by `set_themes` and `propose_career_bullet` — both take a list of
 *  theme ids that must exist in the tenant's own vocabulary. */
function invalidThemeId(vocabulary: ThemeVocabulary, themes: unknown): string | undefined {
  if (!Array.isArray(themes) || themes.length === 0) {
    return "That needs a non-empty list of theme ids.";
  }
  const validIds = vocabulary.themes.map((t) => t.id);
  for (const id of themes) {
    if (typeof id !== "string" || validIds.indexOf(id) === -1) {
      return '"' + String(id) + '" is not a theme in this vocabulary.';
    }
  }
  return undefined;
}

function isNonNegativeInteger(n: unknown): n is number {
  return typeof n === "number" && Number.isInteger(n) && n >= 0;
}

/**
 * `set_text`'s target names either a fixed slot (`summary`, `positioning`)
 * or `bullet:<roleId>:<bulletId>`. Parsing is shared between validation and
 * apply so the two can never read the target differently.
 */
function parseBulletTarget(target: unknown): { roleId: string; bulletId: string } | undefined {
  if (typeof target !== "string") return undefined;
  const parts = target.split(":");
  if (parts.length !== 3 || parts[0] !== "bullet" || !parts[1] || !parts[2]) return undefined;
  return { roleId: parts[1], bulletId: parts[2] };
}

/**
 * `selection.bullets` (render.js:40, `const bullets = {}`) is a PLAIN object
 * literal keyed by role id, and `roleId` here can be the unvalidated role
 * segment of a model-supplied `set_text` target — `parseBulletTarget` only
 * checks the target's SHAPE, not that the role named in it is real. A bare
 * `selection.bullets[roleId]` for a role id like "constructor", "toString",
 * "hasOwnProperty" or "__proto__" resolves the INHERITED Object.prototype
 * member instead of `undefined` — an object or function, which is truthy —
 * so `|| []` never engages and the caller's `.indexOf` throws on a
 * non-array. `Object.prototype.hasOwnProperty.call` is the guard: it asks
 * whether the object OWNS that key, ignoring anything inherited, so every
 * one of those four names correctly reads as "this role has no bullets"
 * (an empty array) instead of crashing. */
function bulletsFor(bulletsByRole: Record<string, string[]>, roleId: string): string[] {
  return Object.prototype.hasOwnProperty.call(bulletsByRole, roleId) ? bulletsByRole[roleId] : [];
}

/** Validates one operation against the ORIGINAL, unmodified inputs — never
 *  against anything an earlier operation in the same turn produced. */
function validateOperation(
  op: Operation,
  career: CareerRecord,
  selection: ResumeSelection,
  vocabulary: ThemeVocabulary
): string | undefined {
  switch (op.op) {
    case "set_themes": {
      return invalidThemeId(vocabulary, op.themes);
    }
    case "add_bullet":
    case "drop_bullet": {
      const role = findRole(career, op.roleId);
      if (!role) return roleError(op.roleId);
      if (!bulletInPool(role, op.bulletId)) return bulletPoolError(op.bulletId, role);
      return undefined;
    }
    case "set_lead": {
      const role = findRole(career, op.roleId);
      if (!role) return roleError(op.roleId);
      if (!bulletInPool(role, op.bulletId)) return bulletPoolError(op.bulletId, role);
      // The lead bullet is the FIRST role's first line and nothing else:
      // render.js:73-79 honours opts.lead only at role index 0, and
      // lib/effective-document.ts's withLead reorders that one role. A lead
      // named on any other role would validate, bill, and be reported as
      // applied while changing nothing — the exact class of dishonesty the
      // whole wiring pass exists to end — so it is refused with the reason.
      const first = career.roles[0];
      if (first && role.id !== first.id) {
        return 'The lead bullet has to come from "' + first.id + '", the most recent role.';
      }
      return undefined;
    }
    case "swap_bullet": {
      const role = findRole(career, op.roleId);
      if (!role) return roleError(op.roleId);
      if (!bulletInPool(role, op.outId)) return bulletPoolError(op.outId, role);
      if (!bulletInPool(role, op.inId)) return bulletPoolError(op.inId, role);
      return undefined;
    }
    case "set_positioning": {
      const id = op.positioningId;
      if (typeof id !== "string" || !career.positioning.some((p) => p.id === id)) {
        return '"' + String(id) + '" is not a positioning variant in the career record.';
      }
      return undefined;
    }
    case "set_taper": {
      const taper = op.taper;
      if (!Array.isArray(taper) || taper.length === 0 || !taper.every(isNonNegativeInteger)) {
        return "A taper needs a list of non-negative whole numbers.";
      }
      return undefined;
    }
    case "set_compress_after": {
      const n = op.n;
      if (!isNonNegativeInteger(n) || n > career.roles.length) {
        return (
          "Compress-after needs a whole number from 0 to " + career.roles.length + " (the number of roles)."
        );
      }
      return undefined;
    }
    case "set_text": {
      const target = op.target;
      if (target !== "summary" && target !== "positioning") {
        const parsed = parseBulletTarget(target);
        if (!parsed) return '"' + String(target) + '" is not a valid text target.';
        const onPage = bulletsFor(selection.bullets, parsed.roleId).indexOf(parsed.bulletId) !== -1;
        if (!onPage) {
          return '"' + target + '" is not on the page — it is not part of the current selection.';
        }
      }
      return sanitizeBulletText(String(op.text ?? "")).error;
    }
    case "propose_career_bullet": {
      const role = findRole(career, op.roleId);
      if (!role) return roleError(op.roleId);
      const themeErr = invalidThemeId(vocabulary, op.themes);
      if (themeErr) return themeErr;
      return sanitizeBulletText(String(op.text ?? "")).error;
    }
    case "set_design_token": {
      if (typeof op.name !== "string") return "A design token needs a name.";
      return parseTokenValue(op.name, String(op.value ?? "")).error;
    }
    case "set_page_margin": {
      return parsePageMargin(String(op.value ?? "")).error;
    }
    case "reset_design": {
      return undefined;
    }
    case "request_rule_change": {
      if (typeof op.description !== "string" || op.description.trim() === "") {
        return "A rule-change request needs a description.";
      }
      return undefined;
    }
    default:
      return '"' + String(op.op) + '" is not an operation I know how to do.';
  }
}

function cloneOverrides(overrides: ResumeOverrides): ResumeOverrides {
  return {
    ...overrides,
    selection: overrides.selection
      ? {
          ...overrides.selection,
          taper: overrides.selection.taper ? overrides.selection.taper.slice() : undefined,
          bullets: overrides.selection.bullets
            ? Object.keys(overrides.selection.bullets).reduce<Record<string, string[]>>((acc, roleId) => {
                acc[roleId] = overrides.selection!.bullets![roleId].slice();
                return acc;
              }, {})
            : undefined,
        }
      : undefined,
    text: overrides.text ? { ...overrides.text } : undefined,
    design: overrides.design ? { ...overrides.design } : undefined,
  };
}

/**
 * `roleId` reaches here only after `validateOperation` has already matched
 * it against a real `career.roles[].id` via `findRole`'s equality check, so
 * in practice it can never be "constructor"/"toString"/etc. The
 * `hasOwnProperty` guard is applied anyway rather than relying on that
 * invariant holding forever: this function has no way to see whether its
 * caller validated `roleId`, and a bare bracket read on either plain object
 * below would reproduce exactly the Finding-1 crash if that ever changed.
 */
function bulletListFor(draft: ResumeOverrides, selection: ResumeSelection, roleId: string): string[] {
  const draftBullets = draft.selection?.bullets;
  if (draftBullets && Object.prototype.hasOwnProperty.call(draftBullets, roleId)) {
    return draftBullets[roleId];
  }
  return bulletsFor(selection.bullets, roleId).slice();
}

function setBulletList(draft: ResumeOverrides, roleId: string, list: string[]): void {
  draft.selection = draft.selection || {};
  draft.selection.bullets = draft.selection.bullets || {};
  draft.selection.bullets[roleId] = list;
}

/** `ov-` plus 8 random hex characters. The prefix alone makes collision with
 *  a RECORD bullet id impossible (nothing in content/resume.json is
 *  namespaced this way); collision with an EXISTING overlay id — which does
 *  share the prefix — is made practically impossible by 32 bits of entropy
 *  per id, and `taken` additionally rules out a collision with another
 *  bullet proposed in the SAME turn, which is the one case pure randomness
 *  does not cover for free. */
function newOverlayId(taken: Record<string, true>): string {
  let id = "ov-" + randomBytes(4).toString("hex");
  while (taken[id]) {
    id = "ov-" + randomBytes(4).toString("hex");
  }
  taken[id] = true;
  return id;
}

export function applyOperations(
  ops: Operation[],
  career: CareerRecord,
  selection: ResumeSelection,
  overrides: ResumeOverrides,
  vocabulary: ThemeVocabulary
): ApplyResult {
  // Phase 1: validate every operation against the ORIGINAL inputs. Nothing
  // is applied yet, so a later operation can never be validated against an
  // earlier one's effect.
  for (const op of ops) {
    // `ops` is typed as `Operation[]`, but it is really whatever JSON the
    // model returned — a literal `null` (or any other non-object) element
    // passes the type checker and then throws on `op.op` inside
    // `validateOperation`'s `switch`. A string, a number, or an array
    // already degrade cleanly (property access on them yields `undefined`,
    // which the `default` case below reports), so only null/undefined
    // actually need to be turned away here — but every non-object shape is
    // rejected the same way for one clean error rather than three
    // accidental ones.
    if (typeof op !== "object" || op === null) {
      return { error: '"' + String(op) + '" is not something I can read as an operation.' };
    }
    const err = validateOperation(op, career, selection, vocabulary);
    if (err) return { error: err };
  }

  // Phase 2: apply. Every operation already proved legal above, so nothing
  // here can fail.
  const draft = cloneOverrides(overrides);
  let themes: string[] | undefined;
  const overlayAdds: OverlayBullet[] = [];
  const ruleRequests: string[] = [];
  const applied: string[] = [];
  const takenOverlayIds: Record<string, true> = {};
  // Every operation except these two changes what renders. `reset_design` is
  // deliberately on the changing side even when there was nothing to reset —
  // it writes the overrides object, and a caller re-rendering an unchanged
  // document is harmless where the reverse is not.
  const NO_DOCUMENT_CHANGE: Record<string, true> = {
    request_rule_change: true,
    propose_career_bullet: true,
  };
  let changedDocument = false;

  ops.forEach((op) => {
    // hasOwnProperty, not a bare bracket read: this file's own convention for
    // every lookup on a plain object keyed by model-supplied text.
    if (!Object.prototype.hasOwnProperty.call(NO_DOCUMENT_CHANGE, op.op)) changedDocument = true;
    switch (op.op) {
      case "set_themes": {
        themes = (op.themes as string[]).slice();
        applied.push("set themes: " + themes.join(", "));
        break;
      }
      case "add_bullet": {
        const roleId = op.roleId as string;
        const bulletId = op.bulletId as string;
        const list = bulletListFor(draft, selection, roleId);
        if (list.indexOf(bulletId) === -1) list.push(bulletId);
        setBulletList(draft, roleId, list);
        applied.push("added bullet " + bulletId + " to " + roleId);
        break;
      }
      case "drop_bullet": {
        const roleId = op.roleId as string;
        const bulletId = op.bulletId as string;
        const list = bulletListFor(draft, selection, roleId).filter((id) => id !== bulletId);
        setBulletList(draft, roleId, list);
        applied.push("dropped bullet " + bulletId + " from " + roleId);
        break;
      }
      case "swap_bullet": {
        const roleId = op.roleId as string;
        const outId = op.outId as string;
        const inId = op.inId as string;
        if (outId === inId) {
          // A no-op, not a reorder: list order IS render order (render.js
          // renders a role's bullets in the order selection.bullets[roleId]
          // lists them), and filter-then-push below would remove `outId`
          // and re-append it at the END of the list — moving a bullet the
          // model asked to "swap for itself" to a different position with
          // no textual change to explain why. Treating it as a genuine
          // no-op (leave the list untouched) is chosen over rejecting the
          // operation outright, since naming the same bullet on both sides
          // is a harmless, if pointless, request rather than a malformed one.
          applied.push(outId + " is already in place on " + roleId + " — no change made");
          break;
        }
        const list = bulletListFor(draft, selection, roleId).filter((id) => id !== outId);
        if (list.indexOf(inId) === -1) list.push(inId);
        setBulletList(draft, roleId, list);
        applied.push("swapped " + outId + " for " + inId + " on " + roleId);
        break;
      }
      case "set_lead": {
        const bulletId = op.bulletId as string;
        draft.selection = draft.selection || {};
        draft.selection.lead = bulletId;
        applied.push("set lead bullet to " + bulletId);
        break;
      }
      case "set_positioning": {
        const positioningId = op.positioningId as string;
        draft.selection = draft.selection || {};
        draft.selection.positioning = positioningId;
        applied.push("set positioning to " + positioningId);
        break;
      }
      case "set_taper": {
        const taper = (op.taper as number[]).slice();
        draft.selection = draft.selection || {};
        draft.selection.taper = taper;
        // A taper re-derives the selection, but a role with an explicit
        // per-role bullet list keeps that list (lib/effective-document.ts's
        // rule 2, deliberate — truncating would delete a bullet the user
        // named). Silence about that reads as a taper that half worked, so
        // the line says which roles it does not reach.
        const exempt = Object.keys(draft.selection.bullets || {});
        applied.push(
          "set taper to " +
            taper.join(", ") +
            (exempt.length
              ? " — these roles keep the bullets you picked by hand: " + exempt.join(", ")
              : "")
        );
        break;
      }
      case "set_compress_after": {
        const n = op.n as number;
        draft.selection = draft.selection || {};
        draft.selection.compressAfter = n;
        applied.push("set compress-after to " + n);
        break;
      }
      case "set_text": {
        const target = op.target as string;
        const safe = sanitizeBulletText(String(op.text ?? "")).text as string;
        draft.text = draft.text || {};
        draft.text[target] = safe;
        applied.push("edited text: " + target);
        break;
      }
      case "propose_career_bullet": {
        const roleId = op.roleId as string;
        const themesArg = (op.themes as string[]).slice();
        const safe = sanitizeBulletText(String(op.text ?? "")).text as string;
        const id = newOverlayId(takenOverlayIds);
        overlayAdds.push({ id, roleId, text: safe, themes: themesArg });
        applied.push("proposed a new bullet for " + roleId);
        break;
      }
      case "set_design_token": {
        const name = op.name as string;
        const value = parseTokenValue(name, String(op.value ?? "")).value as string;
        draft.design = draft.design || {};
        draft.design[name] = value;
        applied.push("set " + name + " to " + value);
        break;
      }
      case "set_page_margin": {
        const value = parsePageMargin(String(op.value ?? "")).value as string;
        draft.pageMargin = value;
        applied.push("set page margin to " + value);
        break;
      }
      case "reset_design": {
        delete draft.design;
        delete draft.pageMargin;
        applied.push("reset design overrides");
        break;
      }
      case "request_rule_change": {
        const description = (op.description as string).trim();
        ruleRequests.push(description);
        applied.push("requested: " + description);
        break;
      }
      default:
        // Unreachable: validateOperation already rejected any other op.op.
        break;
    }
  });

  return {
    overrides: draft,
    themes,
    overlayAdds: overlayAdds.length ? overlayAdds : undefined,
    ruleRequests: ruleRequests.length ? ruleRequests : undefined,
    applied,
    changedDocument,
  };
}
