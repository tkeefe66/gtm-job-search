"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  checkCompanyNow,
  getCompanySpendSummaries,
  getDeepSearchAdvice,
  stopTrackingCompanies,
  getTrackedCompanies,
  renameTrackedCompany,
  setCareersUrl,
  setAutomaticPaidSearch,
  setCrawlInterval,
  setIgnoreLocationRule,
  setTracking,
  trackCompanyByName,
  type CompanySpendSummary,
} from "@/app/actions/watchlist";
import { readCompanyInput } from "@/lib/company-input";
import { isDue, nextCheckDue } from "@/lib/crawl-schedule";
import { summarizeCrawlHealth } from "@/lib/crawl-health";
import { stoppedTrackingReason } from "@/lib/dead-tracking";
import { needsYou, rowStateFor, type RowState } from "@/lib/watchlist-row";
import type { CrawlOutcome } from "@/lib/crawler";
import type { TrackedCompany } from "@/lib/types";
import { displayableExtras } from "@/lib/watchlist-signal";
import { Spinner, Tag } from "./ui";
import CompanyCheckDetails from "./CompanyCheckDetails";
import WatchlistBatchResults from "./WatchlistBatchResults";
import WatchlistCheckSelection from "./WatchlistCheckSelection";
import DeepSearchControl from "./DeepSearchControl";
import CompanySelectionCheckbox from "./CompanySelectionCheckbox";
import WatchlistBulkReview from "./WatchlistBulkReview";
import RestoreCompanyReview from "./RestoreCompanyReview";
import {restorationNotice, removalReasonLabel, type RestoreNotice, type RemovalReason} from "@/lib/watchlist-removal";
import {selectedTrackedCompanies, toggleCompanySelection} from "@/lib/watchlist-selection";
import type { DeepSearchAdvice } from "@/lib/deep-search-advice";
import { crawlIssueDisplay, crawlOutcomeText } from "@/lib/watchlist-display";
import { describeWriteFailure } from "@/lib/write-failure";
import { requestWithDeadline } from "@/lib/client-request";
import { createWatchlistCheckLock, runWatchlistChecks, watchlistCheckCandidates, type WatchlistBatchProgress } from "@/lib/watchlist-batch";

// The dot colour and its sentence in one place, so the legend can never
// describe a colour the rows do not use. Kept in components/ deliberately:
// tailwind.config.ts scans ./app/** and ./components/** only, so an
// arbitrary-value class defined in lib/ is never generated — the same trap
// STATUS_STYLES in RolesTable.tsx records.
const STATE_STYLE: Record<
  RowState,
  { dot: string; label: string; legend: string }
> = {
  ok: {
    dot: "bg-[#22C55E]",
    label: "Checking",
    legend: "Checking on schedule",
  },
  due: {
    dot: "bg-ink",
    label: "Due now",
    legend: "Due now — the crawler will get to it",
  },
  empty: {
    dot: "bg-[#A8A29E]",
    label: "No matches",
    legend: "Read fine, no matching roles",
  },
  failing: {
    dot: "bg-[#92400E]",
    label: "Failing",
    legend: "Failing its checks — needs you",
  },
  needs_url: {
    dot: "bg-[#92400E]",
    label: "Needs a URL",
    legend: "No careers page found — needs you",
  },
  skipped: { dot: "bg-[#A8A29E]", label: "Deferred", legend: "Check deferred — see the reason" },
  partial: { dot: "bg-[#92400E]", label: "Partial", legend: "Only part of the check completed" },
  unchanged: { dot: "bg-[#22C55E]", label: "Unchanged", legend: "Source checked; nothing changed" },
  error: { dot: "bg-[#92400E]", label: "Check failed", legend: "Last check failed — see the reason" },
};

// Legend order is reading order, not the enum's: healthy first, the ones that
// want you last. `failing` and `needs_url` share a colour, so they share one
// entry rather than printing the same swatch twice.
//
// SHORT labels, because the legend sits inline with the filter chips rather
// than under the table — four sentences on that row would push the filter box
// onto a second line at any normal width. The sentence each dot means survives
// as the row dot's `title`, which is where someone hovering actually asks.
const LEGEND: { dot: string; text: string }[] = [
  { dot: STATE_STYLE.ok.dot, text: "On schedule" },
  { dot: STATE_STYLE.due.dot, text: STATE_STYLE.due.label },
  { dot: STATE_STYLE.empty.dot, text: STATE_STYLE.empty.label },
  { dot: STATE_STYLE.failing.dot, text: "Needs you" },
];

type Filter = "all" | "attention" | "due";
type Sort = "original" | "company-asc" | "company-desc" | "next-asc" | "next-desc";

export default function Watchlist() {
  const [companies, setCompanies] = useState<TrackedCompany[]>([]);
  const [costs, setCosts] = useState<CompanySpendSummary[]>([]);
  const [costError, setCostError] = useState<string | null>(null);
  const [searchAdvice, setSearchAdvice] = useState<DeepSearchAdvice[]>([]);
  const [searchAdviceError, setSearchAdviceError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkReview, setBulkReview] = useState<{kind: "deep" | "remove"; names: string[]} | null>(null);
  const [bulkBusy, setBulkBusy] = useState<"preparing" | "removing" | null>(null);
  const [batchMode, setBatchMode] = useState<"check" | "deep">("check");
  const [loading, setLoading] = useState(true);
  const [newCompany, setNewCompany] = useState("");
  const [tracking, setTrackingBusy] = useState(false);
  const [restoreNotice, setRestoreNotice] = useState<RestoreNotice | null>(null);
  const [checking, setChecking] = useState<string | null>(null);
  const [batchRunning, setBatchRunning] = useState(false);
  const [batchProgress, setBatchProgress] = useState<WatchlistBatchProgress | null>(null);
  const [batchStopping, setBatchStopping] = useState(false);
  const [checkUnconfirmed, setCheckUnconfirmed] = useState(false);
  const checkLock = useRef(createWatchlistCheckLock());
  const stopBatch = useRef(false);
  const mounted = useRef(true);
  // Per-row lock. Must be a collection, not a single string — a single
  // shared value lets a second row's action overwrite it mid-flight and
  // spuriously re-enable the first row's button while its own mutation is
  // still in progress. Always mutate via setRowBusy (add/delete), never
  // overwrite wholesale.
  const [busyRows, setBusyRows] = useState<Set<string>>(new Set());
  const [notice, setNotice] = useState<string | null>(null);
  const [urlDrafts, setUrlDrafts] = useState<Record<string, string>>({});
  const [showUntracked, setShowUntracked] = useState(false);
  // Which rows are open. Keyed by company for the same reason busyRows is: the
  // list reloads after every mutation, so an index would reopen the wrong row.
  const [openRows, setOpenRows] = useState<Set<string>>(new Set());
  const [reviewTarget, setReviewTarget] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<Sort>("original");
  // Set when a URL was pasted into the name box. Holds the URL and the name
  // derived from it, which the user confirms or corrects before anything is
  // written — the name is a join key, so a derived one is offered, never
  // committed. See lib/company-input.ts.
  const [pendingUrl, setPendingUrl] = useState<{ url: string; name: string } | null>(
    null
  );
  // The company whose name is being edited, and the draft. Keyed by company for
  // the same reason busyRows is: the list reloads after every mutation.
  const [renaming, setRenaming] = useState<{ company: string; draft: string } | null>(
    null
  );

  function setRowBusy(company: string, busy: boolean) {
    setBusyRows((prev) => {
      const next = new Set(prev);
      if (busy) next.add(company);
      else next.delete(company);
      return next;
    });
  }

  function toggleRow(company: string) {
    setOpenRows((prev) => {
      const next = new Set(prev);
      if (next.has(company)) next.delete(company);
      else next.add(company);
      return next;
    });
  }

  function reviewCompany(company: string) {
    setFilter("all");
    setQuery("");
    if (companies.some(item => item.company === company && !item.tracking_enabled)) setShowUntracked(true);
    setOpenRows(prev => new Set(prev).add(company));
    setReviewTarget(company);
  }

  useEffect(() => {
    if (!reviewTarget) return;
    const row = document.getElementById(`watchlist-company-${encodeURIComponent(reviewTarget)}`);
    row?.focus({ preventScroll: true });
    row?.scrollIntoView({ block: "start" });
    setReviewTarget(null);
  }, [reviewTarget]);

  useEffect(() => {
    if (bulkReview) document.getElementById("watchlist-bulk-review")?.scrollIntoView({block: "start"});
  }, [bulkReview]);

  useEffect(() => {
    if (bulkReview && bulkReview.names.some(name => !companies.some(item => item.company === name && item.tracking_enabled))) {
      setBulkReview(null);
      setNotice("The selection changed because a company was renamed or stopped tracking. Review the selected companies again before continuing.");
    }
  }, [companies, bulkReview]);

  useEffect(() => {
    if (batchRunning) document.getElementById("watchlist-batch")?.scrollIntoView({block: "start"});
  }, [batchRunning]);

  useEffect(() => {
    mounted.current = true;
    load();
    return () => { mounted.current = false; stopBatch.current = true; };
  }, []);

  async function load(quiet = false) {
    if (!quiet) setLoading(true);
    try {
      const [list, spending, readiness] = await Promise.allSettled([
        requestWithDeadline(getTrackedCompanies(), 15_000),
        requestWithDeadline(getCompanySpendSummaries(), 15_000),
        requestWithDeadline(getDeepSearchAdvice(), 15_000),
      ]);
      if (!mounted.current) return;
      if (list.status === "rejected") setNotice("Could not load your list. Refresh and try again.");
      else {
        const failure = describeWriteFailure(list.value.error, "load your list");
        if (failure !== undefined) setNotice(failure);
        else {
          setCompanies(list.value.companies);
          setSelected(previous => new Set(selectedTrackedCompanies(previous, list.value.companies)));
        }
      }
      if (spending.status === "rejected") { setCosts([]); setCostError("Could not load company costs. Refresh to try again."); }
      else {
        const failure = describeWriteFailure(spending.value.error, "load company costs");
        setCostError(failure ?? null);
        setCosts(failure === undefined ? spending.value.summaries : []);
      }
      if (readiness.status === "rejected") {
        setSearchAdvice([]);
        setSearchAdviceError("Could not load search history and allowance. Refresh the recommendation before paid search.");
      } else {
        const failure = describeWriteFailure(readiness.value.error, "load Deep search recommendations");
        setSearchAdviceError(failure ?? null);
        setSearchAdvice(failure === undefined ? readiness.value.advice : []);
      }
    } finally { if (mounted.current && !quiet) setLoading(false); }
  }

  function describe(outcome: CrawlOutcome): string {
    return crawlOutcomeText(outcome);
  }

  async function handleTrack(e: React.FormEvent) {
    e.preventDefault();
    const parsed = readCompanyInput(newCompany);
    if (parsed.kind === "empty") return;

    // A pasted careers page opens the confirm step instead of tracking. The
    // server refuses this input too — this is the friendly half, not the guard.
    if (parsed.kind === "url") {
      setNotice(null);
      setPendingUrl({ url: parsed.url, name: parsed.suggestion });
      return;
    }
    await track(parsed.name);
  }

  /** The one path that actually tracks, shared by the box and the confirm step. */
  async function track(name: string, careersUrl?: string) {
    setTrackingBusy(true);
    setNotice(null);
    try {
      const res = await trackCompanyByName(name, careersUrl);
      if (res.restore) {setRestoreNotice(res.restore); return;}
      const failure = describeWriteFailure(res.error, "track this company");
      if (failure !== undefined) setNotice(failure);
      else if (res.outcome) setNotice(`${name} is tracked. ${describe(res.outcome)}`);
      if (failure === undefined) {
        setNewCompany("");
        setPendingUrl(null);
      }
      await load();
    } catch {
      setNotice("Could not confirm the company was tracked. Reload your list before trying again.");
    } finally {
      setTrackingBusy(false);
    }
  }

  async function handleRename(from: string, to: string) {
    setRowBusy(from, true);
    setNotice(null);
    try {
      const res = await renameTrackedCompany(from, to);
      const failure = describeWriteFailure(res.error, "rename this company");
      if (failure !== undefined) {
        setNotice(failure);
        return;
      }
      // Both keyed by company name, so both would point at a row that no longer
      // exists under that key.
      setOpenRows((prev) => {
        const next = new Set(prev);
        if (next.delete(from) && res.company) next.add(res.company);
        return next;
      });
      setUrlDrafts((prev) => {
        const next = { ...prev };
        delete next[from];
        return next;
      });
      // The retained batch uses the same company key as the watchlist rows.
      // Keep its Review links valid after a confirmed rename.
      if (res.company) {
        const renamed = res.company;
        setSelected(previous => { const next = new Set(previous); if (next.delete(from)) next.add(renamed); return next; });
        setBulkReview(null);
        setBatchProgress(prev => prev ? { ...prev, results: prev.results.map(result =>
          result.company === from ? { ...result, company: renamed,
            outcome: result.outcome ? { ...result.outcome, company: renamed } : undefined } : result) } : prev);
      }
      setRenaming(null);
      setNotice(`Renamed to "${res.company}".`);
      await load();
    } finally {
      setRowBusy(from, false);
    }
  }

  async function handleCheckNow(company: string, trigger: "check" | "deep" = "check", acknowledgementKey?: string) {
    if (!checkLock.current.tryStart()) return;
    setChecking(company);
    setNotice(null);
    try {
      const outcome = await requestWithDeadline(checkCompanyNow(company, trigger, acknowledgementKey));
      setNotice(`${company}: ${describe(outcome)}`);
      await load();
    } catch {
      checkLock.current.markUnconfirmed();
      setCheckUnconfirmed(true);
      setNotice(`${company}: Could not confirm the check completed. Reload before retrying.`);
    } finally {
      checkLock.current.release();
      setChecking(null);
    }
  }

  async function handleBatchCheck(names?: string[], trigger: "check" | "deep" = "check", acknowledgements: Record<string, string> = {}) {
    if (loading || tracking || bulkBusy || busyRows.size > 0 || !checkLock.current.tryStart()) return;
    stopBatch.current = false;
    setBulkReview(null);
    setBatchMode(trigger);
    setBatchRunning(true);
    setBatchStopping(false);
    setBatchProgress(null);
    setNotice(null);
    try {
      // Choose from fresh server state, across the watchlist rather than the
      // visible filter. A fixed queue prevents partial results being retried
      // repeatedly within the same click.
      const fresh = await requestWithDeadline(getTrackedCompanies(), 15_000);
      const failure = describeWriteFailure(fresh.error, "load companies for the batch");
      if (failure !== undefined) { if (mounted.current) setNotice(failure); return; }
      if (!mounted.current) return;
      setCompanies(fresh.companies);
      const queue = names ? selectedTrackedCompanies(new Set(names), fresh.companies) : watchlistCheckCandidates(fresh.companies);
      if (names && queue.length !== new Set(names).size) {
        setSelected(previous => new Set(selectedTrackedCompanies(previous, fresh.companies)));
        setNotice(`No checks started. These selected companies are no longer tracked under that name: ${names.filter(name => !queue.includes(name)).join(", ")}. Review the selection and try again.`);
        return;
      }
      const result = await runWatchlistChecks(queue, {
        trigger,
        check: (company, mode) => checkCompanyNow(company, mode, acknowledgements[company]),
        shouldStop: () => stopBatch.current || !mounted.current,
        onProgress: (progress) => {
          if (!mounted.current) return;
          setBatchProgress(progress);
          setChecking(progress.currentCompany);
        },
      });
      if (result.interrupted) {
        checkLock.current.markUnconfirmed();
        if (mounted.current) setCheckUnconfirmed(true);
      }
      if (mounted.current) await load(true);
    } catch {
      if (mounted.current) setNotice("Could not confirm the batch completed. Reload to see saved results before retrying.");
    } finally {
      checkLock.current.release();
      if (mounted.current) {
        setChecking(null);
        setBatchRunning(false);
      }
    }
  }

  function toggleSelection(names: string[]) {
    setBulkReview(null);
    const active = new Set(companies.filter(item => item.tracking_enabled).map(item => item.company));
    setSelected(previous => toggleCompanySelection(previous, names.filter(name => active.has(name))));
  }

  async function prepareBulkAction(kind: "deep" | "remove") {
    const names = selectedTrackedCompanies(selected, companies);
    if (names.length === 0 || loading || tracking || checking || batchRunning || bulkBusy || busyRows.size > 0 || checkUnconfirmed) return;
    if (kind === "remove") { setBulkReview({kind, names}); return; }
    setBulkBusy("preparing"); setNotice(null); setBulkReview(null);
    try {
      const result = await requestWithDeadline(getDeepSearchAdvice(), 15_000);
      const failure = describeWriteFailure(result.error, "review selected Deep searches");
      if (failure !== undefined) { setNotice(failure); return; }
      setSearchAdvice(result.advice); setSearchAdviceError(null);
      setBulkReview({kind, names});
    } catch { setNotice("Could not load current search recommendations. Try Deep search again to refresh them."); }
    finally { setBulkBusy(null); }
  }

  async function removeSelectedCompanies(names: string[], reason: RemovalReason) {
    if (bulkBusy || batchRunning || checking || tracking || busyRows.size > 0 || !checkLock.current.tryStart()) return;
    setBulkBusy("removing"); setNotice(null);
    try {
      const result = await requestWithDeadline(stopTrackingCompanies(names, reason), 15_000);
      const failure = describeWriteFailure(result.error, "remove companies from your watchlist");
      if (failure !== undefined) { setNotice(failure); return; }
      setCompanies(previous => previous.map(item => result.removed.includes(item.company) ? {...item, tracking_enabled: false} : item));
      setSelected(previous => new Set(Array.from(previous).filter(name => !names.includes(name))));
      setBulkReview(null);
      setNotice(`Removed ${result.removed.length} ${result.removed.length === 1 ? "company" : "companies"}. ${reason === "not_interested" ? "Hidden from Discover suggestions. " : ""}Saved roles and history are kept. Restore under Not tracked.${result.removed.length < names.length ? " Some companies were already untracked or renamed." : ""}`);
      await load(true);
    } catch { setNotice("Could not confirm removal completed. Reload your watchlist to see which companies are still tracked."); }
    finally { checkLock.current.release(); setBulkBusy(null); }
  }

  async function handleSetTracking(company: string, enabled: boolean) {
    if (!enabled) {setBulkReview({kind: "remove", names: [company]}); return;}
    setRowBusy(company, true);
    try {
      const res = await setTracking(company, enabled);
      if (res.restore) setRestoreNotice(res.restore);
      const failure = describeWriteFailure(res.error, "change tracking");
      if (failure !== undefined) setNotice(failure);
      await load();
    } finally {
      setRowBusy(company, false);
    }
  }

  async function handleSetIgnoreLocationRule(company: string, ignore: boolean) {
    setRowBusy(company, true);
    try {
      const res = await setIgnoreLocationRule(company, ignore);
      const failure = describeWriteFailure(res.error, "save the location setting");
      if (failure !== undefined) setNotice(failure);
      await load();
    } finally {
      setRowBusy(company, false);
    }
  }

  async function handleAutomaticPaidSearch(company: string, enabled: boolean) {
    setRowBusy(company, true);
    setNotice(null);
    try {
      const res = await setAutomaticPaidSearch(company, enabled);
      const failure = describeWriteFailure(res.error, "save automatic paid search");
      if (failure !== undefined) { setNotice(failure); return; }
      await load();
    } catch {
      setNotice("Could not confirm that automatic paid search was saved. Reload before trying again.");
    } finally { setRowBusy(company, false); }
  }

  async function handleSaveUrl(company: string) {
    // Fall back to the row's current careers_url, not "": the field is
    // pre-filled from it for every tracked row, so clicking Save without
    // editing must resubmit what's displayed, not an empty string that would
    // fail setCareersUrl's http(s):// check.
    const current = companies.find((c) => c.company === company)?.careers_url ?? "";
    const url = (urlDrafts[company] ?? current).trim();
    setRowBusy(company, true);
    try {
      const res = await setCareersUrl(company, url);
      const failure = describeWriteFailure(res.error, "save the careers page");
      if (failure !== undefined) {
        setNotice(failure);
        return;
      }
      // Drop the draft entirely (not set to "") so the input falls back to
      // the freshly-reloaded c.careers_url instead of displaying blank.
      setUrlDrafts((prev) => {
        const next = { ...prev };
        delete next[company];
        return next;
      });
      await handleCheckNow(company);
    } finally {
      setRowBusy(company, false);
    }
  }

  async function changeInterval(company: string, days: number) {
    // The per-row lock, not a shared one — see busyRows' comment above: a single
    // shared value lets one row's action re-enable another row mid-flight.
    setRowBusy(company, true);
    const res = await setCrawlInterval(company, days);
    // Presence, not truthiness — an unreachable database reports an empty
    // message, and `if (res.error)` would show the change as saved.
    if (res.error !== undefined) setNotice(res.error || "Could not save that interval.");
    setRowBusy(company, false);
    // Reload rather than patching state: the NEXT CHECK date on this row is
    // derived from the interval, so a local edit would leave the row showing a
    // schedule that no longer matches what the crawler will do.
    await load();
  }

  function formatDate(iso: string) {
    return new Date(iso).toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  }

  const tracked = companies.filter((c) => c.tracking_enabled);
  const untracked = companies.filter((c) => !c.tracking_enabled);

  function stateOf(c: TrackedCompany): RowState {
    return rowStateFor({
      trackingEnabled: c.tracking_enabled,
      lastCrawlStatus: c.last_crawl_status,
      consecutiveFailures: c.consecutive_failures,
      isDue: isDue(c.last_attempted_at ?? c.last_checked_at, c.crawl_interval_days, new Date(), c.next_attempt_at),
    });
  }

  const attentionCount = tracked.filter((c) => needsYou(stateOf(c))).length;
  const dueCount = tracked.filter((c) => stateOf(c) === "due").length;
  const batchCandidates = watchlistCheckCandidates(companies);
  const selectedNames = selectedTrackedCompanies(selected, companies);
  const selectionBusy = loading || tracking || !!checking || batchRunning || !!bulkBusy || busyRows.size > 0 || checkUnconfirmed;

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = tracked.filter((c) => {
      const state = stateOf(c);
      if (filter === "attention" && !needsYou(state)) return false;
      if (filter === "due" && state !== "due") return false;
      if (!q) return true;
      // Match the signal too, not just the name: the signal is why the company
      // is on the list, and it is the half you remember.
      return (
        c.company.toLowerCase().includes(q) ||
        (c.signal ?? "").toLowerCase().includes(q) ||
        (c.tagline ?? "").toLowerCase().includes(q)
      );
    });
    if (sort === "original") return filtered;
    return filtered.sort((a, b) => {
      const nameOrder = a.company.localeCompare(b.company, undefined, {
        sensitivity: "base",
        numeric: true,
      });
      if (sort === "company-asc") return nameOrder;
      if (sort === "company-desc") return -nameOrder;
      // Never-checked companies are due immediately, ahead of dated checks.
      const aDue = nextCheckDue(a.last_attempted_at ?? a.last_checked_at, a.crawl_interval_days, a.next_attempt_at)?.getTime() ?? -Infinity;
      const bDue = nextCheckDue(b.last_attempted_at ?? b.last_checked_at, b.crawl_interval_days, b.next_attempt_at)?.getTime() ?? -Infinity;
      const dueOrder = aDue === bDue ? 0 : aDue < bDue ? -1 : 1;
      return (sort === "next-asc" ? dueOrder : -dueOrder) || nameOrder;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tracked, filter, query, sort]);

  function chipClass(active: boolean) {
    return `rounded-full border px-2.5 py-1 text-xs transition ${
      active
        ? "border-ink bg-ink font-medium text-white"
        : "border-slate bg-white text-ink/60 hover:border-ink/40 hover:text-ink"
    }`;
  }

  /** The one line every tracked company gets. */
  function renderRow(c: TrackedCompany, i: number) {
    const advice = searchAdvice.find(item => item.company === c.company);
    const state = stateOf(c);
    const style = STATE_STYLE[state];
    const issue = crawlIssueDisplay(c.last_crawl_status, c.last_crawl_error);
    const due = nextCheckDue(c.last_attempted_at ?? c.last_checked_at, c.crawl_interval_days, c.next_attempt_at);
    const open = openRows.has(c.company);
    const busy = tracking || busyRows.has(c.company) || batchRunning || !!bulkBusy || checkUnconfirmed;
    // Whatever the tenant's own hiringSignal.extraFields named — contract_value
    // and awarding_agency for a defence contractor, bed_count for a hospital.
    const extras = displayableExtras(c.extras);
    // The venture-shaped columns are the FALLBACK now, not the default: they
    // are populated only for rows added before db/migrations/012 (and for the
    // funding profile, whose extras happen to carry the same three names).
    // `!c.signal`, not `=== null`: a row read back before db/migrations/012
    // is applied has no such KEY at all, so a strict null check reads
    // undefined as "has a signal" and hides the legacy tags too.
    const showLegacyTags = !c.signal && extras.length === 0;

    return (
      <div key={c.company} id={`watchlist-company-${encodeURIComponent(c.company)}`} tabIndex={-1}
        className={`scroll-mt-48 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ink sm:scroll-mt-28 ${selected.has(c.company) ? "bg-canvas" : ""} ${i > 0 ? "border-t border-slate" : ""}`}>
        <div
          onClick={() => toggleRow(c.company)}
          className="grid cursor-pointer grid-cols-[1fr_auto] items-center gap-x-4 px-4 py-2.5 transition hover:bg-canvas sm:grid-cols-[1fr_auto_7rem_4rem]"
        >
          <div className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1">
            <label className="flex self-stretch items-center py-1 pr-1" onClick={event => event.stopPropagation()}>
              <CompanySelectionCheckbox label={`Select ${c.company}`} checked={selected.has(c.company)} disabled={selectionBusy} onChange={() => toggleSelection([c.company])} />
            </label>
            <span
              className={`h-[7px] w-[7px] flex-none rounded-full ${style.dot}`}
              title={issue?.explanation ?? style.legend}
            />
            <span className="min-w-0 break-words font-heading text-sm font-semibold">{c.company}</span>
            <span className="hidden truncate text-xs text-ink/45 sm:block">
              {c.signal ?? c.tagline ?? ""}
            </span>
            {(needsYou(state) || ["skipped", "partial", "unchanged", "error"].includes(state)) && (
              <span className="max-w-full rounded-full bg-[#FEF3C7] px-2 py-0.5 text-[11px] font-medium text-[#92400E]" title={issue?.explanation ?? style.legend}>
                {issue?.label ?? style.label}
              </span>
            )}
          </div>

          {/* Stays on the row rather than inside the detail: the interval is
              the one setting worth changing while scanning the schedule. */}
          <label className="text-xs text-ink/55" onClick={(e) => e.stopPropagation()}>
            <span className="sr-only">Check {c.company} every</span>
            <select
              value={c.crawl_interval_days}
              disabled={busy}
              onChange={(e) => void changeInterval(c.company, Number(e.target.value))}
              className="rounded border border-slate bg-white px-1 py-0.5 text-xs disabled:opacity-40"
            >
              {[1, 3, 7, 14, 30, 90].map((d) => (
                <option key={d} value={d}>
                  {d === 1 ? "every day" : `every ${d} days`}
                </option>
              ))}
            </select>
          </label>

          <span
            className={`hidden text-right text-xs sm:block ${
              state === "due" ? "font-semibold text-ink" : "text-ink/45"
            }`}
          >
            {state === "due" ? "Due now" : due ? formatDate(due.toISOString()) : "—"}
          </span>

          <button
            onClick={(e) => {
              e.stopPropagation();
              toggleRow(c.company);
            }}
            aria-expanded={open}
            className="text-right text-xs text-ink/35 transition hover:text-ink"
          >
            {open ? "Close" : "Open"}
          </button>
        </div>

        {open && (
          <div className="border-t border-slate bg-canvas px-4 py-3.5">
            <div className="flex flex-wrap items-start justify-between gap-x-10 gap-y-3">
              <div className="min-w-0">
                {renaming?.company === c.company ? (
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      void handleRename(c.company, renaming.draft);
                    }}
                    className="mb-2 flex flex-wrap items-center gap-2"
                  >
                    <input
                      autoFocus
                      value={renaming.draft}
                      onChange={(e) =>
                        setRenaming({ company: c.company, draft: e.target.value })
                      }
                      onKeyDown={(e) => {
                        if (e.key === "Escape") setRenaming(null);
                      }}
                      className="w-56 rounded-md border border-slate bg-white px-2 py-1 text-sm"
                    />
                    <button
                      type="submit"
                      disabled={busy || !renaming.draft.trim()}
                      className="rounded-md border border-ink bg-ink px-2.5 py-1 text-xs font-medium text-white disabled:opacity-50"
                    >
                      Save name
                    </button>
                    <button
                      type="button"
                      onClick={() => setRenaming(null)}
                      className="text-xs text-ink/45 hover:text-ink"
                    >
                      Cancel
                    </button>
                    {/* Renaming rewrites the name on this company's saved roles
                        too, because the name is what ties them together. Said
                        here rather than in a confirm dialog: it is the
                        behaviour people want, not a risk they must accept. */}
                    <span className="basis-full text-xs text-ink/45">
                      Its saved roles and crawl history move with it.
                    </span>
                  </form>
                ) : (
                  <button
                    onClick={() => setRenaming({ company: c.company, draft: c.company })}
                    disabled={busy}
                    className="mb-2 text-xs text-ink/45 underline-offset-2 hover:text-ink hover:underline disabled:opacity-50"
                  >
                    Rename company
                  </button>
                )}

                <div className="flex flex-wrap items-center gap-2">
                  {showLegacyTags && c.stage && <Tag>{c.stage}</Tag>}
                  {showLegacyTags && c.raised && <Tag>{c.raised}</Tag>}
                  {showLegacyTags && c.category && <Tag>{c.category}</Tag>}
                  {extras.map(([k, v]) => (
                    <Tag key={k}>{v}</Tag>
                  ))}
                  {c.source && <Tag>via {c.source}</Tag>}
                </div>
                {c.tagline && <p className="mt-1.5 text-sm text-ink/70">{c.tagline}</p>}
                {/* WHY this company is worth watching, in the tenant's own
                    terms. Truncated on the row above; in full here. */}
                {c.signal && <p className="mt-1 text-sm text-ink/70">{c.signal}</p>}
                <p className="mt-1.5 text-xs text-ink/40">
                  Added {formatDate(c.added_at)}
                </p>
                {state === "empty" && (
                  <p className="mt-1 text-xs text-ink/40">
                    No matching roles on the last check.
                  </p>
                )}
                {state === "failing" && (
                  <p className="mt-1 text-xs text-[#92400E]">
                    Failing — {c.consecutive_failures} checks in a row.
                  </p>
                )}
              </div>

              <label
                className="flex items-start gap-2 text-xs text-ink/60"
                title="Search for roles at this company regardless of the location rule on Settings — for a company you're pursuing even if the role isn't remote or local yet."
              >
                <input
                  type="checkbox"
                  className="mt-0.5"
                  checked={c.ignore_location_rule}
                  disabled={busy}
                  onChange={(e) =>
                    void handleSetIgnoreLocationRule(c.company, e.target.checked)
                  }
                />
                Search here even outside my location rule
              </label>
            </div>

            <CompanyCheckDetails company={c} summary={costs.find((item) => item.company === c.company)} costError={costError} />
            <label className="mt-3 flex items-start gap-2 text-xs text-ink/60">
              <input type="checkbox" className="mt-0.5" checked={c.allow_paid_search ?? false} disabled={busy}
                onChange={(e) => void handleAutomaticPaidSearch(c.company, e.target.checked)} />
              Allow automatic paid web search when direct sources cannot be read (up to 5 searches per check; background limits apply).
            </label>

            <div
              className={`mt-3 flex flex-wrap items-center gap-2 ${
                state === "needs_url"
                  ? "rounded-md border border-[#92400E]/30 bg-[#92400E]/5 p-2"
                  : ""
              }`}
            >
              <span
                className={`text-xs ${
                  state === "needs_url" ? "font-medium text-[#92400E]" : "text-ink/40"
                }`}
              >
                {state === "needs_url"
                  ? "No careers page found — add one:"
                  : "Careers page"}
              </span>
              <input
                type="text"
                disabled={busy}
                value={urlDrafts[c.company] ?? c.careers_url ?? ""}
                onChange={(e) =>
                  setUrlDrafts((prev) => ({ ...prev, [c.company]: e.target.value }))
                }
                placeholder="https://company.com/careers"
                className="w-80 max-w-full rounded-md border border-slate bg-white px-2 py-1 text-sm"
              />
              <button
                onClick={() => handleSaveUrl(c.company)}
                disabled={busy}
                className="rounded-md border border-slate bg-white px-2.5 py-1 text-xs font-medium text-ink/70 transition hover:border-ink hover:text-ink disabled:opacity-50"
              >
                Save and check
              </button>
            </div>

            <div className="mt-3 flex flex-wrap items-center gap-2">
              <button
                onClick={() => handleCheckNow(c.company)}
                disabled={!!checking || busy}
                className="rounded-md border border-ink px-3 py-1.5 text-sm font-medium transition hover:bg-ink hover:text-white disabled:opacity-50"
              >
                {checking === c.company ? "Checking…" : "Check now"}
              </button>
              {c.careers_url && (
                <a
                  href={c.careers_url}
                  target="_blank"
                  rel="noreferrer"
                  className="text-sm text-ink/50 underline-offset-2 hover:underline"
                >
                  Careers ↗
                </a>
              )}
              <span className="flex-1" />
              <button
                onClick={() => handleSetTracking(c.company, false)}
                disabled={busy}
                className="text-sm text-ink/30 transition hover:text-[#92400E] disabled:opacity-50"
              >
                Stop tracking
              </button>
            </div>
            <p className="mt-2 text-xs text-ink/60">Check now reads direct sources. Processing new or changed listings may use AI.</p>
            <DeepSearchControl
              key={`${c.company}:${advice?.acknowledgementKey}:${advice?.state}:${searchAdviceError}`}
              advice={advice} error={searchAdviceError}
              busy={!!checking || busy || checkUnconfirmed || loading}
              onSearch={acknowledged => void handleCheckNow(c.company, "deep", acknowledged)} onRefresh={() => void load(true)} />
          </div>
        )}
      </div>
    );
  }

  /** An untracked row states its reason and offers the one thing worth doing. */
  function renderUntrackedRow(c: TrackedCompany, i: number) {
    // Only the crawler leaves failing_since set on a switched-off row — a manual
    // toggle clears it — so this distinguishes "we gave up" from "you turned it
    // off", which need different sentences and different remedies.
    const droppedAsDead = c.failing_since !== null;
    return (
      <div
        key={c.company}
        id={`watchlist-company-${encodeURIComponent(c.company)}`}
        tabIndex={-1}
        className={`flex scroll-mt-4 flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ink ${
          i > 0 ? "border-t border-slate" : ""
        }`}
      >
        <span className="h-[7px] w-[7px] flex-none rounded-full bg-slate" />
        <span className="font-heading text-sm font-semibold text-ink/70">
          {c.company}
        </span>
        <span className="min-w-0 flex-1 text-xs text-ink/50">
          {droppedAsDead
            ? `${stoppedTrackingReason(c.consecutive_failures)}${
                c.last_crawl_error ? ` Last error: ${c.last_crawl_error}` : ""
              }`
            : `${removalReasonLabel(c.removal_reason)}${c.removed_at ? ` · ${new Date(c.removed_at).toLocaleDateString()}` : " · Removal date not recorded"}`}
        </span>
        <button
          onClick={() => setRestoreNotice(restorationNotice(c) ?? null)}
          disabled={tracking || busyRows.has(c.company) || batchRunning || !!bulkBusy || checkUnconfirmed}
          className="rounded-md border border-slate px-2.5 py-1 text-xs font-medium text-ink/60 transition hover:border-ink hover:text-ink disabled:opacity-50"
        >
          Restore…
        </button>
      </div>
    );
  }

  // Measures the SYMPTOM (companies actually past their schedule) rather than
  // modelling capacity, which would need to know how many other tenants exist —
  // a cross-tenant fact this page must not read. lib/crawl-health.ts explains.
  const health = summarizeCrawlHealth(
    companies.map((c) => ({
      trackingEnabled: c.tracking_enabled,
      crawlIntervalDays: c.crawl_interval_days,
      consecutiveFailures: c.consecutive_failures,
      lastCheckedAt: c.last_attempted_at ?? c.last_checked_at,
      failingSince: c.failing_since,
    }))
  );

  return (
    <div>
      <div className="mb-5 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h2 className="text-xl font-heading font-semibold">Tracked companies</h2>
          <p className="max-w-prose text-sm text-ink/60">
            Tracked companies have their careers page checked automatically. New roles
            land in Roles; AI grading runs within your spending limits.
          </p>
        </div>

        <form onSubmit={handleTrack} className="flex flex-wrap items-center gap-2">
          <input
            type="text"
            value={newCompany}
            onChange={(e) => setNewCompany(e.target.value)}
            disabled={tracking || batchRunning || !!bulkBusy || checkUnconfirmed}
            placeholder="Track a company by name…"
            className="w-56 rounded-md border border-slate bg-white px-3 py-1.5 text-sm disabled:opacity-50"
          />
          <button
            type="submit"
            disabled={tracking || batchRunning || !!bulkBusy || checkUnconfirmed || !newCompany.trim()}
            className="rounded-md border border-ink bg-ink px-4 py-1.5 text-sm font-medium text-white transition hover:bg-ink/90 disabled:opacity-50"
          >
            Track
          </button>
        </form>
      </div>

      {health.dropped > 0 && (
        <div className="mb-4 rounded-md border border-slate bg-[#F8FAFC] p-4">
          <p className="text-sm font-medium">
            {health.dropped === 1
              ? "1 company was dropped because its careers page stopped working."
              : `${health.dropped} companies were dropped because their careers pages stopped working.`}
          </p>
          <p className="mt-1 text-xs text-ink/60">
            {health.dropped === 1 ? "It is" : "They are"} under Not tracked below,
            with the reason. Fix the careers URL or press Resume to start checking{" "}
            {health.dropped === 1 ? "it" : "them"} again.
          </p>
        </div>
      )}

      {health.behind && (
        <div className="mb-4 rounded-md border border-[#FDE68A] bg-[#FFFBEB] p-4">
          <p className="text-sm font-medium text-[#92400E]">
            {health.slipping} of your {health.tracked} tracked{" "}
            {health.tracked === 1 ? "company is" : "companies are"} behind schedule
            {health.worstDaysLate > 0
              ? `, the worst by ${health.worstDaysLate} day${health.worstDaysLate === 1 ? "" : "s"}`
              : ""}
            .
          </p>
          <p className="mt-1 text-xs text-[#92400E]/80">
            Checks are shared across everyone using the app, so a long list takes
            longer to get through. Track fewer companies, or give them a longer
            interval, and the schedule will hold.
            {health.failing > 0
              ? ` (${health.failing} more ${health.failing === 1 ? "is" : "are"} failing their checks — that is a broken careers page, not a capacity problem.)`
              : ""}
          </p>
        </div>
      )}

      {pendingUrl && !tracking && (
        <div className="mb-4 rounded-md border border-slate bg-white p-4">
          <p className="text-sm font-medium">That looks like a careers page.</p>
          <p className="mt-1 text-xs text-ink/60">
            The box takes a company name — it is what this company&apos;s roles are
            filed under. Name it and the URL below becomes its careers page.
          </p>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void track(pendingUrl.name.trim(), pendingUrl.url);
            }}
            className="mt-3 flex flex-wrap items-center gap-2"
          >
            <input
              autoFocus
              value={pendingUrl.name}
              onChange={(e) => setPendingUrl({ ...pendingUrl, name: e.target.value })}
              placeholder="Company name"
              className="w-56 rounded-md border border-slate px-3 py-1.5 text-sm"
            />
            <button
              type="submit"
              disabled={batchRunning || checkUnconfirmed || !pendingUrl.name.trim()}
              className="rounded-md border border-ink bg-ink px-4 py-1.5 text-sm font-medium text-white disabled:opacity-50"
            >
              Track
            </button>
            <button
              type="button"
              onClick={() => setPendingUrl(null)}
              className="text-sm text-ink/45 hover:text-ink"
            >
              Cancel
            </button>
            <span className="basis-full text-xs text-ink/40">{pendingUrl.url}</span>
          </form>
        </div>
      )}

      {tracking && (
        <div className="mb-4">
          <Spinner label="Tracking and running the first check…" />
        </div>
      )}

      {tracked.length > 0 && <div className="sticky top-0 z-20 mb-4 flex flex-wrap items-center gap-x-4 gap-y-2 border-y border-slate bg-white px-4 py-3" role="region" aria-label="Selected company actions">
        <label className="flex items-center gap-2 py-1 text-sm">
          <CompanySelectionCheckbox label={`Select all ${tracked.length} tracked companies`} checked={selectedNames.length === tracked.length}
            mixed={selectedNames.length > 0 && selectedNames.length < tracked.length} disabled={selectionBusy} onChange={() => toggleSelection(tracked.map(item => item.company))} />
          Select all {tracked.length}
        </label>
        <span className="text-sm font-semibold" role="status">{selectedNames.length} selected</span>
        {selectedNames.some(name => !visible.some(item => item.company === name)) && <span className="text-xs text-ink/70">{selectedNames.filter(name => !visible.some(item => item.company === name)).length} hidden by filters</span>}
        <div className="flex flex-wrap items-center gap-2 sm:ml-auto">
          <button type="button" disabled={selectionBusy || selectedNames.length === 0} onClick={() => void handleBatchCheck(selectedNames)} className="rounded-md border border-ink bg-ink px-3 py-2 text-sm font-medium text-white disabled:opacity-50">Check now</button>
          <button type="button" disabled={selectionBusy || selectedNames.length === 0} onClick={() => void prepareBulkAction("deep")} className="rounded-md border border-slate px-3 py-2 text-sm font-medium hover:border-ink disabled:opacity-50">Deep search…</button>
          <button type="button" disabled={selectionBusy || selectedNames.length === 0} onClick={() => void prepareBulkAction("remove")} className="rounded-md border border-slate px-3 py-2 text-sm font-medium hover:border-ink disabled:opacity-50">Remove…</button>
          {selectedNames.length > 0 && <button type="button" disabled={selectionBusy} onClick={() => {setSelected(new Set()); setBulkReview(null);}} className="px-1 py-2 text-sm underline underline-offset-2 disabled:opacity-50">Clear</button>}
        </div>
        {bulkBusy && <p className="w-full text-sm text-ink/70" role="status">{bulkBusy === "preparing" ? "Loading current Deep search recommendations…" : "Removing selected companies…"}</p>}
      </div>}
      {notice && !tracking && <div className="mb-4 rounded-md border border-slate bg-white p-3 text-sm text-ink/70" role="status">{notice}</div>}
      {restoreNotice && <RestoreCompanyReview key={restoreNotice.acknowledgementKey} notice={restoreNotice} onBusyChange={setTrackingBusy} onCancel={() => setRestoreNotice(null)} onRestored={message => {setRestoreNotice(null); setNotice(message); setNewCompany(""); setPendingUrl(null); void load(true);}} />}
      {bulkReview && <div id="watchlist-bulk-review" className="scroll-mt-48 sm:scroll-mt-28">
        <WatchlistBulkReview key={`${bulkReview.kind}:${JSON.stringify(bulkReview.names)}`} kind={bulkReview.kind} names={bulkReview.names}
          advice={searchAdvice} busy={selectionBusy} onCancel={() => setBulkReview(null)} onReview={reviewCompany}
          onRemove={reason => void removeSelectedCompanies(bulkReview.names, reason)}
          onSearch={ready => void handleBatchCheck(ready.map(item => item.company), "deep", Object.fromEntries(ready.map(item => [item.company, item.acknowledgementKey ?? ""])))} />
      </div>}

      {(tracked.length > 0 || batchProgress) && (
        <section id="watchlist-batch" className="mb-4 scroll-mt-48 rounded-lg border border-slate bg-white p-4 sm:scroll-mt-28" aria-label="Watchlist batch check">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h3 className="text-base font-semibold">{batchCandidates.length} {batchCandidates.length === 1 ? "company to check" : "companies to check"}</h3>
              <p className="mt-1 max-w-prose text-sm text-ink/70">
                Tick companies or a whole group, then choose an action above. Click a company name to view its details.
              </p>
              {batchCandidates.length > 0 && <label className="mt-2 flex items-center gap-2 text-sm">
                <CompanySelectionCheckbox label={`Select all ${batchCandidates.length} companies to check`} checked={batchCandidates.every(name => selected.has(name))}
                  mixed={batchCandidates.some(name => selected.has(name)) && !batchCandidates.every(name => selected.has(name))} disabled={selectionBusy} onChange={() => toggleSelection(batchCandidates)} />
                Select these {batchCandidates.length}
              </label>}
              <details className="mt-2 text-xs text-ink/60">
                <summary className="cursor-pointer">How the batch check works</summary>
                <p className="mt-1 max-w-prose">Checks due and unresolved companies one at a time. Keep this page open until it finishes. AI processing uses your spending limits; paid Deep search is not included. Unreadable sources may need a new careers link or Deep search.</p>
              </details>
            </div>
            {batchRunning ? (
              <button type="button" disabled={batchStopping} onClick={() => { stopBatch.current = true; setBatchStopping(true); }}
                className="rounded-md border border-slate px-3 py-2 text-sm font-medium hover:border-ink disabled:opacity-50">
                {batchStopping ? "Stopping after this company…" : "Stop after this company"}
              </button>
            ) : (
              <button type="button" onClick={() => void handleBatchCheck()}
                disabled={selectionBusy || batchCandidates.length === 0}
                className="rounded-md border border-ink bg-ink px-3 py-2 text-sm font-medium text-white hover:bg-ink/90 disabled:opacity-50">
                Check all {batchCandidates.length}
              </button>
            )}
          </div>
          {batchRunning && !batchProgress && <p className="mt-3 text-sm text-ink/60" role="status">Preparing checks…</p>}
          {checkUnconfirmed && <p className="mt-3 text-xs text-[#92400E]" role="alert">Checks are disabled because the last request may still be running. Reload to inspect saved results before retrying.</p>}
          {batchProgress && <><p className="mt-3 text-sm font-semibold">{batchMode === "deep" ? "Deep search results" : "Direct check results"}</p><WatchlistBatchResults progress={batchProgress} onReview={reviewCompany} /></>}
          {!batchRunning && batchCandidates.length > 0 && <div className="mt-4 border-t border-slate">
            <WatchlistCheckSelection companies={batchCandidates.map(name => companies.find(item => item.company === name)!)} onReview={reviewCompany} previousBatch={batchProgress}
              selection={{selected, disabled: selectionBusy, onToggle: toggleSelection}} />
          </div>}
        </section>
      )}

      {loading && <div className="py-12 text-center text-sm text-ink/40">Loading…</div>}

      {!loading && tracked.length === 0 && (
        <div className="rounded-md border border-dashed border-slate p-12 text-center text-sm text-ink/50">
          Nothing tracked yet. Add a company above, or hit &quot;Watch&quot; on any
          company in Discover.
        </div>
      )}

      {!loading && tracked.length > 0 && (
        <>
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <button
              onClick={() => setFilter("all")}
              className={chipClass(filter === "all")}
            >
              All {tracked.length}
            </button>
            {attentionCount > 0 && (
              <button
                onClick={() => setFilter("attention")}
                className={chipClass(filter === "attention")}
              >
                Needs you {attentionCount}
              </button>
            )}
            {dueCount > 0 && (
              <button
                onClick={() => setFilter("due")}
                className={chipClass(filter === "due")}
              >
                Due now {dueCount}
              </button>
            )}
            {/* The price of a colour-only status, paid where the colours are
                first seen rather than under the table. Rendered from the same
                STATE_STYLE map the rows use, so it cannot describe a colour
                they do not have. */}
            <div className="flex flex-wrap items-center gap-x-3.5 gap-y-1 pl-1 text-[11px] text-ink/45">
              {LEGEND.map((l) => (
                <span key={l.text} className="flex items-center gap-1.5">
                  <span className={`h-[7px] w-[7px] rounded-full ${l.dot}`} />
                  {l.text}
                </span>
              ))}
            </div>

            <label className="ml-auto flex items-center gap-2 text-xs text-ink/60">
              Sort by
              <select
                value={sort}
                onChange={(e) => setSort(e.target.value as Sort)}
                className="rounded-md border border-slate bg-white px-2 py-1 text-xs text-ink"
              >
                <option value="original">Default order</option>
                <option value="company-asc">Company: A–Z</option>
                <option value="company-desc">Company: Z–A</option>
                <option value="next-asc">Next check: soonest</option>
                <option value="next-desc">Next check: latest</option>
              </select>
            </label>
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Filter…"
              className="w-40 rounded-md border border-slate bg-white px-2 py-1 text-xs"
            />
          </div>

          <div className="overflow-hidden rounded-lg border border-slate bg-white">
            <div className="grid grid-cols-[1fr_auto] items-center gap-x-4 border-b border-slate px-4 py-2 text-[11px] font-medium text-ink/40 sm:grid-cols-[1fr_auto_7rem_4rem]">
              <label className="flex items-center gap-2 text-ink/70">
                <CompanySelectionCheckbox label={`Select all ${visible.length} visible companies`} checked={visible.length > 0 && visible.every(item => selected.has(item.company))}
                  mixed={visible.some(item => selected.has(item.company)) && !visible.every(item => selected.has(item.company))} disabled={selectionBusy || visible.length === 0} onChange={() => toggleSelection(visible.map(item => item.company))} />
                Select shown ({visible.length})
              </label>
              <span>Checked</span>
              <span className="hidden text-right sm:block">Next check</span>
              <span className="hidden sm:block" />
            </div>
            {visible.length === 0 ? (
              <p className="px-4 py-8 text-center text-sm text-ink/40">
                No company matches that filter.
              </p>
            ) : (
              visible.map(renderRow)
            )}
          </div>

        </>
      )}

      {!loading && untracked.length > 0 && (
        <div className="mt-6">
          <button
            onClick={() => setShowUntracked((v) => !v)}
            className="text-sm text-ink/50 hover:text-ink"
          >
            {showUntracked ? "▾" : "▸"} Not tracked ({untracked.length})
          </button>
          {showUntracked && (
            <div className="mt-2 overflow-hidden rounded-lg border border-slate bg-white">
              {untracked.map(renderUntrackedRow)}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
