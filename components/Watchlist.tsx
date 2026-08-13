"use client";

import { useEffect, useState } from "react";
import {
  checkCompanyNow,
  getTrackedCompanies,
  setCareersUrl,
  setTracking,
  trackCompanyByName,
} from "@/app/actions/watchlist";
import { isDue, nextCheckDue } from "@/lib/crawl-schedule";
import type { CrawlOutcome } from "@/lib/crawler";
import type { TrackedCompany } from "@/lib/types";
import { Spinner, Tag } from "./ui";

export default function Watchlist() {
  const [companies, setCompanies] = useState<TrackedCompany[]>([]);
  const [loading, setLoading] = useState(true);
  const [newCompany, setNewCompany] = useState("");
  const [tracking, setTrackingBusy] = useState(false);
  const [checking, setChecking] = useState<string | null>(null);
  const [busyRow, setBusyRow] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [urlDrafts, setUrlDrafts] = useState<Record<string, string>>({});
  const [showUntracked, setShowUntracked] = useState(false);

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
    const res = await trackCompanyByName(name);
    setTrackingBusy(false);
    if (res.error) setNotice(res.error);
    else if (res.outcome) setNotice(`${name}: ${describe(res.outcome)}`);
    setNewCompany("");
    await load();
  }

  async function handleCheckNow(company: string) {
    setChecking(company);
    setNotice(null);
    const outcome = await checkCompanyNow(company);
    setChecking(null);
    setNotice(`${company}: ${describe(outcome)}`);
    await load();
  }

  async function handleSetTracking(company: string, enabled: boolean) {
    setBusyRow(company);
    const res = await setTracking(company, enabled);
    setBusyRow(null);
    if (res.error) setNotice(res.error);
    await load();
  }

  async function handleSaveUrl(company: string) {
    const url = (urlDrafts[company] ?? "").trim();
    setBusyRow(company);
    try {
      const res = await setCareersUrl(company, url);
      if (res.error) {
        setNotice(res.error);
        return;
      }
      setUrlDrafts((prev) => ({ ...prev, [company]: "" }));
      await handleCheckNow(company);
    } finally {
      setBusyRow(null);
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

  function renderRow(c: TrackedCompany, i: number) {
    const due = nextCheckDue(c.last_checked_at, c.crawl_interval_days);
    const failing = c.consecutive_failures >= 3;

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

          {failing && (
            <p className="mt-1 text-xs text-[#92400E]">
              Failing — {c.consecutive_failures} checks in a row.
              {c.last_crawl_error ? ` ${c.last_crawl_error}` : ""}
            </p>
          )}

          {c.last_crawl_status === "needs_url" && (
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <input
                type="text"
                value={urlDrafts[c.company] ?? ""}
                onChange={(e) =>
                  setUrlDrafts((prev) => ({ ...prev, [c.company]: e.target.value }))
                }
                placeholder="https://company.com/careers"
                className="w-72 rounded-md border border-slate px-2 py-1 text-sm"
              />
              <button
                onClick={() => handleSaveUrl(c.company)}
                disabled={busyRow === c.company}
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
                disabled={busyRow === c.company}
                className="text-sm text-ink/30 transition hover:text-[#92400E] disabled:opacity-50"
              >
                Stop tracking
              </button>
            </>
          ) : (
            <button
              onClick={() => handleSetTracking(c.company, true)}
              disabled={busyRow === c.company}
              className="rounded-md border border-slate px-3 py-1.5 text-sm font-medium text-ink/60 transition hover:border-ink hover:text-ink disabled:opacity-50"
            >
              Resume
            </button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div>
      <div className="mb-6">
        <h2 className="text-xl font-heading font-semibold">Tracked companies</h2>
        <p className="text-sm text-ink/60">
          Tracked companies have their careers page checked automatically. New roles
          land in Roles, already scored.
        </p>
      </div>

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
