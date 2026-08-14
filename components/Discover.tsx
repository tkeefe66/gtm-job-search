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
import { addToWatchlist, setTracking, getWatchedCompanyKeys } from "@/app/actions/watchlist";
import {
  buildWindowFilterOptions,
  fetchTargetFor,
  filterByWindow,
  type WindowFilter,
} from "@/lib/discovery-window-filter";
import { normalizeCompanyName } from "@/lib/role-key";
import { isCompanyWatched } from "@/lib/watched-companies";
import RoleSearchPanel from "./RoleSearchPanel";
import { Spinner, Tag } from "./ui";

// One selector, two jobs: it slices the cached list AND names what the
// Discover button will fetch. These were two separate chip rows until
// 2026-08-13; side by side they read as redundant, so they were merged.
const SEARCHABLE_RANGES: { value: DateRange; label: string }[] = [
  { value: "7d", label: "7 days" },
  { value: "30d", label: "30 days" },
  { value: "3m", label: "3 months" },
];

// Retired as search targets — the user does not look this far back — but
// results already paid for stay visible and filterable. A chip appears only
// while cached data for the window exists, and Discover falls back to
// DEFAULT_RANGE if one is selected. Removing these from DateRange itself
// would invalidate the discovered_startups rows that still carry them.
const LEGACY_RANGES: { value: DateRange; label: string }[] = [
  { value: "6m", label: "6 months" },
  { value: "6-18m", label: "6–18 mo" },
];

const DEFAULT_RANGE: DateRange = "7d";

function labelForRange(range: DateRange): string {
  return (
    [...SEARCHABLE_RANGES, ...LEGACY_RANGES].find((o) => o.value === range)?.label ?? range
  );
}

export default function Discover() {
  const router = useRouter();
  const [startups, setStartups] = useState<DiscoveredStartup[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingCached, setLoadingCached] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [fetchedAt, setFetchedAt] = useState<string | null>(null);
  const [searchingRoles, setSearchingRoles] = useState<string | null>(null);
  // Normalized company keys (normalizeCompanyName), not raw stored names —
  // see getWatchedCompanyKeys in app/actions/watchlist.ts. Every membership
  // test against this set must go through isCompanyWatched so a raw name is
  // never compared against a differently-cased key.
  const [watchedKeys, setWatchedKeys] = useState<Set<string>>(new Set());
  const [watchingCompany, setWatchingCompany] = useState<string | null>(null);
  // The single window selector: slices the already-loaded list AND names what
  // Discover will fetch next. Selecting never fetches; the button does.
  // Defaults to "all" so the initial view shows every cached window.
  const [windowFilter, setWindowFilter] = useState<WindowFilter>("all");
  // Which of the two discovery approaches is shown — mutually exclusive with
  // the company-mode body below. Role mode is a fully separate component
  // (RoleSearchPanel) so this file doesn't have to grow to hold both.
  const [mode, setMode] = useState<"company" | "role">("company");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoadingCached(true);
      setError(null);
      const [res, watchedKeysResult] = await Promise.all([
        getAllDiscoveredStartups(),
        getWatchedCompanyKeys(),
      ]);
      if (cancelled) return;
      setStartups(
        res.startups.filter((s) => !isCompanyWatched(s.company, watchedKeysResult.keys))
      );
      setFetchedAt(res.fetchedAt);
      setWatchedKeys(watchedKeysResult.keys);
      // Presence, not truthiness. An empty key set means "nothing is watched",
      // which is a plausible answer and therefore hides the failure completely:
      // every company would render un-starred with a live Track button. Saying
      // so is the minimum; the keys themselves cannot be recovered here.
      if (watchedKeysResult.error !== undefined) {
        setError(
          "Could not check which companies you are already watching, so the stars below " +
            "may be wrong. Reload before watching or un-watching anything."
        );
      }
      setLoadingCached(false);
    })();
    return () => { cancelled = true; };
  }, []);

  async function run() {
    setLoading(true);
    setError(null);
    const res = await discoverStartups(undefined, fetchTarget);
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
    // A cache-write failure is NOT a failed search — the roles were found and
    // are already ingested into `jobs` — so it does not take the early-return
    // above. But it does suppress the navigation: /roles unmounts this
    // component and takes the warning with it, and the warning is about money
    // being spent again on every future click. The roles are one click away on
    // the nav; an unread bill is not recoverable.
    if (res.cacheWarning) {
      setError(res.cacheWarning);
      return;
    }
    router.push("/roles");
  }

  async function handleWatch(startup: DiscoveredStartup) {
    setWatchingCompany(startup.company);
    setError(null);
    const key = normalizeCompanyName(startup.company);
    try {
      if (isCompanyWatched(startup.company, watchedKeys)) {
        // Soft-disable, not delete: crawl history, the learned careers_url,
        // crawl_method, and failure counters must survive an un-star so
        // re-watching doesn't cost a fresh resolveCareersUrl() search. The
        // Watchlist page's own "Stop tracking" button already works this way;
        // removeFromWatchlist stays exported as the explicit hard-delete.
        //
        // setTracking now reports an explicit error when the name resolves to
        // no stored row (see resolveWriteTarget in app/actions/watchlist.ts) —
        // this is that fix's only consumer on this page, so dropping the
        // return value would make it unobservable. Surfacing it the way
        // components/Watchlist.tsx does (show the action's message, then
        // don't pretend the write happened): the star must not flip and the
        // row must not reappear when nothing was actually written.
        const res = await setTracking(startup.company, false);
        if (res.error) {
          setError(`Couldn't stop watching ${startup.company}: ${res.error}`);
          return;
        }
        setWatchedKeys((prev) => { const n = new Set(prev); n.delete(key); return n; });
        setStartups((prev) => [...prev, startup]);
      } else {
        const res = await addToWatchlist(startup);
        if (res.error) {
          setError(`Couldn't watch ${startup.company}: ${res.error}`);
          return;
        }
        setWatchedKeys((prev) => new Set(prev).add(key));
        setStartups((prev) => prev.filter((s) => normalizeCompanyName(s.company) !== key));
      }
    } finally {
      setWatchingCompany(null);
    }
  }

  const busy = loading || loadingCached;

  // Chips for windows that actually have loaded companies, plus "All". Not
  // rendered as a control at all until there's more than one real range to
  // pick between — a single-option toggle would just be noise.
  const windowFilterOptions = buildWindowFilterOptions(
    startups.map((s) => s.discovered_range),
    SEARCHABLE_RANGES,
    LEGACY_RANGES
  );
  // What the Discover button will actually fetch given the current selection.
  // "All" and retired windows have no fetchable target, so both fall back —
  // and the button says so rather than silently fetching something else.
  const fetchTarget = fetchTargetFor(windowFilter, SEARCHABLE_RANGES, DEFAULT_RANGE);
  const displayed = filterByWindow(startups, windowFilter);
  const hiddenByFilter = startups.length > 0 && displayed.length === 0;

  function rangeLabel(range: DateRange): string {
    return labelForRange(range);
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
      <div className="mb-6 flex overflow-hidden rounded-md border border-slate sm:w-fit">
        {(
          [
            { value: "company", label: "By company (funding)" },
            { value: "role", label: "By role (title/stack)" },
          ] as const
        ).map((m) => (
          <button
            key={m.value}
            onClick={() => setMode(m.value)}
            className={`px-3 py-1.5 text-sm transition ${
              mode === m.value ? "bg-ink text-white" : "bg-white text-ink hover:bg-canvas"
            }`}
          >
            {m.label}
          </button>
        ))}
      </div>

      {mode === "role" && <RoleSearchPanel />}

      {mode === "company" && (
        <>
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
            <button
              onClick={run}
              disabled={busy}
              className="shrink-0 rounded-md border border-ink bg-ink px-4 py-2 text-sm font-medium text-white transition hover:bg-ink/90 disabled:opacity-50"
            >
              {loading ? "Discovering…" : `Discover ${labelForRange(fetchTarget)}`}
            </button>
          </div>

          {!busy && (
            <div className="mb-4 flex flex-wrap items-center gap-1.5">
              <span className="text-xs font-medium text-ink/40">Window</span>
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
              {displayed.map((s, i) => {
                const watching = isCompanyWatched(s.company, watchedKeys);
                return (
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
                        watching
                          ? "border-ink/30 bg-canvas text-ink/50 hover:border-[#92400E] hover:text-[#92400E]"
                          : "border-slate text-ink/50 hover:border-ink hover:text-ink"
                      }`}
                    >
                      {watchingCompany === s.company ? "…" : watching ? "Watching ✓" : "Watch"}
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
                );
              })}
            </div>
          )}
        </>
      )}
    </div>
  );
}
