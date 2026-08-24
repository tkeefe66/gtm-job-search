/* Page guides — on-screen only. Draws where each printed page ends so you can
   see what lands on page one versus page two. Hidden at print; the browser's
   own pagination is the final word (a heading that won't split can push a
   break a line or two earlier than the guide). */
(function () {
  const IN = 96;
  const SHEETS = { letter: 11, a4: 11.693, legal: 14 };

  function draw() {
    const doc = document.querySelector("doc-page");
    const content = document.querySelector(".rsm");
    if (!doc || !content) return;

    const size = (doc.getAttribute("size") || "letter").toLowerCase();
    const marginAttr = doc.getAttribute("margin") || "0.75in";
    const margin = parseFloat(marginAttr) * (marginAttr.includes("mm") ? 3.7795 : IN);
    const usable = (SHEETS[size] || SHEETS.letter) * IN - margin * 2;

    content.querySelectorAll("[data-page-guide]").forEach((n) => n.remove());
    content.style.position = "relative";

    const total = Math.ceil(content.getBoundingClientRect().height / usable);
    for (let i = 1; i < total; i++) {
      const g = document.createElement("div");
      g.dataset.pageGuide = "";
      g.style.cssText =
        "position:absolute;left:-" + margin + "px;right:-" + margin + "px;top:" +
        i * usable + "px;height:0;border-top:1px dashed color-mix(in oklch, var(--accent) 45%, transparent);pointer-events:none;z-index:5";
      const tag = document.createElement("span");
      tag.textContent = "page " + (i + 1);
      tag.style.cssText =
        "position:absolute;right:6px;top:4px;font:400 9px/1 var(--font-mono, monospace);letter-spacing:.08em;text-transform:uppercase;color:var(--accent);opacity:.75";
      g.appendChild(tag);
      content.appendChild(g);
    }
  }

  let timer = 0;
  const run = () => {
    clearTimeout(timer);
    timer = setTimeout(draw, 16);
  };
  const observe = () => {
    const content = document.querySelector(".rsm");
    if (!content) return void setTimeout(observe, 50);
    run();
    if (window.ResizeObserver) {
      let last = 0;
      new ResizeObserver(() => {
        const h = Math.round(content.getBoundingClientRect().height);
        if (h !== last) {
          last = h;
          run();
        }
      }).observe(content);
    }
  };
  if (document.readyState === "complete") observe();
  else window.addEventListener("load", observe);
  [150, 500, 1200].forEach((t) => setTimeout(run, t));
  window.addEventListener("resize", run);
  document.fonts && document.fonts.ready.then(run);
  window.addEventListener("beforeprint", () =>
    document.querySelectorAll("[data-page-guide]").forEach((n) => (n.style.display = "none"))
  );
  window.addEventListener("afterprint", run);
})();
