"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  discoverStartups,
  getAllDiscoveredStartups,
  type DateRange,
  type DiscoveredStartup,
} from "@/app/actions/discover";
import { findAndSaveRoles } from "@/app/actions/roles";
import { addToWatchlist, setTracking, getWatchedCompanyNames } from "@/app/actions/watchlist";
import {
  buildWindowFilterOptions,
  filterByWindow,
  type WindowFilter,
} from "@/lib/discovery-window-filter";
import { Spinner, Tag } from "./ui";

// Controls what a NEW search asks Claude for.
const DATE_RANGE_OPTIONS: { value: DateRange; label: string }[] = [
  { value: "7d", label: "7 days" },
  { value: "30d", label: "30 days" },
  { value: "3m", label: "3 months" },
  { value: "6m", label: "6 months" },
  { value: "6-18m", label: "6–18 mo" },
];

export default function Discover() {
  const router = useRouter();
  const [startups, setStartups] = useState<DiscoveredStartup[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingCached, setLoadingCached] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [dateRange, setDateRange] = useState<DateRange>("7d");
  const [fetchedAt, setFetchedAt] = useState<string | null>(null);
  const [searchingRoles, setSearchingRoles] = useState<string | null>(null);
  const [watched, setWatched] = useState<Set<string>>(new Set());
  const [watchingCompany, setWatchingCompany] = useState<string | null>(null);
  // Slices the ALREADY-LOADED list by which cached window each company came
  // from. Purely presentational — never triggers a fetch, and independent of
  // `dateRange` above (which only affects what a NEW search asks for).
  // Defaults to "all" so the initial view matches pre-filter behavior exactly.
  const [windowFilter, setWindowFilter] = useState<WindowFilter>("all");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoadingCached(true);
      setError(null);
      const [res, watchedNames] = await Promise.all([
        getAllDiscoveredStartups(),
        getWatchedCompanyNames(),
      ]);
      if (cancelled) return;
      setStartups(res.startups.filter((s) => !watchedNames.has(s.company)));
      setFetchedAt(res.fetchedAt);
      setWatched(watchedNames);
      setLoadingCached(false);
    })();
    return () => { cancelled = true; };
  }, []);

  async function run() {
    setLoading(true);
    setError(null);
    const res = await discoverStartups(undefined, dateRange);
    if (res.error) setError(res.error);
    const all = await getAllDiscoveredStartups();
    setStartups(all.startups);
    setFetchedAt(new Date().toISOString());
    setLoading(false);
  }

  async function handleFindRoles(startup: DiscoveredStartup) {
    setSearchingRoles(startup.company);
    setError(null);
    const res = await findAndSaveRoles(startup);
    setSearchingRoles(null);
    if (res.error) {
      setError(`Couldn't search ${startup.company}: ${res.error}`);
      return;
    }
    if (!res.roles || res.roles.length === 0) {
      setError(
        res.message ||
          `No remote or Denver/CO GTM / RevOps roles found at ${startup.company} right now.`
      );
      return;
    }
    router.push("/roles");
  }

  async function handleWatch(startup: DiscoveredStartup) {
    setWatchingCompany(startup.company);
    if (watched.has(startup.company)) {
      // Soft-disable, not delete: crawl history, the learned careers_url,
      // crawl_method, and failure counters must survive an un-star so
      // re-watching doesn't cost a fresh resolveCareersUrl() search. The
      // Watchlist page's own "Stop tracking" button already works this way;
      // removeFromWatchlist stays exported as the explicit hard-delete.
      await setTracking(startup.company, false);
      setWatched((prev) => { const n = new Set(prev); n.delete(startup.company); return n; });
      setStartups((prev) => [...prev, startup]);
    } else {
      await addToWatchlist(startup);
      setWatched((prev) => new Set(prev).add(startup.company));
      setStartups((prev) => prev.filter((s) => s.company !== startup.company));
    }
    setWatchingCompany(null);
  }

  const busy = loading || loadingCached;

  // Chips for windows that actually have loaded companies, plus "All". Not
  // rendered as a control at all until there's more than one real range to
  // pick between — a single-option toggle would just be noise.
  const windowFilterOptions = buildWindowFilterOptions(
    startups.map((s) => s.discovered_range),
    DATE_RANGE_OPTIONS
  );
  const showWindowFilter = windowFilterOptions.length > 2;
  const displayed = filterByWindow(startups, windowFilter);
  const hiddenByFilter = startups.length > 0 && displayed.length === 0;

  function rangeLabel(range: DateRange): string {
    return DATE_RANGE_OPTIONS.find((opt) => opt.value === range)?.label ?? range;
  }

  function formatFetchedAt(iso: string) {
    return new Date(iso).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  }

  return (
    <div>
      <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-xl font-heading font-semibold">Startup discovery</h2>
          <p className="text-sm text-ink/60">
            Notable AI/tech funding rounds.
            {fetchedAt && !busy && (
              <span className="ml-2 text-ink/40">
                · Last fetched {formatFetchedAt(fetchedAt)}
              </span>
            )}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {/* Date range selector — controls what a NEW search asks for. */}
          <div className="flex items-center gap-1.5">
            <span className="text-xs font-medium text-ink/40">Search window</span>
            <div className="flex overflow-hidden rounded-md border border-slate">
              {DATE_RANGE_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  onClick={() => setDateRange(opt.value)}
                  disabled={busy}
                  className={`px-3 py-1.5 text-sm transition ${
                    dateRange === opt.value
                      ? "bg-ink text-white"
                      : "bg-white text-ink hover:bg-canvas"
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>

          <button
            onClick={run}
            disabled={busy}
            className="rounded-md border border-ink bg-ink px-4 py-2 text-sm font-medium text-white transition hover:bg-ink/90 disabled:opacity-50"
          >
            {loading ? "Discovering…" : "Discover"}
          </button>
        </div>
      </div>

      {showWindowFilter && !busy && (
        <div className="mb-4 flex flex-wrap items-center gap-1.5">
          <span className="text-xs font-medium text-ink/40">
            Show ({startups.length})
          </span>
          <div className="flex flex-wrap overflow-hidden rounded-md border border-slate">
            {windowFilterOptions.map((opt) => (
              <button
                key={opt.value}
                onClick={() => setWindowFilter(opt.value)}
                className={`px-3 py-1 text-xs transition ${
                  windowFilter === opt.value
                    ? "bg-ink text-white"
                    : "bg-white text-ink hover:bg-canvas"
                }`}
              >
                {opt.label} ({opt.count})
              </button>
            ))}
          </div>
        </div>
      )}

      {busy && (
        <div className="py-12">
          <Spinner label={loading ? "Searching funding news…" : "Loading saved results…"} />
        </div>
      )}

      {error && !busy && (
        <div className="rounded-md border border-slate bg-white p-4 text-sm text-[#92400E]">
          {error}
        </div>
      )}

      {!busy && !error && displayed.length === 0 && !hiddenByFilter && (
        <div className="rounded-md border border-dashed border-slate p-12 text-center text-sm text-ink/50">
          No saved results yet. Click &quot;Discover&quot; to fetch.
        </div>
      )}

      {!busy && !error && hiddenByFilter && (
        <div className="rounded-md border border-dashed border-slate p-12 text-center text-sm text-ink/50">
          No companies in this window.{" "}
          <button
            onClick={() => setWindowFilter("all")}
            className="underline-offset-2 hover:underline"
          >
            Show all {startups.length}
          </button>
        </div>
      )}

      {!busy && displayed.length > 0 && (
        <div className="overflow-hidden rounded-lg border border-slate bg-white">
          {displayed.map((s, i) => (
            <div
              key={`${s.company}-${i}`}
              className={`flex flex-col gap-2 p-4 sm:flex-row sm:items-center ${
                i > 0 ? "border-t border-slate" : ""
              }`}
            >
              {/* Company + meta */}
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-heading font-semibold">{s.company}</span>
                  {s.stage && <Tag>{s.stage}</Tag>}
                  {s.raised && <Tag>{s.raised}</Tag>}
                  {s.category && <Tag>{s.category}</Tag>}
                  <Tag>{rangeLabel(s.discovered_range)}</Tag>
                  {s.headquarters && (
                    <span className="text-xs text-ink/40">{s.headquarters}</span>
                  )}
                </div>
                <p className="mt-0.5 text-sm text-ink/60 line-clamp-1">{s.tagline}</p>
                {s.traction && (
                  <p className="mt-0.5 text-xs text-ink/40 line-clamp-1">{s.traction}</p>
                )}
              </div>

              {/* Actions */}
              <div className="flex shrink-0 items-center gap-3">
                <button
                  onClick={() => handleFindRoles(s)}
                  disabled={!!searchingRoles}
                  className="rounded-md border border-ink px-3 py-1.5 text-sm font-medium transition hover:bg-ink hover:text-white disabled:opacity-50"
                >
                  {searchingRoles === s.company ? "Searching…" : "Find roles →"}
                </button>
                <button
                  onClick={() => handleWatch(s)}
                  disabled={!!watchingCompany}
                  className={`rounded-md border px-3 py-1.5 text-sm font-medium transition disabled:opacity-50 ${
                    watched.has(s.company)
                      ? "border-ink/30 bg-canvas text-ink/50 hover:border-[#92400E] hover:text-[#92400E]"
                      : "border-slate text-ink/50 hover:border-ink hover:text-ink"
                  }`}
                >
                  {watchingCompany === s.company ? "…" : watched.has(s.company) ? "Watching ✓" : "Watch"}
                </button>
                {s.careers_url && (
                  <a
                    href={s.careers_url}
                    target="_blank"
                    rel="noreferrer"
                    className="text-sm text-ink/50 underline-offset-2 hover:underline"
                  >
                    Careers
                  </a>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
