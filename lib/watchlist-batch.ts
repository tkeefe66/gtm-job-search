import type { CrawlOutcome } from "./crawler";
import type { TrackedCompany } from "./types";
import { requestWithDeadline } from "./client-request";
import { isDue } from "./crawl-schedule";
import { needsYou, rowStateFor } from "./watchlist-row";

export interface WatchlistBatchProgress {
  total: number;
  completed: number;
  currentCompany: string | null;
  results: { company: string; outcome?: CrawlOutcome; error?: string }[];
  stopped: boolean;
  interrupted: boolean;
}

/** Shared by individual and batch checks for one mounted watchlist. Reload to inspect an unknown outcome. */
export function createWatchlistCheckLock() {
  let busy = false;
  let unconfirmed = false;
  return {
    tryStart: (): boolean => {
      if (busy || unconfirmed) return false;
      busy = true;
      return true;
    },
    release: (): void => { busy = false; },
    markUnconfirmed: (): void => { unconfirmed = true; },
    isUnconfirmed: (): boolean => unconfirmed,
  };
}

/** Due rows plus unfinished or failed checks, independent of the current UI filter. */
export function watchlistCheckCandidates(companies: TrackedCompany[], now: Date = new Date()): string[] {
  const selected = new Set<string>();
  for (const company of companies) {
    if (!company.tracking_enabled) continue;
    const due = isDue(
      company.last_attempted_at ?? company.last_checked_at,
      company.crawl_interval_days,
      now,
      company.next_attempt_at,
    );
    if (due || needsYou(rowStateFor({
      trackingEnabled: company.tracking_enabled,
      lastCrawlStatus: company.last_crawl_status,
      consecutiveFailures: company.consecutive_failures,
      isDue: due,
    }))) selected.add(company.company);
  }
  return Array.from(selected);
}

/** One direct check per selected company. An unconfirmed RPC stops the queue, never retries. */
export async function runWatchlistChecks(
  companies: string[],
  options: {
    check: (company: string, trigger: "check") => Promise<CrawlOutcome>;
    shouldStop: () => boolean;
    onProgress: (progress: WatchlistBatchProgress) => void;
  },
): Promise<WatchlistBatchProgress> {
  const queue = Array.from(new Set(companies));
  let progress: WatchlistBatchProgress = {
    total: queue.length, completed: 0, currentCompany: null,
    results: [], stopped: false, interrupted: false,
  };
  const emit = () => {
    // Reporting must not turn a confirmed result into a failed RPC or repeat paid work.
    try { options.onProgress({ ...progress, results: [...progress.results] }); }
    catch (error) { console.error("Watchlist batch progress could not be displayed", error); }
  };

  for (const company of queue) {
    if (options.shouldStop()) {
      progress = { ...progress, stopped: true };
      break;
    }
    progress = { ...progress, currentCompany: company };
    emit();
    try {
      const outcome = await requestWithDeadline(options.check(company, "check"));
      progress = {
        ...progress,
        completed: progress.completed + 1,
        currentCompany: null,
        results: [...progress.results, { company, outcome }],
      };
    } catch (error) {
      const detail = error instanceof Error ? error.message.trim() : typeof error === "string" ? error.trim() : "";
      progress = {
        ...progress,
        currentCompany: null,
        interrupted: true,
        results: [...progress.results, {
          company,
          error: `${detail ? `${detail} ` : ""}Could not confirm whether this check finished. Server work may still finish. Refresh the watchlist before starting another batch.`,
        }],
      };
    }
    emit();
    if (progress.interrupted) break;
  }
  progress = { ...progress, currentCompany: null };
  emit();
  return progress;
}
