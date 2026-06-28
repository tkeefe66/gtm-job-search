"use client";

import { useEffect, useState } from "react";
import { discoverStartups, getDiscoveredStartups, type DateRange } from "@/app/actions/discover";
import type { Startup } from "@/lib/types";
import { Spinner, Tag } from "./ui";

const DATE_RANGE_OPTIONS: { value: DateRange; label: string }[] = [
  { value: "7d", label: "7 days" },
  { value: "30d", label: "30 days" },
  { value: "3m", label: "3 months" },
  { value: "6m", label: "6 months" },
];

export default function Discover({
  onFindRoles,
  pendingSearch,
  onConsumeSearch,
}: {
  onFindRoles: (startup: Startup) => void;
  pendingSearch?: string | null;
  onConsumeSearch?: () => void;
}) {
  const [startups, setStartups] = useState<Startup[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingCached, setLoadingCached] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastTerm, setLastTerm] = useState<string | null>(null);
  const [dateRange, setDateRange] = useState<DateRange>("7d");
  const [fetchedAt, setFetchedAt] = useState<string | null>(null);

  // Load cached results whenever date range changes.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoadingCached(true);
      setError(null);
      const res = await getDiscoveredStartups(dateRange, lastTerm ?? undefined);
      if (cancelled) return;
      setStartups(res.startups);
      setFetchedAt(res.fetchedAt);
      setLoadingCached(false);
    })();
    return () => { cancelled = true; };
  }, [dateRange, lastTerm]);

  async function run(term?: string, range?: DateRange) {
    const activeRange = range ?? dateRange;
    setLoading(true);
    setError(null);
    setLastTerm(term ?? null);
    const res = await discoverStartups(term, activeRange);
    if (res.error) setError(res.error);
    setStartups(res.startups);
    setFetchedAt(new Date().toISOString());
    setLoading(false);
  }

  // Trigger from Insights "recommended next searches" chips.
  if (pendingSearch && onConsumeSearch && !loading && !loadingCached) {
    const term = pendingSearch;
    onConsumeSearch();
    void run(term);
  }

  const busy = loading || loadingCached;

  function formatFetchedAt(iso: string) {
    const d = new Date(iso);
    return d.toLocaleString(undefined, {
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
          <h2 className="text-xl font-heading font-semibold">
            Startup discovery
          </h2>
          <p className="text-sm text-ink/60">
            {lastTerm
              ? `Showing results for "${lastTerm}"`
              : "Notable AI/tech funding rounds."}
            {fetchedAt && !busy && (
              <span className="ml-2 text-ink/40">
                · Last fetched {formatFetchedAt(fetchedAt)}
              </span>
            )}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex overflow-hidden rounded-md border border-slate">
            {DATE_RANGE_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                onClick={() => setDateRange(opt.value)}
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
            onClick={() => run()}
            disabled={busy}
            className="rounded-md border border-ink bg-ink px-4 py-2 text-sm font-medium text-white transition hover:bg-ink/90 disabled:opacity-50"
          >
            {loading ? "Searching…" : "Refresh"}
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

      {!busy && !error && startups.length === 0 && (
        <div className="rounded-md border border-dashed border-slate p-12 text-center text-sm text-ink/50">
          No saved results for this range. Click &quot;Refresh&quot; to fetch.
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        {!busy && startups.map((s, i) => (
          <div
            key={`${s.company}-${i}`}
            className="flex flex-col rounded-lg border border-slate bg-white p-5"
          >
            <div className="mb-1 flex items-start justify-between gap-2">
              <h3 className="text-lg font-heading font-semibold">{s.company}</h3>
              {s.stage && <Tag>{s.stage}</Tag>}
            </div>
            <p className="mb-3 text-sm text-ink/70">{s.tagline}</p>

            <div className="mb-3 flex flex-wrap gap-2 text-xs">
              {s.raised && <Tag>Raised {s.raised}</Tag>}
              {s.category && <Tag>{s.category}</Tag>}
              {s.founded && <Tag>Founded {s.founded}</Tag>}
              {s.lead_investor && <Tag>Lead: {s.lead_investor}</Tag>}
            </div>

            {s.traction && (
              <p className="mb-4 text-sm text-ink/60">{s.traction}</p>
            )}

            <div className="mt-auto flex items-center gap-3 pt-2">
              <button
                onClick={() => onFindRoles(s)}
                className="rounded-md border border-ink px-3 py-1.5 text-sm font-medium transition hover:bg-ink hover:text-white"
              >
                Find product roles →
              </button>
              {s.careers_url && (
                <a
                  href={s.careers_url}
                  target="_blank"
                  rel="noreferrer"
                  className="text-sm text-ink/60 underline-offset-2 hover:underline"
                >
                  Careers
                </a>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
