"use client";

import { useEffect, useMemo, useState } from "react";
import { getJobs, updateJob, deleteJob, addJob, getJobStatuses } from "@/app/actions/jobs";
import { scoreFit } from "@/app/actions/parse-role";
import { type Job } from "@/lib/types";
import {
  DEFAULT_STATUSES,
  bucketFor,
  compareByConfig,
  labelFor,
  optionsFor,
  tileCounts,
  type JobStatusDef,
} from "@/lib/job-statuses";
import {
  COMP_BUCKET_TAGS,
  bucketPasses,
  salaryBucketFor,
  type SalaryBucket,
} from "@/lib/salary-filter";
import { describeWriteFailure } from "@/lib/write-failure";
import { roleAge, type RoleAge } from "@/lib/role-age";
import { selectionInView, summarizeBulkStatus, type BulkWriteResult } from "@/lib/bulk-status";
import { classifyJobLink, hostOf } from "@/lib/job-link";
import { appliedDatePatch, todayStamp } from "@/lib/applied-date";
import { repairJobLinks, type LinkRepairReport } from "@/app/actions/link-health";
import { sourceOptions } from "@/lib/job-sources";
import { Spinner } from "./ui";

const STATUS_STYLES: Record<string, string> = {
  New: "bg-[#F3F4F6] text-[#6B7280]",
  Applied: "bg-[#DBEAFE] text-[#1E40AF]",
  "Recruiter Outreach": "bg-[#EDE9FE] text-[#5B21B6]",
  "Phone / Intro Screen": "bg-[#E0F2FE] text-[#0369A1]",
  "Hiring Manager": "bg-[#FEF3C7] text-[#92400E]",
  "Panel Interviews": "bg-[#FEF3C7] text-[#92400E]",
  "Exec Presentation": "bg-[#FEF3C7] text-[#92400E]",
  "Reference Check": "bg-[#FEF3C7] text-[#92400E]",
  Offer: "bg-[#DCFCE7] text-[#14532D]",
  "Not Interested": "bg-[#F3F4F6] text-[#6B7280]",
  Rejected: "bg-[#FEE2E2] text-[#991B1B]",
  Passed: "bg-[#DCFCE7] text-[#14532D]",
  "Posting Closed": "bg-[#F3F4F6] text-[#9CA3AF]",
};

type SortKey = "company" | "role_title" | "department" | "location" | "salary_range" | "fit_score" | "status" | "source" | "stage" | "category" | "arr" | "exit_signal" | "backer" | "created_at";
type SortDir = "asc" | "desc";

// Keys whose FIRST click should read big-to-small. Alphabetical columns want
// A→Z, but "best fit" and "found most recently" are what you actually mean by
// clicking Fit or Found — ascending would bury the answer at the bottom.
const DESC_FIRST: SortKey[] = ["fit_score", "created_at"];

/**
 * The sort axes the picker offers.
 *
 * A SUBSET of SortKey, deliberately: every column header is still clickable, so
 * the rarer axes (location, ARR, backer…) remain reachable without turning a
 * five-item menu into a fourteen-item one. These five are what the previous pill
 * row offered, kept identical so the change is a shape change, not a capability
 * change.
 */
const SORT_OPTIONS: [SortKey, string][] = [
  ["fit_score", "Fit"],
  ["created_at", "Found"],
  ["company", "Company"],
  ["status", "Status"],
  ["stage", "Stage"],
];

/** One shape for every picker in the control row, so the group reads as a unit. */
const PICKER_CLS =
  "rounded-md border border-slate bg-white py-2 pl-2.5 pr-7 text-sm text-ink outline-none transition hover:border-ink focus:border-ink";

/**
 * A labelled control. The axis name is carried in text rather than left to the
 * selected value, because "Fit" or "Crawl" alone does not say what it controls —
 * and this row now holds three pickers that would otherwise be three unlabelled
 * menus sitting side by side.
 */
function Picker({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex items-center gap-1.5">
      <span className="text-xs font-medium uppercase tracking-wide text-ink/45">{label}</span>
      {children}
    </label>
  );
}

/**
 * A labelled group for controls that label themselves.
 *
 * A div, not the `<label>` Picker uses: its children are `<label>`s of their
 * own, and nesting labels is invalid and makes the click target ambiguous.
 */
function FieldGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-xs font-medium uppercase tracking-wide text-ink/45">{label}</span>
      {children}
    </div>
  );
}

/**
 * An on/off filter, in the same white bordered chassis as the pickers beside it.
 *
 * A real checkbox rather than a filled button: the ON state has to be legible
 * without becoming the loudest thing on the page. A solid ink fill — which is
 * what the old pill used, and which read fine as one chip among fifteen — sits
 * next to four white controls here and announces itself as a primary action
 * instead of an engaged filter. The checkbox carries the state at the size the
 * state deserves, and `accent-ink` matches the select-all checkbox this table
 * already uses.
 */
function Toggle({
  on,
  onClick,
  title,
  children,
}: {
  on: boolean;
  onClick: () => void;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <label
      title={title}
      className={`flex cursor-pointer items-center gap-2 rounded-md border bg-white px-2.5 py-2 text-sm transition ${
        on ? "border-ink text-ink" : "border-slate text-ink/70 hover:border-ink hover:text-ink"
      }`}
    >
      <input
        type="checkbox"
        checked={on}
        onChange={onClick}
        className="h-3.5 w-3.5 shrink-0 cursor-pointer accent-ink"
      />
      {children}
    </label>
  );
}

/**
 * Drawn rather than a "↑"/"↓" glyph: one authored mark that rotates between the
 * two states, so the control keeps a single silhouette and the change of
 * direction is legible as motion instead of as a substituted character.
 */
function SortArrow({ dir }: { dir: SortDir }) {
  return (
    <svg
      viewBox="0 0 12 12"
      aria-hidden="true"
      className={`h-3 w-3 transition-transform duration-150 ${dir === "asc" ? "rotate-180" : ""}`}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M6 2v8" />
      <path d="M2.75 6.75 6 10l3.25-3.25" />
    </svg>
  );
}

function SortIcon({ active, dir }: { active: boolean; dir: SortDir }) {
  return (
    <span className={`ml-1 inline-block text-[10px] ${active ? "text-ink" : "text-ink/30"}`}>
      {active ? (dir === "asc" ? "↑" : "↓") : "↕"}
    </span>
  );
}

type StatusFilter =
  | { kind: "sentinel"; key: "All" | "Open" | "Out" }
  | { kind: "status"; key: string };

export default function RolesTable({ compFloor }: { compFloor: number | null }) {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [statuses, setStatuses] = useState<JobStatusDef[]>(DEFAULT_STATUSES);
  const [statusError, setStatusError] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>({
    kind: "sentinel",
    key: "Open",
  });
  const [expandedId, setExpandedId] = useState<string | null>(null);
  /** "All", or one `jobs.source` value. Plain string, not a tagged union: unlike
   *  the status filter there are no sentinels beyond "All" and no user-defined
   *  values, so there is nothing for a real source to collide with. */
  const [sourceFilter, setSourceFilter] = useState<string>("All");
  const [sortKey, setSortKey] = useState<SortKey>("fit_score");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  // Two INDEPENDENT booleans, not another exclusive chip group like
  // statusFilter: "pays too little" and "didn't tell me" are different facts
  // and the user needs to answer them separately. Both start off, so the table
  // looks exactly as it did before this feature until the user opts in.
  const [meetsOnly, setMeetsOnly] = useState(false);
  const [hideNoRange, setHideNoRange] = useState(false);
  // Frozen at mount so every row's age is measured against the same instant —
  // a fresh `new Date()` per row would make a long list drift mid-render, and
  // re-reading it every render would churn the labels on unrelated state
  // changes. The page is reloaded far more often than a "3d ago" would tick.
  const [now] = useState(() => new Date());
  // Ids, not rows: the rows are replaced wholesale by every load() and by every
  // optimistic edit, so holding objects here would pin stale copies.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [applying, setApplying] = useState(false);
  const [checkingLinks, setCheckingLinks] = useState(false);
  const [linkReport, setLinkReport] = useState<LinkRepairReport | null>(null);

  /**
   * Refetches the table and reports its own failure. Never throws — a load
   * that rejects must not leave the spinner up forever, and commitWrite below
   * depends on getting an answer rather than an exception.
   *
   * Returns the failure so a CALLER can tell "the reload proved me wrong" from
   * "the reload failed too". Those are different sentences and the difference
   * is load-bearing; see commitWrite.
   */
  async function load(): Promise<string | null> {
    setLoading(true);
    let failure: string | null = null;
    try {
      // Promise.all, and each read owns its own failure. They are independent
      // queries, and this path re-runs after every failed write — running them
      // in series doubled the latency of a recovery reload for nothing.
      //
      // Each promise is settled INTO a result object rather than left to
      // reject, because a bare Promise.all would land both rejections in the
      // one catch below — which says "Could not load your roles". That is how
      // a failed status read came to blame the roles table, which had loaded
      // fine. Settling here lets each branch name what actually failed. (Not
      // Promise.allSettled: its union shape needs a narrowing dance for each
      // read anyway, and this spelling keeps the value typed.)
      const [res, cfg] = await Promise.all([
        getJobs().then(
          (r) => ({ ok: true as const, r }),
          (err: unknown) => ({ ok: false as const, err })
        ),
        getJobStatuses().then(
          (r) => ({ ok: true as const, r }),
          (err: unknown) => ({ ok: false as const, err })
        ),
      ]);

      if (res.ok) {
        // describeWriteFailure, not `if (res.error)`. Presence, not truthiness:
        // getJobs returns `error.message` verbatim and a connection-level failure
        // carries an EMPTY one, so the truthiness spelling took the `else` branch,
        // cleared the banner, and rendered `jobs: []` as a genuinely empty
        // pipeline. "You have no roles" and "the database is unreachable" are the
        // two answers that must never be confused, and this table showed the
        // first for the second.
        failure = describeWriteFailure(res.r.error, "load your roles") ?? null;
        setJobs(res.r.jobs);
      } else {
        failure = describeWriteFailure(
          res.err instanceof Error ? res.err.message : String(res.err),
          "load your roles"
        ) ?? null;
      }

      if (cfg.ok) {
        // Presence, not truthiness: the message can be empty.
        const described =
          cfg.r.error !== undefined
            ? describeWriteFailure(cfg.r.error, "load your status settings")
            : undefined;
        // Only adopt the config when the read actually SUCCEEDED. getJobStatuses
        // returns the shipped defaults alongside a failed read, and its own doc
        // comment says that config must never be presented as the user's — this
        // table is the one with a write path, so adopting them would put hidden
        // and deleted statuses back in the row <select> and let the user store
        // one on a role. components/RecruiterPanel.tsx does the same, and was
        // right first.
        if (described === undefined) setStatuses(cfg.r.statuses);
        setStatusError(described);
      } else {
        // getJobStatuses calls requireActor(), which THROWS on an expired or
        // missing session. Attributed to the status read, not to the roles.
        setStatusError(
          describeWriteFailure(
            cfg.err instanceof Error ? cfg.err.message : String(cfg.err),
            "load your status settings"
          )
        );
      }
    } catch (err) {
      // Nothing above should reach here — both reads catch their own rejection
      // — but a throw from setState or from describeWriteFailure would
      // otherwise leave the spinner up forever.
      failure = describeWriteFailure(
        err instanceof Error ? err.message : String(err),
        "load your roles"
      ) ?? null;
    }
    setError(failure);
    setLoading(false);
    return failure;
  }

  /**
   * Applies a write the UI has ALREADY painted as done, and tells the truth
   * when it did not land.
   *
   * All three callers below are optimistic: they mutate local state first so
   * the table feels instant, then wrote to the database and DISCARDED the
   * result. Any failure — a connection blip, a constraint violation, a bad
   * field/value pair through handleFieldSave's untyped cast — left the screen
   * showing a value the database never received, with no banner and no log
   * line, until something else happened to trigger a reload. For handleStatus
   * that means a lost pipeline stage, which lib/crawler.ts's
   * STALE_POSTING_CANDIDATES_SQL comment calls "unrecoverable information" and
   * builds two SQL predicates to protect; for handleFieldSave it means
   * hand-typed text.
   *
   * Recovery is a re-`load()`, not a revert of the optimistic state: restoring
   * the prior value means capturing and replaying it correctly at three call
   * sites, while `load()` refetches the truth in one call that already exists.
   * The error is surfaced as well — a silent reload that snaps the row back
   * with no explanation is its own confusing bug.
   *
   * THE RELOAD'S OWN FAILURE IS KEPT, NOT OVERWRITTEN. An empty message is
   * only ever produced by a connection-level outage, which fails every query
   * at once — so the reload that is supposed to reveal the truth fails too,
   * `res.jobs` comes back `[]`, and the table renders EMPTY. Claiming "what you
   * see now is what is actually stored" over an empty table would assert that
   * the user's whole pipeline is gone. That is a confident falsehood, and it is
   * worse than the silence this function was written to end. So the two cases
   * get two different sentences and the failed-reload one promises nothing.
   *
   * Wrapped in try/catch because a server action can REJECT rather than return
   * — offline, a restart, a 500 — which would otherwise leave the optimistic
   * state standing with nothing logged and nothing shown.
   * components/Discover.tsx and components/RoleSearchPanel.tsx both wrap the
   * equivalent call; this file was the odd one out.
   */
  async function commitWrite(
    what: string,
    write: () => Promise<{ error?: string }>
  ) {
    let failure: string | undefined;
    try {
      failure = describeWriteFailure((await write()).error, what);
    } catch (err) {
      // describeWriteFailure, not a raw interpolation: a rejection can carry an
      // empty message for exactly the same reason a returned error can.
      failure = describeWriteFailure(
        err instanceof Error ? err.message : String(err),
        what
      );
    }
    if (failure === undefined) return;
    console.error(`RolesTable: ${failure}`);

    const reloadFailure = await load();
    setError(
      reloadFailure === null
        ? `${failure}. The table has been reloaded, so what you see now is what is actually stored.`
        : `${failure}. Reloading the table failed too (${reloadFailure}), so the rows below ` +
          `are NOT reliable — they may be neither what you just changed nor what is stored. ` +
          `Reload the page once the database is reachable.`
    );
  }

  useEffect(() => { void load(); }, []);

  /**
   * Keeps the chip filter pointing at a status that still exists.
   *
   * A status deleted on /settings disappears from `statuses` the next time
   * load() runs. A `{ kind: "status" }` filter still holding that key then
   * matches nothing, no chip renders as selected, and the table shows zero rows
   * with nothing on screen to explain why. Falling back to the default "Open"
   * sentinel is the same state a fresh mount starts in.
   *
   * Returns `prev` untouched when the key is still there, so this cannot loop.
   */
  useEffect(() => {
    setStatusFilter((prev) =>
      prev.kind === "status" && !statuses.some((d) => d.key === prev.key)
        ? { kind: "sentinel", key: "Open" }
        : prev
    );
  }, [statuses]);

  const counts = useMemo(
    () => tileCounts(statuses, jobs.map((j) => j.status)),
    [jobs, statuses]
  );

  /**
   * Each job's compensation bucket, computed ONCE per (jobs, compFloor) pair.
   *
   * The filter below and the row tag both need it, and salaryBucketFor re-parses
   * the salary string every call — which also re-logs every unreadable range,
   * on every keystroke in the search box. Memoized here, `filtered` and CompTag
   * share one result.
   *
   * compFloor is a dependency of THIS memo, which is how a floor change reaches
   * `filtered` (which depends on `bucketOf`). The map fallback keeps a job that
   * somehow missed the pass classified rather than silently mis-bucketed.
   */
  const bucketOf = useMemo(() => {
    const byId = new Map<string, SalaryBucket>();
    for (const j of jobs) byId.set(j.id, salaryBucketFor(j, compFloor));
    return (j: Job): SalaryBucket => byId.get(j.id) ?? salaryBucketFor(j, compFloor);
  }, [jobs, compFloor]);

  const FUNNEL: { label: string; key: "Open" | "Out"; count: number }[] = [
    { label: "Open", key: "Open", count: counts.open },
    { label: "Out", key: "Out", count: counts.out },
  ];

  /**
   * Which sources the picker offers. Derived from the loaded rows rather than
   * from a fixed list, so it never offers a filter that would empty the table —
   * and so a source this app does not know about is still filterable.
   *
   * Depends on `jobs` alone: the other filters must not narrow this list, or
   * picking a source would remove the option that got you there.
   */
  const sourceChoices = useMemo(() => sourceOptions(jobs.map((j) => j.source)), [jobs]);

  /**
   * Drops a source filter that no longer matches anything — after a reload, a
   * delete, or a link-repair pass. Without it the picker keeps pointing at a
   * value no row has and the table reads as empty with nothing to explain it.
   * Same reconciliation the status filter does above.
   */
  useEffect(() => {
    if (sourceFilter !== "All" && !sourceChoices.includes(sourceFilter)) {
      setSourceFilter("All");
    }
  }, [sourceChoices, sourceFilter]);

  function toggleSort(key: SortKey) {
    if (sortKey === key) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else { setSortKey(key); setSortDir(DESC_FIRST.includes(key) ? "desc" : "asc"); }
  }

  const filtered = useMemo(() => {
    let list = jobs.filter((j) => {
      if (statusFilter.kind === "status") {
        if (j.status !== statusFilter.key) return false;
      } else if (statusFilter.key === "Open") {
        if (bucketFor(statuses, j.status) === "terminal") return false;
      } else if (statusFilter.key === "Out") {
        if (bucketFor(statuses, j.status) !== "terminal") return false;
      }
      // "All" falls through and shows everything.
      if (sourceFilter !== "All" && j.source !== sourceFilter) return false;
      if (!bucketPasses(bucketOf(j), { meetsOnly, hideNoRange })) return false;
      if (search) {
        const q = search.toLowerCase();
        return (
          j.company.toLowerCase().includes(q) ||
          j.role_title.toLowerCase().includes(q) ||
          (j.location ?? "").toLowerCase().includes(q)
        );
      }
      return true;
    });

    list = [...list].sort((a, b) => {
      let av: string | number = "";
      let bv: string | number = "";
      if (sortKey === "fit_score") {
        av = a.fit_score ?? 0;
        bv = b.fit_score ?? 0;
        return sortDir === "asc" ? (av as number) - (bv as number) : (bv as number) - (av as number);
      }
      if (sortKey === "status") {
        const cmp = compareByConfig(statuses)(a.status, b.status);
        return sortDir === "asc" ? cmp : -cmp;
      }
      av = ((a[sortKey as keyof Job] as string | null) ?? "").toLowerCase();
      bv = ((b[sortKey as keyof Job] as string | null) ?? "").toLowerCase();
      if (av < bv) return sortDir === "asc" ? -1 : 1;
      if (av > bv) return sortDir === "asc" ? 1 : -1;
      return 0;
    });

    return list;
    // meetsOnly, hideNoRange and bucketOf all belong here: omitting any of them
    // leaves a memo that paints correctly once and then never reacts to a
    // toggle again. compFloor reaches this list THROUGH bucketOf, which is
    // memoized on [jobs, compFloor] — a new floor makes a new bucketOf, which
    // invalidates this memo. Listing compFloor as well would be a dependency
    // this callback no longer reads. statuses is read directly (bucketFor,
    // compareByConfig), not just through bucketOf, so it needs its own entry.
  }, [jobs, search, statusFilter, sourceFilter, sortKey, sortDir, meetsOnly, hideNoRange, bucketOf, statuses]);

  // Counted against what is ON SCREEN, so narrowing the filter with rows ticked
  // shrinks the count instead of promising to write rows that scrolled out of
  // existence. The Set keeps the hidden ids, so widening it again restores them.
  const selectedCount = selectionInView(filtered, selected).length;

  async function handleStatus(job: Job, status: string) {
    // appliedDatePatch, not a bare { status }: the column is rendered below and
    // was written by nothing until this call site started sending it.
    const patch = { status, ...appliedDatePatch(status, job.applied_date, todayStamp()) };
    setJobs((prev) => prev.map((j) => (j.id === job.id ? { ...j, ...patch } : j)));
    await commitWrite(`move ${job.company} to "${labelFor(statuses, status)}"`, () =>
      updateJob(job.id, patch)
    );
  }

  async function handleCheckLinks() {
    setCheckingLinks(true);
    setLinkReport(null);
    try {
      const report = await repairJobLinks();
      setLinkReport(report);
      // Reload regardless of what changed: the pass may have relinked or closed
      // rows, and the table would otherwise keep showing the links it just
      // replaced.
      if (report.error === undefined) await load();
    } catch (err) {
      setLinkReport({
        checked: 0,
        relinked: 0,
        closed: 0,
        closedUnlisted: 0,
        unclear: [],
        unresolved: 0,
        error: describeWriteFailure(
          err instanceof Error ? err.message : String(err),
          "check your role links"
        ),
      });
    } finally {
      setCheckingLinks(false);
    }
  }

  function toggleSelected(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }

  /**
   * Moves every selected row that is currently on screen to `status`.
   *
   * Its own path rather than a loop over commitWrite: that helper reloads the
   * whole table and rewrites the banner per call, so N failing rows would mean
   * N reloads and one surviving sentence out of N identical ones. Here the
   * batch fails once, reloads once, and says once how much of it landed.
   */
  async function handleBulkStatus(status: string) {
    const targets = selectionInView(filtered, selected);
    if (targets.length === 0) return;
    const ids = new Set(targets.map((j) => j.id));

    setApplying(true);
    // Per row, not once for the batch: the stamp depends on each job's existing
    // applied_date, so a selection mixing already-applied rows with fresh ones
    // must keep the old dates and stamp only the fresh.
    const today = todayStamp();
    const patchFor = (j: Job) => ({
      status,
      ...appliedDatePatch(status, j.applied_date, today),
    });
    setJobs((prev) => prev.map((j) => (ids.has(j.id) ? { ...j, ...patchFor(j) } : j)));

    let results: BulkWriteResult[];
    try {
      results = await Promise.all(
        targets.map(async (j): Promise<BulkWriteResult> => {
          try {
            return { id: j.id, error: (await updateJob(j.id, patchFor(j))).error };
          } catch (err) {
            // Normalized into the same shape as a returned error rather than
            // described here: a rejection carries an empty message for exactly
            // the same reason a returned one does, and summarizeBulkStatus is
            // the single place that decides what an empty message reads as.
            return { id: j.id, error: err instanceof Error ? err.message : String(err) };
          }
        })
      );
    } finally {
      setApplying(false);
    }

    const failure = summarizeBulkStatus(results, labelFor(statuses, status));
    if (failure === null) {
      setSelected(new Set());
      return;
    }
    console.error(`RolesTable: ${failure.message}`);
    // The rows that failed stay ticked so the retry is one click, and the ones
    // that saved drop out so a retry cannot re-write them.
    setSelected(new Set(failure.failedIds));

    const reloadFailure = await load();
    setError(
      reloadFailure === null
        ? `${failure.message}. The table has been reloaded, so what you see now is what is actually stored.`
        : `${failure.message}. Reloading the table failed too (${reloadFailure}), so the rows below ` +
          `are NOT reliable — they may be neither what you just changed nor what is stored. ` +
          `Reload the page once the database is reachable.`
    );
  }

  async function handleDelete(id: string) {
    const removed = jobs.find((j) => j.id === id);
    setJobs((prev) => prev.filter((j) => j.id !== id));
    await commitWrite(`delete ${removed?.company ?? "that role"}`, () => deleteJob(id));
  }

  async function handleFieldSave(id: string, field: keyof Job, value: string) {
    setJobs((prev) => prev.map((j) => (j.id === id ? { ...j, [field]: value } : j)));
    await commitWrite(`save the ${String(field)} you typed`, () =>
      updateJob(id, { [field]: value } as Partial<Job>)
    );
  }

  function Th({ label, sortable, col }: { label: string; sortable?: SortKey; col?: string }) {
    const active = sortable && sortKey === sortable;
    return (
      <th
        className={`px-4 py-3 font-medium text-ink/60 whitespace-nowrap text-left ${sortable ? "cursor-pointer select-none hover:text-ink" : ""} ${col ?? ""}`}
        onClick={sortable ? () => toggleSort(sortable) : undefined}
      >
        {label}
        {sortable && <SortIcon active={!!active} dir={sortDir} />}
      </th>
    );
  }

  return (
    <div>
      {/* Header */}
      <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-xl font-heading font-semibold">Roles</h2>
          <p className="text-sm text-ink/60">
            {jobs.length} role{jobs.length !== 1 ? "s" : ""} tracked. Find new ones from the Discover tab.
          </p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => void handleCheckLinks()}
            disabled={checkingLinks}
            title="Re-check every open role's link, replace reseller links with the employer's own, and close postings that are gone"
            className="rounded-md border border-slate px-4 py-2 text-sm font-medium text-ink/70 transition hover:border-ink hover:text-ink disabled:opacity-50"
          >
            {checkingLinks ? "Checking links…" : "Check links"}
          </button>
        </div>
      </div>

      {linkReport && (
        <div
          className={`mb-6 rounded-lg border p-4 text-sm ${
            linkReport.error
              ? "border-[#FECACA] bg-[#FEF2F2] text-[#991B1B]"
              : "border-slate bg-canvas text-ink/70"
          }`}
        >
          <div className="flex items-start justify-between gap-4">
            <div>
              {linkReport.error ? (
                linkReport.error
              ) : (
                <>
                  Checked {linkReport.checked} open {linkReport.checked === 1 ? "role" : "roles"}.
                  {linkReport.relinked > 0 &&
                    ` Relinked ${linkReport.relinked} to the employer's own posting.`}
                  {linkReport.closed > 0 &&
                    ` Closed ${linkReport.closed} whose posting returned a 404.`}
                  {linkReport.closedUnlisted > 0 &&
                    ` Closed ${linkReport.closedUnlisted} the employer's own board no longer lists.`}
                  {linkReport.unresolved > 0 &&
                    ` ${linkReport.unresolved} still point at a job board we can't see past.`}
                  {/* "Everything checked out" has to mean EVERYTHING, so
                      unresolved counts too — it sat next to "7 still point at a
                      job board we can't see past" and contradicted it. */}
                  {linkReport.relinked === 0 &&
                    linkReport.closed === 0 &&
                    linkReport.closedUnlisted === 0 &&
                    linkReport.unclear.length === 0 &&
                    linkReport.unresolved === 0 &&
                    " Everything checked out."}
                </>
              )}
            </div>
            <button
              onClick={() => setLinkReport(null)}
              className="shrink-0 rounded px-2 py-0.5 text-xs text-ink/40 transition hover:bg-slate hover:text-ink"
            >
              Dismiss
            </button>
          </div>

          {linkReport.unclear.length > 0 && (
            <div className="mt-3 border-t border-slate pt-3">
              <div className="mb-2 flex flex-wrap items-center gap-2">
                <span className="text-ink">
                  {linkReport.unclear.length} could be more than one posting on the employer&apos;s
                  board — check before closing.
                </span>
                {/* Deliberately not auto-closed: several postings matched the
                    title, so closing would be a guess at a live role. Handing
                    the selection to the bulk control keeps the decision with
                    the user and still makes acting on it one click. */}
                <button
                  onClick={() => {
                    setSelected(new Set(linkReport.unclear.map((r) => r.id)));
                    setStatusFilter({ kind: "sentinel", key: "Open" });
                  }}
                  className="rounded border border-ink px-2 py-0.5 text-xs font-medium text-ink transition hover:bg-ink hover:text-white"
                >
                  Select all {linkReport.unclear.length}
                </button>
              </div>
              <ul className="space-y-0.5 text-xs text-ink/60">
                {linkReport.unclear.map((r) => (
                  <li key={r.id}>
                    {r.company} · {r.role_title} —{" "}
                    <a
                      href={r.boardUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="underline underline-offset-2 hover:text-ink"
                    >
                      their board
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      {/* Funnel summary */}
      <div className="mb-6 grid grid-cols-2 gap-3">
        {FUNNEL.map((f) => (
          <button
            key={f.key}
            onClick={() =>
              setStatusFilter(
                statusFilter.kind === "sentinel" && statusFilter.key === f.key
                  ? { kind: "sentinel", key: "Open" }
                  : { kind: "sentinel", key: f.key }
              )
            }
            className={`rounded-lg border p-4 text-left transition ${
              statusFilter.kind === "sentinel" && statusFilter.key === f.key
                ? "border-ink"
                : "border-slate hover:border-ink/30"
            } bg-white`}
          >
            <div className="text-2xl font-heading font-semibold">{f.count}</div>
            <div className="text-xs text-ink/60">{f.label}</div>
          </button>
        ))}
      </div>

      {/* Controls. Search leads (it is the fastest way to a known row), then the
          three pickers that narrow and order the list, grouped tightly together
          because they answer one question between them: which rows, in what
          order. The compensation toggles stay on their own line below — they are
          booleans, not pickers, and mixing the two shapes reads as one
          undifferentiated bar of controls. */}
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:gap-6">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search company, role, or location…"
          className="w-full rounded-md border border-slate bg-white px-3 py-2 text-sm outline-none focus:border-ink sm:max-w-xs"
        />

        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <Picker label="Sort">
            <select
              value={sortKey}
              onChange={(e) => setSortKey(e.target.value as SortKey)}
              className={PICKER_CLS}
            >
              {SORT_OPTIONS.map(([key, label]) => (
                <option key={key} value={key}>{label}</option>
              ))}
            </select>
            <button
              onClick={() => setSortDir((d) => (d === "asc" ? "desc" : "asc"))}
              aria-label={sortDir === "asc" ? "Sort ascending — switch to descending" : "Sort descending — switch to ascending"}
              title={sortDir === "asc" ? "Ascending" : "Descending"}
              className="rounded-md border border-slate bg-white p-1.5 text-ink/60 transition hover:border-ink hover:text-ink"
            >
              <SortArrow dir={sortDir} />
            </button>
          </Picker>

          <Picker label="Status">
            <select
              // The tagged union is flattened to a string for the DOM and parsed
              // back on change. Sentinels are prefixed so a user-defined status
              // keyed "Open" still cannot collide with the Open sentinel — the
              // whole reason the filter state is tagged rather than a bare string.
              value={`${statusFilter.kind}:${statusFilter.key}`}
              onChange={(e) => {
                const [kind, ...rest] = e.target.value.split(":");
                setStatusFilter({ kind: kind as StatusFilter["kind"], key: rest.join(":") } as StatusFilter);
              }}
              className={PICKER_CLS}
            >
              <option value="sentinel:Open">Open</option>
              <option value="sentinel:Out">Out</option>
              <option value="sentinel:All">All statuses</option>
              {statuses.filter((d) => !d.hidden).map((d) => (
                <option key={d.key} value={`status:${d.key}`}>{d.label}</option>
              ))}
            </select>
          </Picker>

          {sourceChoices.length > 1 && (
            <Picker label="Source">
              <select
                value={sourceFilter}
                onChange={(e) => setSourceFilter(e.target.value)}
                className={PICKER_CLS}
              >
                <option value="All">All sources</option>
                {sourceChoices.map((s) => (
                  <option key={s} value={s}>{PROVENANCE[s]?.label ?? s}</option>
                ))}
              </select>
            </Picker>
          )}

          {/* Pay stays TOGGLES rather than becoming a fourth dropdown, and the
              distinction is not cosmetic: lib/salary-filter.ts treats these as
              two INDEPENDENT booleans — "pays too little" and "didn't say" are
              different facts and either can be asked alone. A single-select
              cannot express that without enumerating four combinations. They
              take the pickers' height, border and label so the row still reads
              as one group; the shape difference is what says "these two are
              answered separately". */}
          <FieldGroup label="Pay">
            <div className="flex items-center gap-1.5">
              {/* Hidden entirely when no floor is set: with nothing to compare
                  against it would be a control that visibly does nothing. */}
              {compFloor !== null && (
                <Toggle
                  on={meetsOnly}
                  onClick={() => setMeetsOnly((v) => !v)}
                  title={`Hide roles whose base tops out under $${compFloor.toLocaleString()}`}
                >
                  Meets minimum
                </Toggle>
              )}
              <Toggle
                on={hideNoRange}
                onClick={() => setHideNoRange((v) => !v)}
                title="Hide roles that published no readable salary range"
              >
                Hide no range listed
              </Toggle>
            </div>
          </FieldGroup>
        </div>
      </div>

      {loading && <div className="py-12"><Spinner label="Loading roles…" /></div>}
      {error && !loading && (
        <div className="rounded-md border border-slate bg-white p-4 text-sm text-[#92400E]">{error}</div>
      )}
      {statusError !== undefined && !loading && (
        <div className="mt-2 rounded-md border border-slate bg-white p-4 text-sm text-[#92400E]">{statusError}</div>
      )}
      {!loading && !error && filtered.length === 0 && (
        <div className="rounded-md border border-dashed border-slate p-12 text-center text-sm text-ink/50">
          No roles yet. Go to Discover, find a company, and click &quot;Find roles →&quot;.
        </div>
      )}

      {!loading && filtered.length > 0 && (
        <div className="rounded-lg border border-slate bg-white">
          {/* Sort bar — becomes the bulk bar as soon as anything is ticked, so
              the two never compete for the same strip of screen. */}
          <div className="flex items-center gap-1 border-b border-slate bg-canvas px-4 py-2 text-xs text-ink/50">
            <input
              type="checkbox"
              checked={selectedCount > 0 && selectedCount === filtered.length}
              onChange={() =>
                setSelected(
                  selectedCount === filtered.length ? new Set() : new Set(filtered.map((j) => j.id))
                )
              }
              aria-label={`Select all ${filtered.length} roles shown`}
              title={`Select all ${filtered.length} roles shown`}
              className="mr-2 h-3.5 w-3.5 shrink-0 cursor-pointer accent-ink"
            />
            {/* Sort moved into the control row above, so this bar now says one
                thing: how many rows are shown, or what you are about to do to
                the ones you picked. */}
            {selectedCount === 0 ? (
              <span>
                {filtered.length} of {jobs.length} shown
              </span>
            ) : (
              <>
                <span className="font-medium text-ink">{selectedCount} selected</span>
                <select
                  // Resets to the placeholder after every pick so choosing the
                  // same status twice in a row still fires an onChange.
                  value=""
                  disabled={applying}
                  onChange={(e) => {
                    const next = e.target.value;
                    e.target.value = "";
                    if (next) void handleBulkStatus(next);
                  }}
                  className="ml-2 rounded border border-slate bg-white px-2 py-1 text-xs text-ink disabled:opacity-50"
                >
                  <option value="">Set status…</option>
                  {/* NOT optionsFor here, deliberately. optionsFor injects the
                      current value so a <select> can never render a status the
                      row doesn't hold — but this select's value is always "",
                      reset after every pick so re-picking the same status still
                      fires onChange, and the placeholder above already covers
                      the empty value. Passing "" as optionsFor's `current` would
                      inject a second, blank option alongside it. */}
                  {statuses.filter((d) => !d.hidden).map((d) => (
                    <option key={d.key} value={d.key}>{d.label}</option>
                  ))}
                </select>
                <button
                  onClick={() => setSelected(new Set())}
                  className="rounded px-2 py-0.5 transition hover:bg-slate"
                >
                  Clear
                </button>
                {applying && <Spinner label={`Saving ${selectedCount}…`} />}
              </>
            )}
          </div>

          {filtered.map((job, idx) => (
            <div key={job.id} className={idx < filtered.length - 1 || expandedId === job.id ? "border-b border-slate" : ""}>
              {/* Main row */}
              <div
                className={`flex cursor-pointer items-center gap-4 px-4 py-3 transition hover:bg-canvas ${expandedId === job.id ? "bg-canvas" : ""}`}
                onClick={() => setExpandedId(expandedId === job.id ? null : job.id)}
              >
                {/* stopPropagation: ticking a row must not also expand it. */}
                <input
                  type="checkbox"
                  checked={selected.has(job.id)}
                  onChange={() => toggleSelected(job.id)}
                  onClick={(e) => e.stopPropagation()}
                  aria-label={`Select ${job.company} — ${job.role_title}`}
                  className="h-3.5 w-3.5 shrink-0 cursor-pointer accent-ink"
                />

                {/* Fit score circle */}
                <div
                  className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${
                    job.fit_score && job.fit_score >= 4
                      ? "bg-[#DCFCE7] text-[#14532D]"
                      : job.fit_score === 3
                      ? "bg-[#FEF3C7] text-[#92400E]"
                      : job.fit_score && job.fit_score <= 2
                      ? "bg-[#F3F4F6] text-[#6B7280]"
                      : "bg-[#F3F4F6] text-[#9CA3AF]"
                  }`}
                >
                  {job.fit_score ?? "—"}
                </div>

                {/* Company + title + meta */}
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-baseline gap-x-1.5">
                    <span className="font-medium text-ink">{job.company}</span>
                    <span className="text-ink/40">·</span>
                    {job.job_url ? (
                      <a
                        href={job.job_url}
                        target="_blank"
                        rel="noreferrer"
                        onClick={(e) => e.stopPropagation()}
                        className="text-sm text-ink/70 underline underline-offset-2 hover:text-ink"
                      >
                        {job.role_title}
                      </a>
                    ) : (
                      <span className="text-sm text-ink/70">{job.role_title}</span>
                    )}
                    {job.ic_flag && (
                      <span className="inline-flex items-center rounded-full bg-[#FEF3C7] px-2 py-0.5 text-xs font-medium text-[#92400E]">
                        Builder / IC — apply anyway?
                      </span>
                    )}
                  </div>
                  <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-ink/40">
                    <AgeTag age={roleAge(job.created_at, now)} />
                    <CompTag bucket={bucketOf(job)} />
                    <SourceTag url={job.job_url} />
                    {job.salary_range && <span>{job.salary_range}</span>}
                    {job.salary_range && job.location && <span>·</span>}
                    {job.location && <span>{job.location}</span>}
                    {job.arr && <><span>·</span><span>{job.arr}</span></>}
                    {job.exit_signal && <><span>·</span><span title={job.exit_signal} className="max-w-[200px] truncate text-[#92400E]">{job.exit_signal}</span></>}
                  </div>
                </div>

                {/* Badges + status */}
                <div className="flex shrink-0 flex-wrap items-center gap-2" onClick={(e) => e.stopPropagation()}>
                  {job.stage && <StageBadge stage={job.stage} />}
                  {job.category && (
                    <span className="inline-flex items-center rounded-full bg-canvas px-2 py-0.5 text-xs text-ink/60 border border-slate">
                      {job.category}
                    </span>
                  )}
                  <ProvenanceBadge source={job.source} />
                  <StatusSelect value={job.status} statuses={statuses} onChange={(s) => handleStatus(job, s)} />
                </div>
              </div>

              {/* Expanded detail */}
              {expandedId === job.id && (
                <div className="border-t border-slate bg-canvas px-4 py-4">
                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                    {job.fit_summary && <Detail label="Fit rationale">{job.fit_summary}</Detail>}
                    {job.key_skills && <Detail label="Key skills">{job.key_skills}</Detail>}
                    {job.company_description && <Detail label="About company">{job.company_description}</Detail>}
                    {job.traction && <Detail label="Traction">{job.traction}</Detail>}
                    <Detail label="Notes">
                      <InlineEdit value={job.notes ?? ""} onSave={(v) => handleFieldSave(job.id, "notes", v)} placeholder="Add notes…" />
                    </Detail>
                    <Detail label="Salary range">
                      <InlineEdit value={job.salary_range ?? ""} onSave={(v) => handleFieldSave(job.id, "salary_range", v)} placeholder="e.g. $200K–$280K" />
                    </Detail>
                    <Detail label="Department">
                      <InlineEdit value={job.department ?? ""} onSave={(v) => handleFieldSave(job.id, "department", v)} placeholder="e.g. Product" />
                    </Detail>
                    <Detail label="Stage">
                      <InlineEdit value={job.stage ?? ""} onSave={(v) => handleFieldSave(job.id, "stage", v)} placeholder="e.g. Series B, PE-backed, Public" />
                    </Detail>
                    <Detail label="Backer">
                      <InlineEdit value={job.backer ?? ""} onSave={(v) => handleFieldSave(job.id, "backer", v)} placeholder="e.g. Centerbridge Partners, a16z" />
                    </Detail>
                    <Detail label="ARR">
                      <InlineEdit value={job.arr ?? ""} onSave={(v) => handleFieldSave(job.id, "arr", v)} placeholder="e.g. $380M+" />
                    </Detail>
                    <Detail label="Exit signal">
                      <InlineEdit value={job.exit_signal ?? ""} onSave={(v) => handleFieldSave(job.id, "exit_signal", v)} placeholder="e.g. PE exit planned, IPO path" />
                    </Detail>
                    <Detail label="Industry">
                      <InlineEdit value={job.category ?? ""} onSave={(v) => handleFieldSave(job.id, "category", v)} placeholder="e.g. AI Infra, FinTech, Dev Tools" />
                    </Detail>
                    <Detail label="Fit score">
                      <FitScore score={job.fit_score} onChange={(n) => handleFieldSave(job.id, "fit_score", String(n))} />
                    </Detail>
                    {(() => {
                      // Read-only: the stamp is the database's `now()` default,
                      // not something to hand-edit like the fields above it.
                      const age = roleAge(job.created_at, now);
                      if (!age) return null;
                      return (
                        <Detail label="Found">
                          {age.full} · {age.label}
                          {job.applied_date && ` · applied ${job.applied_date}`}
                        </Detail>
                      );
                    })()}
                    {(job.recruiter_name || job.recruiter_email || job.recruiter_company || job.recruiter_notes) && (
                      <div className="col-span-full rounded-lg border border-[#EDE9FE] bg-[#F5F3FF] p-3">
                        <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-[#5B21B6]">Recruiter</div>
                        <div className="flex flex-wrap gap-4 text-sm">
                          {job.recruiter_name && <span><span className="text-ink/50">Name: </span>{job.recruiter_name}</span>}
                          {job.recruiter_company && <span><span className="text-ink/50">Agency: </span>{job.recruiter_company}</span>}
                          {job.recruiter_email && (
                            <span><span className="text-ink/50">Email: </span>
                              <a href={`mailto:${job.recruiter_email}`} className="underline underline-offset-2">{job.recruiter_email}</a>
                            </span>
                          )}
                        </div>
                        {job.recruiter_notes && <p className="mt-2 text-sm text-ink/70">{job.recruiter_notes}</p>}
                      </div>
                    )}
                    <div className="flex items-center gap-4">
                      {job.company_url && (
                        <a href={job.company_url} target="_blank" rel="noreferrer" className="text-sm underline underline-offset-2 hover:text-ink/60">Company site →</a>
                      )}
                      {job.job_url && (
                        <a href={job.job_url} target="_blank" rel="noreferrer" className="text-sm underline underline-offset-2 hover:text-ink/60">Job listing →</a>
                      )}
                      {job.careers_url && (
                        <a href={job.careers_url} target="_blank" rel="noreferrer" className="text-sm underline underline-offset-2 hover:text-ink/60">Careers page →</a>
                      )}
                      <button
                        onClick={() => handleDelete(job.id)}
                        className="ml-auto rounded border border-slate px-2 py-1 text-xs text-[#92400E] hover:border-[#92400E]"
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

    </div>
  );
}

/**
 * Names what a row's salary figure is when it is not a comparable base range.
 * "Range unreadable" is deliberately its own label: it is the only surface
 * where a salary-parser gap becomes visible to a human.
 *
 * Takes the bucket rather than the job, so it reuses the one `bucketOf`
 * already computed instead of re-parsing (and re-logging) the salary string.
 */
// When this role was found. Carries BOTH the calendar date and the age: the
// date is the fact ("was this before or after I talked to them?"), the age is
// the judgement ("is this stale?"), and neither substitutes for the other at a
// glance. Leads the meta line so both line up in a column down the list — that
// vertical scan is the whole point, and it would be lost behind a
// variable-width salary or location.
function AgeTag({ age }: { age: RoleAge | null }) {
  if (!age) return null;
  return (
    <span
      title={age.title}
      className="inline-flex shrink-0 items-center gap-1 rounded-full border border-slate bg-canvas px-1.5 py-0.5 text-[10px] font-medium text-ink/50"
    >
      <span className="text-ink/70">{age.date}</span>
      <span className="text-ink/30">·</span>
      <span>{age.age}</span>
    </span>
  );
}

/**
 * Marks a link that goes through a reseller rather than to the employer.
 *
 * Only aggregators are called out. An ATS link and a company's own domain are
 * both the employer speaking, so badging them would put a chip on nearly every
 * row and say nothing. Silence means "this link is fine".
 */
function SourceTag({ url }: { url: string | null }) {
  if (classifyJobLink(url) !== "aggregator") return null;
  return (
    <span
      title="Goes through a job board, not the employer. These often outlive the posting — run Check links."
      className="inline-flex items-center rounded-full bg-[#FEF3C7] px-1.5 py-0.5 text-[10px] font-medium text-[#92400E]"
    >
      via {hostOf(url)}
    </span>
  );
}

function CompTag({ bucket }: { bucket: SalaryBucket }) {
  const tag = COMP_BUCKET_TAGS[bucket];
  if (!tag) return null;
  return (
    <span className="inline-flex items-center rounded-full border border-slate bg-canvas px-1.5 py-0.5 text-[10px] font-medium text-ink/50">
      {tag}
    </span>
  );
}

/**
 * How this role reached the table — NOT where its link points.
 *
 * `jobs.source` is stamped once at insert by whichever path found the role and
 * is never rewritten, so it answers "which feature produced this row". That is
 * a different question from SourceTag above, which reads the URL host and means
 * "this link is second-hand". A row can be found by the crawler and still carry
 * an aggregator link; both chips are then correct and say different things.
 *
 * Recruiter keeps a filled badge because a human sent it and that changes how
 * you treat the row. The machine sources are quiet outlines — they are every
 * other row, so shouting them would just add noise.
 */
const PROVENANCE: Record<string, { label: string; cls: string; title: string }> = {
  Discover: {
    label: "Discover",
    cls: "border-slate bg-canvas text-ink/55",
    title: "Found by Discover → by company, from funding news.",
  },
  "Role Search": {
    label: "Role search",
    cls: "border-slate bg-canvas text-ink/55",
    title: "Found by Discover → by role, searching titles and GTM stack terms.",
  },
  Crawl: {
    label: "Crawl",
    cls: "border-slate bg-canvas text-ink/55",
    title: "Found by the watchlist crawler reading the company's careers page.",
  },
  Manual: {
    label: "Manual",
    cls: "border-slate bg-canvas text-ink/55",
    title: "You added this role by hand.",
  },
  Recruiter: {
    label: "Recruiter",
    cls: "border-transparent bg-[#EDE9FE] text-[#5B21B6] font-medium",
    title: "Came from a recruiter, not from a search.",
  },
};

function ProvenanceBadge({ source }: { source: string | null }) {
  if (!source) return null;
  // An unrecognised value is shown verbatim rather than swallowed — a new insert
  // path that forgets to match these strings should be visible, not invisible.
  const chip = PROVENANCE[source] ?? {
    label: source,
    cls: "border-slate bg-canvas text-ink/55",
    title: `Unrecognised source "${source}".`,
  };
  return (
    <span
      title={chip.title}
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs ${chip.cls}`}
    >
      {chip.label}
    </span>
  );
}

function StageBadge({ stage }: { stage: string }) {
  const s = stage.toLowerCase();
  let cls = "bg-[#F3F4F6] text-[#6B7280]";
  if (s.includes("public") || s.includes("ipo")) cls = "bg-[#DCFCE7] text-[#14532D]";
  else if (s.includes("pe") || s.includes("private equity")) cls = "bg-[#FEF3C7] text-[#92400E]";
  else if (s.includes("series d") || s.includes("series e") || s.includes("late") || s.includes("growth")) cls = "bg-[#EDE9FE] text-[#5B21B6]";
  else if (s.includes("series c")) cls = "bg-[#DBEAFE] text-[#1E40AF]";
  else if (s.includes("series b")) cls = "bg-[#E0F2FE] text-[#0369A1]";
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${cls}`}>
      {stage}
    </span>
  );
}

function StatusSelect({
  value,
  statuses,
  onChange,
}: {
  value: string;
  statuses: JobStatusDef[];
  onChange: (s: string) => void;
}) {
  const style = STATUS_STYLES[value] ?? "bg-[#F3F4F6] text-[#6B7280]";
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className={`rounded-full border-0 px-2.5 py-1 text-xs font-medium outline-none cursor-pointer ${style}`}
    >
      {optionsFor(statuses, value).map((d) => (
        <option key={d.key} value={d.key}>{d.label}</option>
      ))}
    </select>
  );
}

function FitScore({ score, onChange }: { score: number | null; onChange: (n: number) => void }) {
  return (
    <span className="inline-flex gap-0.5">
      {[1, 2, 3, 4, 5].map((n) => (
        <button
          key={n}
          type="button"
          onClick={(e) => { e.stopPropagation(); onChange(n); }}
          className={`text-sm leading-none cursor-pointer ${score && n <= score ? "text-ink" : "text-slate"}`}
        >
          ★
        </button>
      ))}
    </span>
  );
}

function Detail({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1 text-xs font-medium text-ink/50 uppercase tracking-wide">{label}</div>
      <div className="text-sm text-ink/80">{children}</div>
    </div>
  );
}

function InlineEdit({ value, onSave, placeholder }: { value: string; onSave: (v: string) => void; placeholder?: string }) {
  const [val, setVal] = useState(value);
  const [dirty, setDirty] = useState(false);
  useEffect(() => { setVal(value); }, [value]);
  return (
    <input
      value={val}
      onChange={(e) => { setVal(e.target.value); setDirty(true); }}
      onBlur={() => { if (dirty) { onSave(val); setDirty(false); } }}
      placeholder={placeholder}
      className="w-full rounded border border-transparent bg-transparent px-1 py-0.5 text-sm outline-none hover:border-slate focus:border-ink focus:bg-white"
    />
  );
}
