/**
 * page-guides.js — screen-only markers showing where each printed page ends.
 *
 * Drop in alongside doc-page.js. Marks every page boundary of a flowing <doc-page> so you can
 * see what lands where without opening print preview. Absolutely positioned (no layout effect)
 * and hidden at print.
 *
 * The boundary falls at an arbitrary y, so it will often land on live text. Two things keep it
 * legible without obscuring the document: the label sits in the empty left rail rather than the
 * right edge (where it collided with right-aligned role dates), and it carries an opaque sheet
 * backdrop so it reads wherever it lands. The rule itself is a faint tick in the rail plus a
 * very light full-width line, so it reads as an annotation rather than a strikethrough.
 *
 *   <script src="doc-page.js"></script>
 *   <script src="page-guides.js"></script>
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
    if (document.getElementById('page-guides-style')) return;
    const s = document.createElement('style');
    s.id = 'page-guides-style';
    s.textContent = [
      '.page-guide{position:absolute;left:0;right:0;pointer-events:none;z-index:2;display:flex;align-items:center;gap:8px}',
      /* Solid tick across the empty left rail, then a barely-there line across the text column,
         so the boundary is readable without striking through content. */
      '.page-guide-tick{flex:0 0 var(--rail,96px);border-top:1px solid color-mix(in oklch, var(--accent-600,#33436e) 55%, transparent)}',
      '.page-guide-line{flex:1;border-top:1px dashed color-mix(in oklch, var(--accent-600,#33436e) 16%, transparent)}',
      '.page-guide-label{position:absolute;left:0;top:-14px;padding:1px 5px 1px 0;',
      'background:var(--surface-sheet,#fff);',
      'font:400 9px/1 var(--font-mono, ui-monospace, monospace);letter-spacing:0.16em;',
      'text-transform:uppercase;color:var(--accent-600,#33436e)}',
      '@media print{.page-guide{display:none !important}}'
    ].join('');
    document.head.appendChild(s);
  }

  function draw(host) {
    const page = host.closest ? host.closest('doc-page') : null;
    if (!page) return;
    const orientation = (page.getAttribute('orientation') || '').toLowerCase();
    const size = (page.getAttribute('size') || 'letter').toLowerCase();
    const base = PAPER[size] || PAPER.letter;
    const pageH = toPx(page.getAttribute('height'), orientation === 'landscape' ? base[0] : base[1]);
    const margin = toPx(page.getAttribute('margin'), 72);
    const contentH = pageH - margin * 2;
    if (!(contentH > 0)) return;

    host.querySelectorAll(':scope > .page-guide').forEach((n) => n.remove());
    if (getComputedStyle(host).position === 'static') host.style.position = 'relative';

    const total = host.getBoundingClientRect().height;
    for (let top = contentH, n = 2; top < total - 4; top += contentH, n += 1) {
      const g = document.createElement('div');
      g.className = 'page-guide';
      g.style.top = top + 'px';
      g.innerHTML = '<div class="page-guide-tick"></div><div class="page-guide-line"></div>'
        + '<span class="page-guide-label">Page ' + n + '</span>';
      host.appendChild(g);
    }
  }

  function run() {
    ensureStyle();
    document.querySelectorAll('doc-page .rsm, doc-page > div').forEach(draw);
  }

  function boot() {
    run();
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(run);
    let t;
    addEventListener('resize', () => { clearTimeout(t); t = setTimeout(run, 150); });
    if (typeof ResizeObserver === 'function') {
      document.querySelectorAll('doc-page .rsm').forEach((el) => {
        let busy = false;
        new ResizeObserver(() => {
          if (busy) return;
          busy = true;
          requestAnimationFrame(() => { busy = false; run(); });
        }).observe(el);
      });
    }
  }

  if (document.readyState === 'loading') addEventListener('DOMContentLoaded', boot);
  else boot();
})();
