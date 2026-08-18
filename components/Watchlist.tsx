"use client";

import { useEffect, useState } from "react";
import {
  checkCompanyNow,
  getTrackedCompanies,
  setCareersUrl,
  setCrawlInterval,
  setTracking,
  trackCompanyByName,
} from "@/app/actions/watchlist";
import { isDue, nextCheckDue } from "@/lib/crawl-schedule";
import { summarizeCrawlHealth } from "@/lib/crawl-health";
import { stoppedTrackingReason } from "@/lib/dead-tracking";
import type { CrawlOutcome } from "@/lib/crawler";
import type { TrackedCompany } from "@/lib/types";
import { Spinner, Tag } from "./ui";

export default function Watchlist() {
  const [companies, setCompanies] = useState<TrackedCompany[]>([]);
  const [loading, setLoading] = useState(true);
  const [newCompany, setNewCompany] = useState("");
  const [tracking, setTrackingBusy] = useState(false);
  const [checking, setChecking] = useState<string | null>(null);
  // Per-row lock. Must be a collection, not a single string — a single
  // shared value lets a second row's action overwrite it mid-flight and
  // spuriously re-enable the first row's button while its own mutation is
  // still in progress. Always mutate via setRowBusy (add/delete), never
  // overwrite wholesale.
  const [busyRows, setBusyRows] = useState<Set<string>>(new Set());
  const [notice, setNotice] = useState<string | null>(null);
  const [urlDrafts, setUrlDrafts] = useState<Record<string, string>>({});
  const [showUntracked, setShowUntracked] = useState(false);

  function setRowBusy(company: string, busy: boolean) {
    setBusyRows((prev) => {
      const next = new Set(prev);
      if (busy) next.add(company);
      else next.delete(company);
      return next;
    });
  }

  useEffect(() => {
    load();
  }, []);

  async function load() {
    setLoading(true);
    const res = await getTrackedCompanies();
    if (res.error) setNotice(`Couldn't load your list: ${res.error}`);
    setCompanies(res.companies);
    setLoading(false);
  }

  function describe(outcome: CrawlOutcome): string {
    if (outcome.status === "error") return outcome.error ?? "Check failed.";
    if (outcome.status === "needs_url") {
      return outcome.error ?? "No careers page found — add one below.";
    }
    if (outcome.status === "empty") return "No matching roles right now.";
    return `${outcome.rolesFound} role${outcome.rolesFound === 1 ? "" : "s"} found, ${outcome.newRoles} new.`;
  }

  async function handleTrack(e: React.FormEvent) {
    e.preventDefault();
    const name = newCompany.trim();
    if (!name) return;
    setTrackingBusy(true);
    setNotice(null);
    try {
      const res = await trackCompanyByName(name);
      if (res.error) setNotice(res.error);
      else if (res.outcome) setNotice(`${name}: ${describe(res.outcome)}`);
      setNewCompany("");
      await load();
    } finally {
      setTrackingBusy(false);
    }
  }

  async function handleCheckNow(company: string) {
    setChecking(company);
    setNotice(null);
    try {
      const outcome = await checkCompanyNow(company);
      setNotice(`${company}: ${describe(outcome)}`);
      await load();
    } finally {
      setChecking(null);
    }
  }

  async function handleSetTracking(company: string, enabled: boolean) {
    setRowBusy(company, true);
    try {
      const res = await setTracking(company, enabled);
      if (res.error) setNotice(res.error);
      await load();
    } finally {
      setRowBusy(company, false);
    }
  }

  async function handleSaveUrl(company: string) {
    // Fall back to the row's current careers_url, not "": the field is now
    // pre-filled from it for every tracked row, so clicking Save without
    // editing must resubmit what's displayed, not an empty string that would
    // fail setCareersUrl's http(s):// check.
    const current = companies.find((c) => c.company === company)?.careers_url ?? "";
    const url = (urlDrafts[company] ?? current).trim();
    setRowBusy(company, true);
    try {
      const res = await setCareersUrl(company, url);
      if (res.error) {
        setNotice(res.error);
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

  function formatDate(iso: string) {
    return new Date(iso).toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  }

  const tracked = companies.filter((c) => c.tracking_enabled);
  const untracked = companies.filter((c) => !c.tracking_enabled);

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

  function renderRow(c: TrackedCompany, i: number) {
    const due = nextCheckDue(c.last_checked_at, c.crawl_interval_days);
    const failing = c.consecutive_failures >= 3;
    // Only the crawler leaves failing_since set on a switched-off row — a manual
    // toggle clears it — so this distinguishes "we gave up" from "you turned it
    // off", which need different sentences and different remedies.
    const droppedAsDead = !c.tracking_enabled && c.failing_since !== null;

    return (
      <div
        key={c.company}
        className={`flex flex-col gap-2 p-4 sm:flex-row sm:items-start ${
          i > 0 ? "border-t border-slate" : ""
        }`}
      >
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-heading font-semibold">{c.company}</span>
            {c.stage && <Tag>{c.stage}</Tag>}
            {c.raised && <Tag>{c.raised}</Tag>}
            {c.category && <Tag>{c.category}</Tag>}
            {c.source && <Tag>via {c.source}</Tag>}
          </div>

          {c.tagline && (
            <p className="mt-0.5 text-sm text-ink/60 line-clamp-1">{c.tagline}</p>
          )}

          {c.tracking_enabled && (
            <label className="mt-1 flex items-center gap-1 text-xs text-ink/50">
              Check every
              <select
                value={c.crawl_interval_days}
                disabled={busyRows.has(c.company)}
                onChange={(e) => void changeInterval(c.company, Number(e.target.value))}
                className="rounded border border-slate bg-white px-1 py-0.5 text-xs disabled:opacity-40"
              >
                {[1, 3, 7, 14, 30, 90].map((d) => (
                  <option key={d} value={d}>
                    {d === 1 ? "day" : `${d} days`}
                  </option>
                ))}
              </select>
            </label>
          )}

          <p className="mt-1 text-xs text-ink/40">
            Added {formatDate(c.added_at)}
            {c.last_checked_at
              ? ` · Last checked ${formatDate(c.last_checked_at)}`
              : " · Never checked"}
            {c.tracking_enabled &&
              (isDue(c.last_checked_at, c.crawl_interval_days)
                ? " · Due now"
                : due
                  ? ` · Next check ${formatDate(due.toISOString())}`
                  : "")}
          </p>

          {c.last_crawl_status === "empty" && (
            <p className="mt-1 text-xs text-ink/40">No matching roles on the last check.</p>
          )}

          {droppedAsDead ? (
            <p className="mt-1 text-xs text-[#92400E]">
              {stoppedTrackingReason(c.consecutive_failures)}
              {c.last_crawl_error ? ` Last error: ${c.last_crawl_error}` : ""}
            </p>
          ) : (
            failing && (
              <p className="mt-1 text-xs text-[#92400E]">
                Failing — {c.consecutive_failures} checks in a row.
                {c.last_crawl_error ? ` ${c.last_crawl_error}` : ""}
              </p>
            )
          )}

          {c.tracking_enabled && (
            <div
              className={`mt-2 flex flex-wrap items-center gap-2 ${
                c.last_crawl_status === "needs_url"
                  ? "rounded-md border border-[#92400E]/30 bg-[#92400E]/5 p-2"
                  : ""
              }`}
            >
              {c.last_crawl_status === "needs_url" ? (
                <span className="text-xs font-medium text-[#92400E]">
                  No careers page found — add one:
                </span>
              ) : (
                <span className="text-xs text-ink/40">Careers URL:</span>
              )}
              <input
                type="text"
                value={urlDrafts[c.company] ?? c.careers_url ?? ""}
                onChange={(e) =>
                  setUrlDrafts((prev) => ({ ...prev, [c.company]: e.target.value }))
                }
                placeholder="https://company.com/careers"
                className="w-72 rounded-md border border-slate px-2 py-1 text-sm"
              />
              <button
                onClick={() => handleSaveUrl(c.company)}
                disabled={busyRows.has(c.company)}
                className="rounded-md border border-ink px-2 py-1 text-xs font-medium transition hover:bg-ink hover:text-white disabled:opacity-50"
              >
                Save careers URL
              </button>
            </div>
          )}
        </div>

        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {c.tracking_enabled ? (
            <>
              <button
                onClick={() => handleCheckNow(c.company)}
                disabled={!!checking}
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
              <button
                onClick={() => handleSetTracking(c.company, false)}
                disabled={busyRows.has(c.company)}
                className="text-sm text-ink/30 transition hover:text-[#92400E] disabled:opacity-50"
              >
                Stop tracking
              </button>
            </>
          ) : (
            <button
              onClick={() => handleSetTracking(c.company, true)}
              disabled={busyRows.has(c.company)}
              className="rounded-md border border-slate px-3 py-1.5 text-sm font-medium text-ink/60 transition hover:border-ink hover:text-ink disabled:opacity-50"
            >
              Resume
            </button>
          )}
        </div>
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
      lastCheckedAt: c.last_checked_at,
      failingSince: c.failing_since,
    }))
  );

  return (
    <div>
      <div className="mb-6">
        <h2 className="text-xl font-heading font-semibold">Tracked companies</h2>
        <p className="text-sm text-ink/60">
          Tracked companies have their careers page checked automatically. New roles
          land in Roles, already scored.
        </p>
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
        <div className="mb-6 rounded-md border border-[#FDE68A] bg-[#FFFBEB] p-4">
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

      <form onSubmit={handleTrack} className="mb-6 flex flex-wrap items-center gap-2">
        <input
          type="text"
          value={newCompany}
          onChange={(e) => setNewCompany(e.target.value)}
          disabled={tracking}
          placeholder="Track a company by name…"
          className="w-72 rounded-md border border-slate px-3 py-2 text-sm disabled:opacity-50"
        />
        <button
          type="submit"
          disabled={tracking || !newCompany.trim()}
          className="rounded-md border border-ink bg-ink px-4 py-2 text-sm font-medium text-white transition hover:bg-ink/90 disabled:opacity-50"
        >
          Track
        </button>
      </form>

      {tracking && (
        <div className="mb-4">
          <Spinner label="Tracking and running the first check…" />
        </div>
      )}

      {notice && !tracking && (
        <div className="mb-4 rounded-md border border-slate bg-white p-3 text-sm text-ink/70">
          {notice}
        </div>
      )}

      {loading && <div className="py-12 text-center text-sm text-ink/40">Loading…</div>}

      {!loading && tracked.length === 0 && (
        <div className="rounded-md border border-dashed border-slate p-12 text-center text-sm text-ink/50">
          Nothing tracked yet. Add a company above, or hit &quot;Watch&quot; on any
          company in Discover.
        </div>
      )}

      {!loading && tracked.length > 0 && (
        <div className="overflow-hidden rounded-lg border border-slate bg-white">
          {tracked.map(renderRow)}
        </div>
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
            <div className="mt-2 overflow-hidden rounded-lg border border-slate bg-white opacity-70">
              {untracked.map(renderRow)}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
