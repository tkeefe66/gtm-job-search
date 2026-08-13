import type { CrawlOutcome } from "@/lib/crawler";

// trackCompanyByName always adds the watchlist row before crawling, so a
// crawl failure (status "error" or "needs_url") never means "not tracked" —
// the row exists either way. Collapsing that into a bare "Tracking ✓" would
// be a silent failure of exactly the kind this repo's "explicit over silent"
// standard rules out: the user believes the company will surface roles when
// it structurally can't yet (most commonly: no careers URL was found).
//
// So this never reports "failed" — only "tracked, needs attention" — and
// always names what to do next (the Watchlist page's careers-URL field is
// the fix for both "needs_url" and most "error" cases in practice).
export interface TrackOutcomeDisplay {
  ok: boolean;
  message: string;
}

export function describeTrackOutcome(outcome: CrawlOutcome | null): TrackOutcomeDisplay {
  if (!outcome || outcome.status === "ok" || outcome.status === "empty") {
    return { ok: true, message: "Tracking ✓" };
  }
  const reason = outcome.error ?? "the first crawl failed";
  return {
    ok: false,
    message: `Tracking ✓ — needs attention: ${reason} (set a careers URL on Watchlist)`,
  };
}
