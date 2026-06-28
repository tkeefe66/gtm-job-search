"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { discoverStartups, getDiscoveredStartups, type DateRange } from "@/app/actions/discover";
import { findAndSaveRoles } from "@/app/actions/roles";
import type { Startup } from "@/lib/types";
import { Spinner, Tag } from "./ui";

const DATE_RANGE_OPTIONS: { value: DateRange; label: string }[] = [
  { value: "7d", label: "7 days" },
  { value: "30d", label: "30 days" },
  { value: "3m", label: "3 months" },
  { value: "6m", label: "6 months" },
];

export default function Discover() {
  const router = useRouter();
  const [startups, setStartups] = useState<Startup[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingCached, setLoadingCached] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [dateRange, setDateRange] = useState<DateRange>("7d");
  const [fetchedAt, setFetchedAt] = useState<string | null>(null);
  const [searchingRoles, setSearchingRoles] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoadingCached(true);
      setError(null);
      const res = await getDiscoveredStartups(dateRange);
      if (cancelled) return;
      setStartups(res.startups);
      setFetchedAt(res.fetchedAt);
      setLoadingCached(false);
    })();
    return () => { cancelled = true; };
  }, [dateRange]);

  async function run() {
    setLoading(true);
    setError(null);
    const res = await discoverStartups(undefined, dateRange);
    if (res.error) setError(res.error);
    setStartups(res.startups);
    setFetchedAt(new Date().toISOString());
    setLoading(false);
  }

  async function handleFindRoles(startup: Startup) {
    setSearchingRoles(startup.company);
    await findAndSaveRoles(startup);
    setSearchingRoles(null);
    router.push("/roles");
  }

  const busy = loading || loadingCached;

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

      {!busy && startups.length > 0 && (
        <div className="overflow-hidden rounded-lg border border-slate bg-white">
          {startups.map((s, i) => (
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
                  disabled={searchingRoles === s.company}
                  className="rounded-md border border-ink px-3 py-1.5 text-sm font-medium transition hover:bg-ink hover:text-white disabled:opacity-50"
                >
                  {searchingRoles === s.company ? "Searching…" : "Find roles →"}
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
