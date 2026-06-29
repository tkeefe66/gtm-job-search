"use client";

import { useEffect, useState, useMemo } from "react";
import { useRouter } from "next/navigation";
import { discoverStartups, getAllDiscoveredStartups, type DateRange } from "@/app/actions/discover";
import { findAndSaveRoles } from "@/app/actions/roles";
import { addToWatchlist, removeFromWatchlist, getWatchedCompanyNames } from "@/app/actions/watchlist";
import type { Startup } from "@/lib/types";
import { Spinner, Tag } from "./ui";

const DATE_RANGE_OPTIONS: { value: DateRange; label: string }[] = [
  { value: "7d", label: "7 days" },
  { value: "30d", label: "30 days" },
  { value: "3m", label: "3 months" },
  { value: "6m", label: "6 months" },
];

const SF_KEYWORDS = ["san francisco", "sf", "bay area", "palo alto", "menlo park", "mountain view", "santa clara", "san jose", "oakland", "berkeley", "redwood city", "remote"];

function isSfOrRemote(hq: string | undefined): boolean {
  if (!hq) return true; // no data — show by default
  const lower = hq.toLowerCase();
  return SF_KEYWORDS.some((kw) => lower.includes(kw));
}

export default function Discover() {
  const router = useRouter();
  const [startups, setStartups] = useState<Startup[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingCached, setLoadingCached] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [dateRange, setDateRange] = useState<DateRange>("7d");
  const [fetchedAt, setFetchedAt] = useState<string | null>(null);
  const [searchingRoles, setSearchingRoles] = useState<string | null>(null);
  const [sfOnly, setSfOnly] = useState(true);
  const [watched, setWatched] = useState<Set<string>>(new Set());
  const [watchingCompany, setWatchingCompany] = useState<string | null>(null);

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
      setStartups(res.startups);
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

  async function handleFindRoles(startup: Startup) {
    setSearchingRoles(startup.company);
    await findAndSaveRoles(startup);
    setSearchingRoles(null);
    router.push("/roles");
  }

  async function handleWatch(startup: Startup) {
    setWatchingCompany(startup.company);
    if (watched.has(startup.company)) {
      await removeFromWatchlist(startup.company);
      setWatched((prev) => { const n = new Set(prev); n.delete(startup.company); return n; });
    } else {
      await addToWatchlist(startup);
      setWatched((prev) => new Set(prev).add(startup.company));
    }
    setWatchingCompany(null);
  }

  const busy = loading || loadingCached;

  const displayed = useMemo(() => {
    if (!sfOnly) return startups;
    return startups.filter((s) => isSfOrRemote(s.headquarters));
  }, [startups, sfOnly]);

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
          {/* SF filter toggle */}
          <button
            onClick={() => setSfOnly((v) => !v)}
            disabled={busy}
            className={`rounded-full border px-3 py-1.5 text-sm font-medium transition disabled:opacity-50 ${
              sfOnly
                ? "border-ink bg-ink text-white"
                : "border-slate bg-white text-ink hover:border-ink"
            }`}
          >
            SF + Remote
          </button>

          {/* Date range selector */}
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

          <button
            onClick={run}
            disabled={busy}
            className="rounded-md border border-ink bg-ink px-4 py-2 text-sm font-medium text-white transition hover:bg-ink/90 disabled:opacity-50"
          >
            {loading ? "Discovering…" : "Discover"}
          </button>
        </div>
      </div>

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

      {!busy && !error && displayed.length === 0 && (
        <div className="rounded-md border border-dashed border-slate p-12 text-center text-sm text-ink/50">
          {sfOnly && startups.length > 0
            ? `No SF or remote companies in your saved results. Toggle off "SF + Remote" to see all ${startups.length}.`
            : "No saved results yet. Click \"Discover\" to fetch."}
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
