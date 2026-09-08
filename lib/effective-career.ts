/**
 * The ONE record everything downstream sees.
 *
 * There are no override "layers" threaded through the renderer, and that is
 * deliberate: renderBody runs on the CLIENT, from a vendored file, and
 * app/resume/page.tsx used to hand it the record imported statically from
 * content/resume.json. Any override the server knew about and that record did
 * not would silently fail to render — render.js:145 resolves ids against the
 * record and .filter(Boolean) drops what it cannot find, and :146 drops the
 * whole ROLE when nothing survives. So the server merges once, up front, and
 * selectBullets, renderBody and coverage all operate on the result.
 *
 * Every returned object is fresh. The shipped record is a module-level import
 * shared for the life of the process, so mutating it would corrupt every later
 * request — the hazard resolveProfile records for DEFAULT_PROFILE.
 */
import { sanitizeBulletText } from "@/lib/resume-text";
import type { CareerRecord } from "@/lib/resume-render/render";
import type { OverlayBullet } from "@/lib/settings-store";

export interface TextOverrides {
  [target: string]: string;
}

function cleaned(text: string): string | null {
  const res = sanitizeBulletText(text);
  return res.text === undefined ? null : res.text;
}

export function effectiveCareer(
  shipped: CareerRecord,
  overlay: OverlayBullet[],
  text: TextOverrides
): { career: CareerRecord; warnings: string[] } {
  const warnings: string[] = [];
  const roleIds: Record<string, true> = {};
  shipped.roles.forEach((r) => {
    roleIds[r.id] = true;
  });

  overlay.forEach((b) => {
    if (!roleIds[b.roleId]) {
      // Surfaced, not silent: after a record change this is the user's own text
      // disappearing, and they are the only one who can decide what to do.
      warnings.push('An added bullet refers to a role that no longer exists ("' + b.roleId + '").');
    }
  });

  const career: CareerRecord = {
    ...shipped,
    positioning: shipped.positioning.map((p) => ({ ...p })),
    roles: shipped.roles.map((role) => {
      const own = role.bullets.map((b) => {
        const override = text["bullet:" + role.id + ":" + b.id];
        if (override === undefined) return { ...b };
        const safe = cleaned(override);
        if (safe === null) return { ...b };
        return { ...b, text: safe, edited: true };
      });
      const added = overlay
        .filter((o) => o.roleId === role.id)
        .map((o) => {
          // An overlay id colliding with a RECORD bullet id in the same role is not
          // merely cosmetic: render.js's own lookup (role.bullets.filter(b => b.id
          // === id)[0]) resolves the FIRST match by array order, and own.concat(added)
          // always puts overlay entries last — so a colliding overlay bullet can never
          // be selected or rendered, however "successfully" it merged into this
          // object graph. Hand-verified against render.js's actual selectBullets: an
          // anchor-id collision happens to be self-healing there (the priority-1
          // anchor is unconditionally re-added after pool exclusion, and a stable
          // sort keeps the ORIGINAL bullet — first in own.concat(added) — as that
          // anchor), so it degrades no further than "the collider is unreachable".
          // A collision on a NON-anchor id is worse: the pool-exclusion filter
          // (role.bullets.filter(b => b.id !== anchor.id)) only strips entries
          // matching the ANCHOR's id, so an undropped duplicate of a different
          // bullet's id sits in the pool next to the real one, both can be
          // selected, and selectBullets returns the same id TWICE — which
          // renderBody's id lookup resolves to the same original bullet twice,
          // rendering one line twice and wasting a bullet slot that should have
          // gone to something else. Namespacing overlay ids so neither case can
          // happen is Task 10's job at write time (fresh `ov-*` ids can't collide
          // with a shipped record); this check is the redundant second boundary for
          // a row reachable another way — a hand-edited app_settings row, or a
          // future content/resume.json edit that reuses an old bullet id — the same
          // defence-in-depth reasoning that runs sanitizeBulletText at three
          // separate boundaries. Drop the collider rather than warn-and-keep: an
          // unreachable (or slot-wasting) bullet nobody was told about is exactly
          // the silent-loss failure mode this whole function exists to avoid.
          if (role.bullets.some((b) => b.id === o.id)) {
            warnings.push(
              'An added bullet was not included because its id ("' +
                o.id +
                '") already exists on role "' +
                role.id +
                '".'
            );
            return null;
          }
          const safe = cleaned(o.text);
          if (safe === null) return null;
          return {
            id: o.id,
            priority: o.priority == null ? 90 : o.priority,
            themes: o.themes,
            text: safe,
            origin: "overlay" as const,
          };
        })
        .filter((b): b is NonNullable<typeof b> => b !== null);
      return { ...role, bullets: own.concat(added as typeof own) };
    }),
  };

  Object.keys(text).forEach((target) => {
    if (target.indexOf("bullet:") !== 0) return;
    const parts = target.split(":");
    const role = career.roles.filter((r) => r.id === parts[1])[0];
    if (!role || !role.bullets.some((b) => b.id === parts[2])) {
      warnings.push('An edit refers to a bullet that no longer exists ("' + parts[2] + '").');
    }
  });

  if (text.summary !== undefined && career.positioning[0]) {
    const safe = cleaned(text.summary);
    if (safe !== null) career.positioning.forEach((p) => (p.summary = safe));
  }
  if (text.positioning !== undefined && career.positioning[0]) {
    const safe = cleaned(text.positioning);
    if (safe !== null) career.positioning.forEach((p) => (p.tagline = safe));
  }

  return { career, warnings };
}
