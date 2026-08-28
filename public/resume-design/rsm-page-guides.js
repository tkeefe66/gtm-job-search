/**
 * rsm-page-guides.js — accurate, on-screen page-break markers for this app's
 * .rsm résumé documents specifically (not a generic doc-page add-on).
 *
 * The vendored page-guides.js (no longer loaded by ResumeDocument.tsx)
 * estimates breaks by dividing total height by page height alone, with zero
 * knowledge of the break-inside/break-after/break-before rules this app's
 * document.css relies on — it drew a line between a role's header and its
 * bullets even after the real print output no longer split there. This
 * walks the actual .rsm-role structure and only offers a break BEFORE a
 * role's header+org+first-bullet cluster, or before any LATER bullet in
 * that role — exactly the points document.css's break-after/break-before:
 * avoid rules protect — so it can never recommend a break the real print
 * engine would refuse.
 *
 * Non-role top-level content (the masthead, the summary paragraph, and the
 * compressed/advisory/education trailer sections) is treated as one atomic,
 * unsplittable block each — matching their real CSS: no per-item break rule
 * exists for the masthead/summary, and break-inside:avoid still applies to
 * those trailer sections.
 *
 * Still an estimate, not the print engine itself — font-metric rounding and
 * orphans/widows line-level splitting inside a single bullet aren't
 * modeled. Print / Export PDF remains the ground truth; this exists so
 * editing doesn't require opening it after every change.
 */
(function () {
  const PAPER = { letter: [816, 1056], a4: [794, 1123], legal: [816, 1344] };

  function toPx(len, fallback) {
    if (len == null || len === '') return fallback;
    const m = String(len).trim().match(/^([\d.]+)\s*(px|in|cm|mm|pt|pc)?$/);
    if (!m) return fallback;
    const n = parseFloat(m[1]);
    switch (m[2]) {
      case 'in': return n * 96;
      case 'cm': return n * 37.7952756;
      case 'mm': return n * 3.77952756;
      case 'pt': return n * (96 / 72);
      case 'pc': return n * 16;
      default: return n;
    }
  }

  function ensureStyle() {
    if (document.getElementById('rsm-page-guides-style')) return;
    const s = document.createElement('style');
    s.id = 'rsm-page-guides-style';
    s.textContent = [
      '.rsm-page-guide{position:absolute;left:0;right:0;pointer-events:none;z-index:2;display:flex;align-items:center;gap:8px}',
      '.rsm-page-guide-tick{flex:0 0 var(--rail,132px);border-top:1px solid color-mix(in oklch, var(--accent-600,#33436e) 55%, transparent)}',
      '.rsm-page-guide-line{flex:1;border-top:1px dashed color-mix(in oklch, var(--accent-600,#33436e) 16%, transparent)}',
      '.rsm-page-guide-label{position:absolute;left:0;top:-14px;padding:1px 5px 1px 0;',
      'background:var(--surface-sheet,#fff);',
      'font:400 9px/1 var(--font-mono, ui-monospace, monospace);letter-spacing:0.16em;',
      'text-transform:uppercase;color:var(--accent-600,#33436e)}',
      '@media print{.rsm-page-guide{display:none !important}}',
    ].join('');
    document.head.appendChild(s);
  }

  /** Usable content height (page height minus top+bottom margin) for the
   *  same flowing-document sizing doc-page.js itself computes. */
  function pageContentHeight(docPage) {
    const size = (docPage.getAttribute('size') || 'letter').toLowerCase();
    const base = PAPER[size] || PAPER.letter;
    const landscape = (docPage.getAttribute('orientation') || '').toLowerCase() === 'landscape';
    const width = docPage.getAttribute('width');
    const height = docPage.getAttribute('height');
    const pageH = width && height ? toPx(height, base[1]) : landscape ? base[0] : base[1];
    const margin = toPx(docPage.getAttribute('margin'), 0.75 * 96);
    return pageH - margin * 2;
  }

  /** Ordered {top, bottom} fragments in px relative to `rsm`'s own top.
   *  Each fragment's TOP is a break point document.css actually allows. */
  function collectFragments(rsm) {
    const rsmTop = rsm.getBoundingClientRect().top;
    const rel = (y) => y - rsmTop;
    const fragments = [];
    for (const child of rsm.children) {
      const roles = child.classList.contains('rsm-section')
        ? [...child.querySelectorAll(':scope > .rsm-role')]
        : [];
      if (roles.length > 0) {
        roles.forEach((role, ri) => {
          const bullets = [...role.querySelectorAll('.rsm-bullets > li')];
          const roleRect = role.getBoundingClientRect();
          // The first role also carries the section's own leading
          // padding/border (the rule above the section title) — nothing
          // else in this flat top-level walk accounts for it.
          const top = ri === 0 ? child.getBoundingClientRect().top : roleRect.top;
          if (bullets.length === 0) {
            fragments.push({ top: rel(top), bottom: rel(roleRect.bottom) });
            return;
          }
          fragments.push({ top: rel(top), bottom: rel(bullets[0].getBoundingClientRect().bottom) });
          for (let i = 1; i < bullets.length; i++) {
            const isLast = i === bullets.length - 1;
            const bRect = bullets[i].getBoundingClientRect();
            fragments.push({ top: rel(bRect.top), bottom: rel(isLast ? roleRect.bottom : bRect.bottom) });
          }
        });
      } else {
        const rect = child.getBoundingClientRect();
        fragments.push({ top: rel(rect.top), bottom: rel(rect.bottom) });
      }
    }
    return fragments;
  }

  function draw(rsm, docPage) {
    rsm.querySelectorAll(':scope > .rsm-page-guide').forEach((n) => n.remove());
    if (getComputedStyle(rsm).position === 'static') rsm.style.position = 'relative';

    const contentH = pageContentHeight(docPage);
    if (!(contentH > 0)) return;
    const fragments = collectFragments(rsm);
    if (!fragments.length) return;

    let pageStart = 0;
    let pageNum = 1;
    for (const frag of fragments) {
      // frag.top > pageStart: only break BEFORE a fragment that isn't
      // already the first thing on this page — a fragment taller than a
      // whole page has nowhere better to go and must overflow, same as
      // the real break-inside:avoid engine falls back to when it has no
      // choice.
      if (frag.bottom - pageStart > contentH && frag.top > pageStart) {
        pageNum += 1;
        pageStart = frag.top;
        const g = document.createElement('div');
        g.className = 'rsm-page-guide';
        g.style.top = frag.top + 'px';
        g.innerHTML =
          '<div class="rsm-page-guide-tick"></div><div class="rsm-page-guide-line"></div>' +
          '<span class="rsm-page-guide-label">Page ' + pageNum + '</span>';
        rsm.appendChild(g);
      }
    }
  }

  function run() {
    ensureStyle();
    document.querySelectorAll('doc-page').forEach((docPage) => {
      const rsm = docPage.querySelector(':scope > .rsm');
      if (rsm) draw(rsm, docPage);
    });
  }

  function boot() {
    run();
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(run);
    let resizeTimer;
    addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(run, 150); });
    document.querySelectorAll('doc-page .rsm').forEach((el) => {
      let busy = false;
      new MutationObserver(() => {
        if (busy) return;
        busy = true;
        requestAnimationFrame(() => { busy = false; run(); });
      }).observe(el, { subtree: true, childList: true, characterData: true });
    });
  }

  if (document.readyState === 'loading') addEventListener('DOMContentLoaded', boot);
  else boot();
})();
