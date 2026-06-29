"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { getWatchlist, removeFromWatchlist, markChecked, type WatchlistEntry } from "@/app/actions/watchlist";
import { findAndSaveRoles } from "@/app/actions/roles";
import { Tag } from "./ui";

export default function Watchlist() {
  const router = useRouter();
  const [entries, setEntries] = useState<WatchlistEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchingRoles, setSearchingRoles] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);

  useEffect(() => {
    load();
  }, []);

  async function load() {
    setLoading(true);
    const res = await getWatchlist();
    setEntries(res.entries);
    setLoading(false);
  }

  async function handleFindRoles(entry: WatchlistEntry) {
    setSearchingRoles(entry.company);
    await markChecked(entry.company);
    await findAndSaveRoles({
      company: entry.company,
      tagline: entry.tagline,
      raised: entry.raised,
      stage: entry.stage,
      category: entry.category,
      careers_url: entry.careers_url,
      headquarters: entry.headquarters,
      lead_investor: "",
      founded: "",
      traction: "",
    });
    setSearchingRoles(null);
    router.push("/roles");
  }

  async function handleRemove(company: string) {
    setRemoving(company);
    await removeFromWatchlist(company);
    setEntries((prev) => prev.filter((e) => e.company !== company));
    setRemoving(null);
  }

  async function handleMarkChecked(company: string) {
    await markChecked(company);
    setEntries((prev) =>
      prev.map((e) =>
        e.company === company ? { ...e, last_checked_at: new Date().toISOString() } : e
      )
    );
  }

  function formatDate(iso: string) {
    return new Date(iso).toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  }

  return (
    <div>
      <div className="mb-6">
        <h2 className="text-xl font-heading font-semibold">Watchlist</h2>
        <p className="text-sm text-ink/60">
          Companies you're interested in but have no open roles right now. Check back periodically.
        </p>
      </div>

      {loading && (
        <div className="py-12 text-center text-sm text-ink/40">Loading…</div>
      )}

      {!loading && entries.length === 0 && (
        <div className="rounded-md border border-dashed border-slate p-12 text-center text-sm text-ink/50">
          No companies on your watchlist yet. Hit "Watch" on any company in Discover to add them here.
        </div>
      )}

      {!loading && entries.length > 0 && (
        <div className="overflow-hidden rounded-lg border border-slate bg-white">
          {entries.map((entry, i) => (
            <div
              key={entry.company}
              className={`flex flex-col gap-2 p-4 sm:flex-row sm:items-start ${i > 0 ? "border-t border-slate" : ""}`}
            >
              {/* Company info */}
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-heading font-semibold">{entry.company}</span>
                  {entry.stage && <Tag>{entry.stage}</Tag>}
                  {entry.raised && <Tag>{entry.raised}</Tag>}
                  {entry.category && <Tag>{entry.category}</Tag>}
                  {entry.headquarters && (
                    <span className="text-xs text-ink/40">{entry.headquarters}</span>
                  )}
                </div>
                {entry.tagline && (
                  <p className="mt-0.5 text-sm text-ink/60 line-clamp-1">{entry.tagline}</p>
                )}
                <p className="mt-1 text-xs text-ink/40">
                  Added {formatDate(entry.added_at)}
                  {entry.last_checked_at
                    ? ` · Last checked ${formatDate(entry.last_checked_at)}`
                    : " · Never checked"}
                </p>
              </div>

              {/* Actions */}
              <div className="flex shrink-0 flex-wrap items-center gap-2">
                <button
                  onClick={() => handleFindRoles(entry)}
                  disabled={!!searchingRoles}
                  className="rounded-md border border-ink px-3 py-1.5 text-sm font-medium transition hover:bg-ink hover:text-white disabled:opacity-50"
                >
                  {searchingRoles === entry.company ? "Searching…" : "Find roles →"}
                </button>
                {entry.careers_url && (
                  <a
                    href={entry.careers_url}
                    target="_blank"
                    rel="noreferrer"
                    onClick={() => handleMarkChecked(entry.company)}
                    className="text-sm text-ink/50 underline-offset-2 hover:underline"
                  >
                    Careers ↗
                  </a>
                )}
                <button
                  onClick={() => handleRemove(entry.company)}
                  disabled={removing === entry.company}
                  className="text-sm text-ink/30 hover:text-[#92400E] transition disabled:opacity-50"
                >
                  Remove
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
