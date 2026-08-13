"use client";

import { useCallback, useEffect, useState } from "react";
import {
  findRolesByCriteria,
  getCachedRoleSearch,
} from "@/app/actions/role-search";
import { trackCompanyByName } from "@/app/actions/watchlist";
import type { CrawlOutcome } from "@/lib/crawler";
import { groupRolesByCompany } from "@/lib/group-by-company";
import { shouldReplaceRoleView } from "@/lib/role-search-cache";
import { describeTrackOutcome } from "@/lib/track-outcome";
import type { RoleMatch, RoleSearchFamily } from "@/lib/types";
import { Spinner, Tag } from "./ui";

const FAMILIES: { value: RoleSearchFamily; label: string }[] = [
  { value: "title", label: "Titles" },
  { value: "stack", label: "GTM stack" },
];

export default function RoleSearchPanel() {
  const [family, setFamily] = useState<RoleSearchFamily>("title");
  const [matches, setMatches] = useState<RoleMatch[]>([]);
  const [untracked, setUntracked] = useState<Set<string>>(new Set());
  const [fetchedAt, setFetchedAt] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [trackingCompany, setTrackingCompany] = useState<string | null>(null);
  // Maps company -> the crawl outcome trackCompanyByName produced, so the
  // badge can distinguish a clean track from one that needs attention (see
  // describeTrackOutcome). `null` means we know it succeeded but have no
  // outcome detail (defensive fallback — trackCompanyByName always returns
  // one on its non-error path today).
  const [justTracked, setJustTracked] = useState<Map<string, CrawlOutcome | null>>(new Map());
  // Deliberately separate from `error`: trackCompanyByName runs a real crawl
  // (~9s to a couple minutes) and its failure must survive an unrelated
  // search/reload clearing the search-error state below it says which
  // company failed and why, per this repo's "explicit over silent" standard.
  const [trackError, setTrackError] = useState<{ company: string; message: string } | null>(
    null
  );

  // Applies a result to the view only when it actually carries one. A failed
  // read or a failed search comes back as matches: [] / fetchedAt: null, and
  // blindly applying that wipes results the database still holds — recoverable
  // only by toggling the family and back, which nothing tells the user. See
  // shouldReplaceRoleView in lib/role-search-cache.ts for the exact rule
  // (including why an errored result WITH results still replaces the view).
  const applyResult = useCallback(
    (res: {
      matches: RoleMatch[];
      untrackedCompanies: string[];
      fetchedAt: string | null;
      error?: string;
    }) => {
      if (res.error) setError(res.error);
      if (!shouldReplaceRoleView(res)) return;
      setMatches(res.matches);
      setUntracked(new Set(res.untrackedCompanies));
      setFetchedAt(res.fetchedAt);
    },
    []
  );

  const loadCached = useCallback(
    async (f: RoleSearchFamily) => {
      setLoading(true);
      setError(null);
      applyResult(await getCachedRoleSearch(f));
      setLoading(false);
    },
    [applyResult]
  );

  useEffect(() => {
    loadCached(family);
  }, [family, loadCached]);

  async function runSearch() {
    setSearching(true);
    setError(null);
    applyResult(await findRolesByCriteria(family, true));
    setSearching(false);
  }

  async function handleTrack(company: string) {
    setTrackingCompany(company);
    setTrackError(null);
    try {
      const res = await trackCompanyByName(company);
      if (res.error) {
        setTrackError({ company, message: res.error });
        return;
      }
      setJustTracked((prev) => new Map(prev).set(company, res.outcome ?? null));
    } catch (err) {
      // trackCompanyByName's watchlist read (lib/crawler.ts, crawlCompany's
      // initial select) sits outside its own try/catch, so a network fault
      // there — or any other rejection from the server action — must not
      // leave trackingCompany stuck set. Every Track button shares
      // `disabled={!!trackingCompany}`, so an unhandled rejection here would
      // otherwise permanently disable the whole panel's Track UI until reload.
      setTrackError({
        company,
        message: err instanceof Error ? err.message : "Track request failed unexpectedly.",
      });
    } finally {
      setTrackingCompany(null);
    }
  }

  function formatFetchedAt(iso: string) {
    return new Date(iso).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  }

  // Case-insensitive grouping — see lib/group-by-company.ts. Building this
  // map by hand with `byCompany.get(m.company)` would split "Clay" and
  // "clay" into two groups even though `untracked` (computed server-side by
  // the same rule) treats them as one, silently hiding the Track button for
  // the second casing.
  const byCompany = groupRolesByCompany(matches);

  const busy = loading || searching;

  return (
    <div>
      <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="text-sm text-ink/60">
            Roles found by searching job boards directly — no funding news required.
            {fetchedAt && !busy && (
              <span className="ml-2 text-ink/40">
                · Last searched {formatFetchedAt(fetchedAt)}
              </span>
            )}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex overflow-hidden rounded-md border border-slate">
            {FAMILIES.map((f) => (
              <button
                key={f.value}
                onClick={() => setFamily(f.value)}
                disabled={busy}
                className={`px-3 py-1.5 text-sm transition ${
                  family === f.value
                    ? "bg-ink text-white"
                    : "bg-white text-ink hover:bg-canvas"
                }`}
              >
                {f.label}
              </button>
            ))}
          </div>
          <button
            onClick={runSearch}
            disabled={busy}
            className="rounded-md border border-ink bg-ink px-4 py-2 text-sm font-medium text-white transition hover:bg-ink/90 disabled:opacity-50"
          >
            {searching ? "Searching…" : "Search roles"}
          </button>
        </div>
      </div>

      {busy && (
        <div className="py-12">
          <Spinner
            label={searching ? "Searching job boards…" : "Loading saved results…"}
          />
        </div>
      )}

      {error && !busy && (
        <div className="rounded-md border border-slate bg-white p-4 text-sm text-[#92400E]">
          {error}
        </div>
      )}

      {trackError && !busy && (
        <div className="mb-4 rounded-md border border-slate bg-white p-4 text-sm text-[#92400E]">
          Couldn&apos;t track {trackError.company}: {trackError.message}
        </div>
      )}

      {!busy && !error && byCompany.size === 0 && (
        <div className="rounded-md border border-dashed border-slate p-12 text-center text-sm text-ink/50">
          No cached role search yet. Click &quot;Search roles&quot; to run one.
        </div>
      )}

      {!busy && byCompany.size > 0 && (
        <div className="overflow-hidden rounded-lg border border-slate bg-white">
          {Array.from(byCompany.entries()).map(([company, roles], i) => (
            <div key={company} className={i > 0 ? "border-t border-slate p-4" : "p-4"}>
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-heading font-semibold">{company}</span>
                <Tag>
                  {roles.length} role{roles.length === 1 ? "" : "s"}
                </Tag>
                {justTracked.has(company) ? (
                  (() => {
                    const display = describeTrackOutcome(justTracked.get(company)!);
                    return (
                      <span
                        className={`text-sm ${display.ok ? "text-ink/40" : "text-[#92400E]"}`}
                      >
                        {display.message}
                      </span>
                    );
                  })()
                ) : (
                  untracked.has(company) && (
                    <button
                      onClick={() => handleTrack(company)}
                      disabled={!!trackingCompany}
                      title="Adds the company to your watchlist and runs its first crawl now — this can take anywhere from about 9 seconds to a couple of minutes."
                      className="rounded-md border border-slate px-2 py-1 text-xs font-medium text-ink/60 transition hover:border-ink hover:text-ink disabled:opacity-50"
                    >
                      {trackingCompany === company
                        ? "Crawling careers page… (up to ~2 min)"
                        : "Track"}
                    </button>
                  )
                )}
              </div>
              <ul className="mt-2 space-y-1">
                {roles.map((r, j) => (
                  <li key={`${r.role_title}-${j}`} className="text-sm text-ink/70">
                    {r.job_url ? (
                      <a
                        href={r.job_url}
                        target="_blank"
                        rel="noreferrer"
                        className="underline-offset-2 hover:underline"
                      >
                        {r.role_title}
                      </a>
                    ) : (
                      r.role_title
                    )}
                    {r.location && <span className="text-ink/40"> · {r.location}</span>}
                    {r.salary_range && (
                      <span className="text-ink/40"> · {r.salary_range}</span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
