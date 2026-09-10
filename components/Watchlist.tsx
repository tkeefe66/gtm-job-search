"use client";

import { useEffect, useMemo, useState } from "react";
import {
  checkCompanyNow,
  getTrackedCompanies,
  renameTrackedCompany,
  setCareersUrl,
  setCrawlInterval,
  setIgnoreLocationRule,
  setTracking,
  trackCompanyByName,
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
  // Which rows are open. Keyed by company for the same reason busyRows is: the
  // list reloads after every mutation, so an index would reopen the wrong row.
  const [openRows, setOpenRows] = useState<Set<string>>(new Set());
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
      if (res.error) setNotice(res.error);
      else if (res.outcome) setNotice(`${name}: ${describe(res.outcome)}`);
      if (!res.error) {
        setNewCompany("");
        setPendingUrl(null);
      }
      await load();
    } finally {
      setTrackingBusy(false);
    }
  }

  async function handleRename(from: string, to: string) {
    setRowBusy(from, true);
    setNotice(null);
    try {
      const res = await renameTrackedCompany(from, to);
      if (res.error) {
        setNotice(res.error);
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
      setRenaming(null);
      setNotice(`Renamed to "${res.company}".`);
      await load();
    } finally {
      setRowBusy(from, false);
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

  async function handleSetIgnoreLocationRule(company: string, ignore: boolean) {
    setRowBusy(company, true);
    try {
      const res = await setIgnoreLocationRule(company, ignore);
      if (res.error) setNotice(res.error);
      await load();
    } finally {
      setRowBusy(company, false);
    }
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
      isDue: isDue(c.last_checked_at, c.crawl_interval_days),
    });
  }

  const attentionCount = tracked.filter((c) => needsYou(stateOf(c))).length;
  const dueCount = tracked.filter((c) => stateOf(c) === "due").length;

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
      const aDue = nextCheckDue(a.last_checked_at, a.crawl_interval_days)?.getTime() ?? -Infinity;
      const bDue = nextCheckDue(b.last_checked_at, b.crawl_interval_days)?.getTime() ?? -Infinity;
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
    const state = stateOf(c);
    const style = STATE_STYLE[state];
    const due = nextCheckDue(c.last_checked_at, c.crawl_interval_days);
    const open = openRows.has(c.company);
    const busy = busyRows.has(c.company);
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
      <div key={c.company} className={i > 0 ? "border-t border-slate" : ""}>
        <div
          onClick={() => toggleRow(c.company)}
          className="grid cursor-pointer grid-cols-[1fr_auto] items-center gap-x-4 px-4 py-2.5 transition hover:bg-canvas sm:grid-cols-[1fr_auto_7rem_4rem]"
        >
          <div className="flex min-w-0 items-center gap-2.5">
            <span
              className={`h-[7px] w-[7px] flex-none rounded-full ${style.dot}`}
              title={style.legend}
            />
            <span className="font-heading text-sm font-semibold">{c.company}</span>
            <span className="hidden truncate text-xs text-ink/45 sm:block">
              {c.signal ?? c.tagline ?? ""}
            </span>
            {needsYou(state) && (
              <span className="flex-none rounded-full bg-[#FEF3C7] px-2 py-0.5 text-[11px] font-medium text-[#92400E]">
                {style.label}
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
                    className="mb-2 text-xs text-ink/45 underline-offset-2 hover:text-ink hover:underline"
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
                  {c.last_checked_at
                    ? ` · Last checked ${formatDate(c.last_checked_at)}`
                    : " · Never checked"}
                </p>
                {state === "empty" && (
                  <p className="mt-1 text-xs text-ink/40">
                    No matching roles on the last check.
                  </p>
                )}
                {state === "failing" && (
                  <p className="mt-1 text-xs text-[#92400E]">
                    Failing — {c.consecutive_failures} checks in a row.
                    {c.last_crawl_error ? ` ${c.last_crawl_error}` : ""}
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
              <span className="flex-1" />
              <button
                onClick={() => handleSetTracking(c.company, false)}
                disabled={busy}
                className="text-sm text-ink/30 transition hover:text-[#92400E] disabled:opacity-50"
              >
                Stop tracking
              </button>
            </div>
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
        className={`flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 ${
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
            : "You switched checking off."}
        </span>
        <button
          onClick={() => handleSetTracking(c.company, true)}
          disabled={busyRows.has(c.company)}
          className="rounded-md border border-slate px-2.5 py-1 text-xs font-medium text-ink/60 transition hover:border-ink hover:text-ink disabled:opacity-50"
        >
          Resume
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
      lastCheckedAt: c.last_checked_at,
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
            land in Roles, already scored.
          </p>
        </div>

        <form onSubmit={handleTrack} className="flex flex-wrap items-center gap-2">
          <input
            type="text"
            value={newCompany}
            onChange={(e) => setNewCompany(e.target.value)}
            disabled={tracking}
            placeholder="Track a company by name…"
            className="w-56 rounded-md border border-slate bg-white px-3 py-1.5 text-sm disabled:opacity-50"
          />
          <button
            type="submit"
            disabled={tracking || !newCompany.trim()}
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
              disabled={!pendingUrl.name.trim()}
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
              <span>Company</span>
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
