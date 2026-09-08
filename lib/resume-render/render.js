/**
 * render.js — the render half of the Tom Keefe résumé design system.
 *
 * Pure functions, no dependencies, no DOM. Works in Node and in the browser.
 *
 *   const { selectBullets, renderResume } = require('./render.js');
 *   const career = require('./content/career.json');
 *   const selection = selectBullets(career, { themes: ['systems', 'data'] });
 *   const html = renderResume(career, selection);
 *
 * The application decides WHICH bullets survive; this file decides how they are
 * marked up. Never hand-build .rsm markup in the application — the class
 * contract lives here so a change to the system reaches every consumer.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ResumeRender = api;
})(typeof self !== 'undefined' ? self : this, function () {
  const esc = (s) => String(s).replace(/&(?!(amp|lt|gt|quot|#\d+);)/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  /**
   * Score and pick bullets per role against a set of themes, respecting the taper.
   * Returns { positioningId, bullets: { roleId: [bulletId, ...] } }.
   *
   * opts.themes      — themes to favour, most important first
   * opts.taper       — per-role bullet caps; defaults to career.rules.taper
   * opts.positioning — force a positioning id; otherwise the best theme match wins
   * opts.lead        — bullet id to force into first position on the first role
   */
  function selectBullets(career, opts) {
    opts = opts || {};
    const themes = opts.themes || [];
    const taper = opts.taper || (career.rules && career.rules.taper) || [];
    const weight = (b) => {
      let w = 0;
      themes.forEach((t, i) => { if ((b.themes || []).indexOf(t) !== -1) w += themes.length - i; });
      return w;
    };
    const bullets = {};
    career.roles.forEach((role, i) => {
      // taper is positional; a role beyond the taper array inherits the last cap (never uncapped,
      // so adding a new current role can't silently give an ancient job a full bullet set)
      const cap = taper.length ? (taper[i] == null ? taper[taper.length - 1] : taper[i]) : role.bullets.length;
      // The priority-1 bullet is an anchor: it always survives if the role appears at all. Without this,
      // theme scoring on a deep pool can drop a role's headline claim (e.g. the $50M+ revenue bullet)
      // in favour of several on-theme but weaker lines.
      const byPriority = role.bullets.slice().sort((a, b) => (a.priority || 99) - (b.priority || 99));
      const anchor = byPriority[0];
      const pool = anchor ? role.bullets.filter((b) => b.id !== anchor.id) : role.bullets;
      const scored = pool.slice().sort((a, b) => {
        const d = weight(b) - weight(a);
        return d !== 0 ? d : (a.priority || 99) - (b.priority || 99);
      }).slice(0, Math.max(0, cap - (anchor ? 1 : 0)));
      // DIVERGENCE from the vendored TK Resume Design System, 2026-09-07.
      // Was: .sort by priority alone, which forced the priority-1 anchor to
      // index 0 in every role. Surviving and LEADING are two different
      // guarantees and only survival was intended (see the anchor comment
      // above) — so a role's headline claim led even on a posting it had no
      // signal for. Now: tail bullets always sink, and the rest rank by theme
      // weight with priority as the tie-break. The anchor's guaranteed
      // INCLUSION at the lines above is untouched; it loses only its forced
      // first position. A weight-first sort WITHOUT the tail rule promotes
      // award bullets (principal p6, sr-director p9) to the top of a role,
      // which is why both halves are here.
      const byRank = (a, b) => {
        if (!!a.tail !== !!b.tail) return a.tail ? 1 : -1;
        if (a.tail && b.tail) return (a.priority || 99) - (b.priority || 99);
        const d = weight(b) - weight(a);
        return d !== 0 ? d : (a.priority || 99) - (b.priority || 99);
      };
      const ranked = (anchor ? [anchor].concat(scored) : scored).sort(byRank);
      if (i === 0 && opts.lead) {
        const led = role.bullets.filter((b) => b.id === opts.lead);
        if (led.length) {
          const rest = ranked.filter((b) => b.id !== opts.lead).slice(0, Math.max(0, cap - 1));
          ranked.length = 0;
          ranked.push(led[0], ...rest);
        }
      }
      bullets[role.id] = ranked.map((b) => b.id);
    });
    let positioningId = opts.positioning;
    if (!positioningId) {
      const scored = (career.positioning || []).map((p) => ({ id: p.id, w: (p.themes || []).reduce((s, t) => s + (themes.indexOf(t) !== -1 ? themes.length - themes.indexOf(t) : 0), 0) }));
      scored.sort((a, b) => b.w - a.w);
      positioningId = scored.length ? scored[0].id : null;
    }
    return { positioningId, bullets };
  }

  /** Year span from a date range: 'June 2018 – July 2019' -> '2018 – 2019'. Compressed rows show years only. */
  function yearsOf(dates) {
    const years = String(dates || '').match(/\d{4}/g);
    if (!years) return String(dates || '').indexOf('Present') !== -1 ? 'Present' : '';
    const last = String(dates).indexOf('Present') !== -1 ? 'Present' : years[years.length - 1];
    return years[0] === last ? years[0] : years[0] + ' \u2013 ' + last;
  }

  /**
   * Collapse runs of consecutive compressed roles at the same employer into one row: successive titles
   * at one company read as padding on a résumé's tail. Keeps the most recent (most senior) title and
   * spans the full range of years across the run.
   */
  function mergeSameOrg(rows) {
    const out = [];
    rows.forEach((r) => {
      const prev = out[out.length - 1];
      if (prev && prev.org && r.org && prev.org === r.org) {
        prev.years = prev.years.concat(r.years);
        return;
      }
      out.push({ title: r.title, org: r.org, years: r.years.slice() });
    });
    return out.map((r) => {
      const ys = r.years.filter(Boolean).sort();
      const present = r.years.indexOf('Present') !== -1;
      const first = ys[0];
      const last = present ? 'Present' : ys[ys.length - 1];
      return { title: r.title, scope: r.org, dates: first === last ? first : first + ' \u2013 ' + last };
    });
  }

  /** Render the .rsm document body (no <doc-page>, no <html>) — use to embed in an existing page. */
  function renderBody(career, selection, opts) {
    selection = selection || {};
    const pos = (career.positioning || []).filter((p) => p.id === selection.positioningId)[0] || (career.positioning || [])[0] || {};
    const picked = selection.bullets || {};
    // Roles at or past rules.compressAfter render as one-line rows, not full role blocks. Their bullet
    // pools stay in the data (useful for bios, LinkedIn, interview prep) but are not shown on the résumé.
    // Compressed rows carry title · org and a year span only — no city, no month — because the row must
    // never wrap and the longest title here already runs close to the column width.
    const compressAfter = (career.rules || {}).compressAfter;
    const roles = career.roles || [];
    const fullRoles = compressAfter == null ? roles : roles.slice(0, compressAfter);
    const tailRoles = compressAfter == null ? [] : roles.slice(compressAfter);
    const compressedRows = (career.compressed || []).concat(mergeSameOrg(tailRoles.map((r) => ({
      title: String(r.title).replace(/^Senior\s/, 'Sr. '),
      org: r.org,
      years: (String(r.dates || '').match(/\d{4}/g) || []).concat(String(r.dates || '').indexOf('Present') !== -1 ? ['Present'] : [])
    }))));
    const out = [];
    // DIVERGENCE from the vendored TK Resume Design System, 2026-09-07.
    // opts.rootStyle carries the chat's per-document design token overrides.
    // It belongs HERE and nowhere else: .rsm is a child of <doc-page>, and
    // useResumeCapture captures docPageEl.innerHTML — so an attribute on this
    // element rides into saved_resumes for free, while the same declarations
    // set on <doc-page> itself, or in a <style> in the head, look identical on
    // screen and are silently lost on Save. Splicing the attribute in from the
    // app instead would be hand-building .rsm markup, which this file's header
    // forbids. The value is produced and re-validated by
    // lib/resume-design-tokens.ts; this function does not parse it.
    const rootStyle = (opts && opts.rootStyle) || '';
    out.push(rootStyle ? '<div class="rsm" style="' + rootStyle + '">' : '<div class="rsm">');
    out.push('<header class="rsm-header">');
    out.push('<h1 class="rsm-name">' + esc(career.identity.name) + '</h1>');
    // One mono line, separators interleaved between values. The tagline is deliberately not
    // rendered: the summary paragraph below states the same positioning in full sentences, and
    // saying it twice reads as padding. Synced from the design system 2026-09-08 — the previous
    // two-column masthead with a stacked contact block was a stale port.
    const contactItems = (career.identity.contacts || []).map((c) => (
      c.href ? '<a href="' + c.href + '">' + esc(c.label) + '</a>' : '<span>' + esc(c.label) + '</span>'
    ));
    // `rsm-sep`, not the design system's bare `sep`: lib/resume-sanitize.ts allows
    // classes matching /^rsm(-[a-z0-9-]+)?$/ only, so an un-namespaced class is
    // stripped from every SAVED résumé and the separators silently lose their
    // tint. Namespacing here keeps that allowlist narrow. Push this upstream so
    // the next sync does not reintroduce it.
    out.push('<p class="rsm-contact">' + contactItems.join('<span class="rsm-sep">\u00b7</span>') + '</p>');
    out.push('</header>');
    if (pos.summary) out.push('<p class="rsm-summary">' + esc(pos.summary) + '</p>');

    out.push('<section class="rsm-section">');
    out.push('<h2 class="rsm-section-title">Professional Experience</h2>');
    fullRoles.forEach((role) => {
      const ids = picked[role.id] || role.bullets.map((b) => b.id);
      const bullets = ids.map((id) => role.bullets.filter((b) => b.id === id)[0]).filter(Boolean);
      if (!bullets.length) return;
      out.push('<div class="rsm-role">');
      out.push('<div class="rsm-role-head">');
      out.push('<h3 class="rsm-role-title">' + role.title + '</h3>');
      if (role.dates) out.push('<div class="rsm-role-dates">' + esc(role.dates) + '</div>');
      out.push('</div>');
      if (role.org) {
        out.push('<p class="rsm-role-org"><b>' + esc(role.org) + '</b>' + (role.scope ? ' \u00b7 ' + esc(role.scope) : '') + (role.acquired ? ' <em>(' + esc(role.acquired) + ')</em>' : '') + '</p>');
      }
      out.push('<ul class="rsm-bullets">' + bullets.map((b) => '<li>' + b.text + '</li>').join('') + '</ul>');
      out.push('</div>');
    });
    if (compressedRows.length) {
      out.push('<dl class="rsm-compressed">');
      compressedRows.forEach((c) => {
        out.push('<dt><b>' + c.title + '</b>' + (c.scope ? ' <span>\u00b7 ' + esc(c.scope) + '</span>' : '') + '</dt><dd>' + esc(c.dates) + '</dd>');
      });
      out.push('</dl>');
    }
    out.push('</section>');

    const rows = (title, items, last) => {
      if (!items || !items.length) return;
      out.push('<section class="rsm-section"' + (last ? ' style="margin-bottom:0"' : '') + '>');
      out.push('<h2 class="rsm-section-title">' + title + '</h2>');
      out.push('<div class="rsm-rows">');
      items.forEach((r) => {
        out.push('<div class="rsm-row"><div class="rsm-row-main"><b>' + r.main + '</b>' + (r.scope ? ' <span>\u00b7 ' + esc(r.scope) + '</span>' : '') + '</div><div class="rsm-row-dates">' + esc(r.dates || '') + '</div></div>');
      });
      out.push('</div>');
      out.push('</section>');
    };
    rows('Advisory', career.advisory, false);
    rows('Education &amp; Certifications', career.education, true);

    out.push('</div>');
    return out.join('\n');
  }

  /** Render a complete, print-ready HTML document. `opts.base` prefixes styles.css / doc-page.js.
   *  Screen-only page-boundary guides are included; pass `pageGuides: false` to omit them. */
  function renderResume(career, selection, opts) {
    opts = opts || {};
    const base = opts.base == null ? '.' : opts.base;
    const pos = (career.positioning || []).filter((p) => p.id === (selection || {}).positioningId)[0] || {};
    const title = career.identity.name + ' — Résumé' + (pos.id ? ' (' + pos.id + ')' : '');
    return [
      '<!DOCTYPE html>',
      '<html lang="en">',
      '<head>',
      '<meta charset="utf-8">',
      '<title>' + esc(title) + '</title>',
      '<link rel="stylesheet" href="' + base + '/styles.css">',
      '<style>doc-page:not(:defined){visibility:hidden}</style>',
      '</head>',
      '<body>',
      '<doc-page margin="' + (opts.margin || '0.68in') + '">',
      renderBody(career, selection),
      '</doc-page>',
      '<script src="' + base + '/doc-page.js"></script>',
      opts.pageGuides === false ? '' : '<script src="' + base + '/page-guides.js"></script>',
      '</body>',
      '</html>',
      ''
    ].join('\n');
  }

  /**
   * Report how well the pool actually supports a requested theme list, and how much of a
   * rendered selection speaks to it. Call this BEFORE shipping a tailored résumé: a theme
   * the pool cannot support is a signal (add a bullet, or treat the role as a stretch),
   * not something to paper over.
   *
   * Returns { themes: [{ theme, pool, selected, roles, support }], gaps, unknown, strength }
   *   support  'strong' (3+ pool bullets), 'thin' (1-2), 'absent' (0)
   *   gaps     requested themes with no pool evidence at all
   *   unknown  requested themes not in the vocabulary — usually a derivation bug
   *   strength share of the selected bullets that match any requested theme (0-1)
   */
  function coverage(career, requestedThemes, selection, vocabulary) {
    const requested = requestedThemes || [];
    const known = vocabulary && vocabulary.themes ? vocabulary.themes.map((t) => t.id) : (career.rules && career.rules.themes) || [];
    const all = [];
    (career.roles || []).forEach((role) => role.bullets.forEach((b) => all.push({ role: role.id, b })));
    const selectedIds = [];
    if (selection && selection.bullets) {
      Object.keys(selection.bullets).forEach((roleId) => {
        selection.bullets[roleId].forEach((id) => selectedIds.push(roleId + ':' + id));
      });
    }
    const themes = requested.map((t) => {
      const pool = all.filter((x) => (x.b.themes || []).indexOf(t) !== -1);
      const sel = pool.filter((x) => selectedIds.indexOf(x.role + ':' + x.b.id) !== -1);
      return {
        theme: t,
        pool: pool.length,
        selected: sel.length,
        roles: pool.map((x) => x.role).filter((r, i, a) => a.indexOf(r) === i),
        support: pool.length === 0 ? 'absent' : pool.length < 3 ? 'thin' : 'strong'
      };
    });
    let strength = null;
    if (selectedIds.length) {
      const matching = all.filter((x) => selectedIds.indexOf(x.role + ':' + x.b.id) !== -1 && (x.b.themes || []).some((t) => requested.indexOf(t) !== -1));
      strength = matching.length / selectedIds.length;
    }
    return {
      themes,
      gaps: themes.filter((t) => t.support === 'absent').map((t) => t.theme),
      unknown: requested.filter((t) => known.length && known.indexOf(t) === -1),
      strength
    };
  }

  return { selectBullets, renderBody, renderResume, coverage };
});
