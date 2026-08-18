"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  discoverStartups,
  getAllDiscoveredStartups,
  getHiringSignal,
  type DateRange,
  type DiscoveredStartup,
} from "@/app/actions/discover";
import { findAndSaveRoles } from "@/app/actions/roles";
import { addToWatchlist, setTracking, getWatchedCompanyKeys } from "@/app/actions/watchlist";
import type { HiringSignal } from "@/lib/profile";
import {
  buildWindowFilterOptions,
  filterByWindow,
  type WindowFilter,
} from "@/lib/discovery-window-filter";
import {
  FETCHABLE_RANGES,
  PINNED_CHIPS,
  LEGACY_RANGES,
  labelForRange,
} from "@/lib/discovery-windows";
import { normalizeCompanyName } from "@/lib/role-key";
import { isCompanyWatched } from "@/lib/watched-companies";
import RoleSearchPanel from "./RoleSearchPanel";
import { Spinner, Tag } from "./ui";

// The window lists and the invariants between them live in
// lib/discovery-windows.ts so they can be tested — this component has no test
// harness (vitest is environment: "node", no jsdom). The buttons say what is
// fetchable; the chips say what is charted; neither reads the other.
//
// Company mode now runs on the tenant's hiring signal (lib/profile.ts),
// not a hardcoded funding-round search — see lib/hiring-signal-prompt.ts.
// `signal.hasRecency` decides the whole window UI: an EVENT signal (a
// funding round, a contract award) keeps the two-button + chip-row layout
// below; a STANDING PROPERTY (e.g. a hospital accreditation) has no window
// to fetch or chart at all, so it gets one button and no chips.

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
  // Purely a view filter over what is already loaded. It does NOT decide what
  // a search fetches — the Discover buttons each carry their own window and
  // are unaffected by this. Defaults to "all" so the initial view shows every
  // cached window.
  const [windowFilter, setWindowFilter] = useState<WindowFilter>("all");
  // Which window is mid-flight, so only the button that was clicked shows a
  // spinner while both disable. A bare boolean could not tell them apart.
  const [runningRange, setRunningRange] = useState<DateRange | null>(null);
  // Which of the two discovery approaches is shown — mutually exclusive with
  // the company-mode body below. Role mode is a fully separate component
  // (RoleSearchPanel) so this file doesn't have to grow to hold both.
  const [mode, setMode] = useState<"company" | "role">("company");
  // Loaded alongside the cached results below. Drives the header copy and
  // which window controls render; null only for the brief instant before the
  // initial load resolves, during which `busy` is already true so nothing
  // that reads it renders yet.
  const [signal, setSignal] = useState<HiringSignal | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoadingCached(true);
      setError(null);
      const [res, watchedKeysResult, signalResult] = await Promise.all([
        getAllDiscoveredStartups(),
        getWatchedCompanyKeys(),
        getHiringSignal(),
      ]);
      if (cancelled) return;
      setStartups(
        res.startups.filter((s) => !isCompanyWatched(s.company, watchedKeysResult.keys))
      );
      setFetchedAt(res.fetchedAt);
      setWatchedKeys(watchedKeysResult.keys);
      setSignal(signalResult.signal);
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

  // Takes its window as an argument rather than reading a selection: which
  // window a click bills is now fixed by the button itself, so filtering the
  // view can never change what the next search costs. For a hasRecency:false
  // signal the only value ever passed is "current".
  async function run(range: DateRange) {
    setLoading(true);
    setRunningRange(range);
    setError(null);
    const res = await discoverStartups(undefined, range);
    if (res.error) setError(res.error);
    const all = await getAllDiscoveredStartups();
    setStartups(all.startups);
    setFetchedAt(new Date().toISOString());
    setRunningRange(null);
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
          `No roles matching your location and role criteria were found at ${startup.company} right now.`
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
  const hasRecency = signal?.hasRecency !== false;

  // Chips for windows that actually have loaded companies, plus "All". Not
  // rendered as a control at all until there's more than one real range to
  // pick between — a single-option toggle would just be noise. Meaningless
  // for a standing-property signal (there is only ever one range, "current"),
  // so the whole row is gated on `hasRecency` below.
  const windowFilterOptions = buildWindowFilterOptions(
    startups.map((s) => s.discovered_range),
    PINNED_CHIPS,
    LEGACY_RANGES
  );
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
            { value: "company", label: "By company" },
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
              <h2 className="text-xl font-heading font-semibold">Employer discovery</h2>
              {/* Binding 3: recency is ADVISORY, not enforced — the model has
                  returned items outside the requested window before. This
                  copy names the signal ("Notable X.") and never claims the
                  window is exact — it does not say "all X from the last N
                  days" or anything else that promises completeness. */}
              <p className="text-sm text-ink/60">
                {signal ? `Notable ${signal.name}.` : "Notable hiring signals."}
                {fetchedAt && !busy && (
                  <span className="ml-2 text-ink/40">
                    · Last fetched {formatFetchedAt(fetchedAt)}
                  </span>
                )}
              </p>
            </div>
            {/* Event signal: one button per fetchable window, both always
                shown. Standing-property signal: a single button, since there
                is nothing to choose a window between. Only the button in
                flight says "Discovering…"; all disable, because a second
                search while one is running would race the cache read that
                follows it. */}
            <div className="flex shrink-0 gap-2">
              {hasRecency ? (
                FETCHABLE_RANGES.map(({ value, label }) => (
                  <button
                    key={value}
                    onClick={() => run(value)}
                    disabled={busy}
                    className="shrink-0 rounded-md border border-ink bg-ink px-4 py-2 text-sm font-medium text-white transition hover:bg-ink/90 disabled:opacity-50"
                  >
                    {runningRange === value ? "Discovering…" : `Discover ${label}`}
                  </button>
                ))
              ) : (
                <button
                  onClick={() => run("current")}
                  disabled={busy}
                  className="shrink-0 rounded-md border border-ink bg-ink px-4 py-2 text-sm font-medium text-white transition hover:bg-ink/90 disabled:opacity-50"
                >
                  {runningRange === "current" ? "Discovering…" : "Discover"}
                </button>
              )}
            </div>
          </div>

          {!busy && hasRecency && (
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
              <Spinner label={loading ? "Searching…" : "Loading saved results…"} />
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
                // Where the SIGNAL happened, not the employer's headquarters
                // — Binding 2. Amgen's HQ (Thousand Oaks, CA) for an Ohio
                // plant expansion, or Joby's (Santa Cruz, CA) for a Dayton
                // plant, would actively mislead a job seeker filtering on
                // location. Falls back to headquarters only for rows that
                // predate this field.
                const place = s.location || s.headquarters;
                const extraEntries = Object.entries(s.extras ?? {}).filter(([, v]) => v);
                return (
                <div
                  key={`${s.company}-${i}`}
                  className={`flex flex-col gap-2 p-4 sm:flex-row sm:items-center ${
                    i > 0 ? "border-t border-slate" : ""
                  }`}
                >
                  {/* Company + signals */}
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-heading font-semibold">{s.company}</span>
                      <Tag>{rangeLabel(s.discovered_range)}</Tag>
                      {place && <span className="text-xs text-ink/40">{place}</span>}
                    </div>
                    {s.tagline && (
                      <p className="mt-0.5 text-sm text-ink/60 line-clamp-1">{s.tagline}</p>
                    )}
                    {/* One line per distinct signal this employer triggered —
                        Binding 1. A single employer can win a signal
                        repeatedly (three separate contract awards), and
                        collapsing that to one line would silently drop real
                        news the old per-row dedupe was throwing away. */}
                    {s.signals.length > 0 && (
                      <ul className="mt-1 space-y-0.5">
                        {s.signals.map((line, idx) => (
                          <li key={idx} className="text-xs text-ink/70">
                            {line}
                          </li>
                        ))}
                      </ul>
                    )}
                    {extraEntries.length > 0 && (
                      <div className="mt-1 flex flex-wrap gap-1">
                        {extraEntries.map(([k, v]) => (
                          <Tag key={k}>{v}</Tag>
                        ))}
                      </div>
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
