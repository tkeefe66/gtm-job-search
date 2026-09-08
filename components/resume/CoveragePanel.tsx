"use client";

import type { CoverageReport } from "@/lib/resume-coverage";

const SUPPORT_LABEL: Record<string, string> = { strong: "strong", thin: "thin", absent: "no support" };

/**
 * What the document was built FROM. Always shown, never collapsed: it is the
 * only place the input is visible, and a collapsed panel leaves the screen as
 * opaque as it was without it. Numbers describe the RENDERED document only —
 * see lib/resume-coverage.ts for why the pool-wide figures are wrong here.
 */
export default function CoveragePanel({
  coverage,
  warnings,
}: {
  coverage: CoverageReport;
  warnings: string[];
}) {
  const pct = coverage.strength === null ? null : Math.round(coverage.strength * 100);
  return (
    <div className="rounded border border-slate p-3 text-xs print:hidden">
      <p className="font-medium uppercase tracking-wide text-ink/60">What this document was built from</p>
      <ul className="mt-2 space-y-1">
        {coverage.themes.map((t) => (
          <li key={t.theme} className={t.support === "absent" ? "text-[#92400E]" : "text-ink/80"}>
            <span className="font-medium">{t.theme}</span> — {SUPPORT_LABEL[t.support]} ·{" "}
            {t.pool} on the page, {t.selected} used
            {t.poolBeyondRendered > 0 && ` · ${t.poolBeyondRendered} more in compressed roles`}
          </li>
        ))}
      </ul>
      {coverage.gaps.length > 0 && (
        <p className="mt-2 text-[#92400E]">
          This posting asks for {coverage.gaps.join(", ")}, and the career record has nothing supporting{" "}
          {coverage.gaps.length === 1 ? "it" : "them"}.
        </p>
      )}
      {pct !== null && (
        <p className="mt-2 text-ink/60">
          {pct}% of the bullets on the page speak to what the posting asked for.
        </p>
      )}
      {(coverage.overlayBullets > 0 || coverage.editedBullets > 0) && (
        <p className="mt-2 text-ink/60">
          {coverage.overlayBullets > 0 && `${coverage.overlayBullets} added by you. `}
          {coverage.editedBullets > 0 && `${coverage.editedBullets} edited from the record.`}
        </p>
      )}
      {warnings.map((w) => (
        <p key={w} className="mt-2 text-[#92400E]">{w}</p>
      ))}
    </div>
  );
}
