"use client";

import { useEffect, useMemo, useState } from "react";
import { getJobs, updateJob, deleteJob, addJob } from "@/app/actions/jobs";
import { parseJobUrl, scoreFit } from "@/app/actions/parse-role";
import { JOB_STATUSES, ACTIVE_STATUSES, TERMINAL_STATUSES, type Job, type JobStatus } from "@/lib/types";
import { COMP_BUCKET_TAGS, passesCompFilters, salaryBucketFor } from "@/lib/salary-filter";
import { Spinner } from "./ui";
import RecruiterPanel from "./RecruiterPanel";

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

type SortKey = "company" | "role_title" | "department" | "location" | "salary_range" | "fit_score" | "status" | "source" | "stage" | "category" | "arr" | "exit_signal" | "backer";
type SortDir = "asc" | "desc";

function SortIcon({ active, dir }: { active: boolean; dir: SortDir }) {
  return (
    <span className={`ml-1 inline-block text-[10px] ${active ? "text-ink" : "text-ink/30"}`}>
      {active ? (dir === "asc" ? "↑" : "↓") : "↕"}
    </span>
  );
}

export default function RolesTable({ compFloor }: { compFloor: number | null }) {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<JobStatus | "All" | "Active" | "Out" | "Open">("Open");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [showRecruiter, setShowRecruiter] = useState(false);
  const [sortKey, setSortKey] = useState<SortKey>("fit_score");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  // Two INDEPENDENT booleans, not another exclusive chip group like
  // statusFilter: "pays too little" and "didn't tell me" are different facts
  // and the user needs to answer them separately. Both start off, so the table
  // looks exactly as it did before this feature until the user opts in.
  const [meetsOnly, setMeetsOnly] = useState(false);
  const [hideNoRange, setHideNoRange] = useState(false);

  async function load() {
    setLoading(true);
    const res = await getJobs();
    if (res.error) setError(res.error);
    else setError(null);
    setJobs(res.jobs);
    setLoading(false);
  }

  useEffect(() => { void load(); }, []);

  const counts = useMemo(() => {
    const c: Record<string, number> = { New: 0, Active: 0, Offer: 0, Out: 0 };
    for (const j of jobs) {
      if (j.status === "New") c.New++;
      else if (ACTIVE_STATUSES.includes(j.status as JobStatus)) c.Active++;
      else if (j.status === "Offer") c.Offer++;
      else if (TERMINAL_STATUSES.includes(j.status as JobStatus)) c.Out++;
    }
    return c;
  }, [jobs]);

  const FUNNEL = [
    { label: "New", key: "New", filter: ["New"] as JobStatus[] },
    { label: "Active", key: "Active", filter: ACTIVE_STATUSES },
    { label: "Offer", key: "Offer", filter: ["Offer"] as JobStatus[] },
    { label: "Out", key: "Out", filter: TERMINAL_STATUSES },
  ];

  function toggleSort(key: SortKey) {
    if (sortKey === key) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else { setSortKey(key); setSortDir("asc"); }
  }

  const filtered = useMemo(() => {
    let list = jobs.filter((j) => {
      if (statusFilter === "All") {
        // show everything
      } else if (statusFilter === "Open") {
        if (TERMINAL_STATUSES.includes(j.status as JobStatus)) return false;
      } else if (statusFilter === "Active") {
        if (!ACTIVE_STATUSES.includes(j.status as JobStatus)) return false;
      } else if (statusFilter === "Out") {
        if (!TERMINAL_STATUSES.includes(j.status as JobStatus)) return false;
      } else if (j.status !== statusFilter) return false;
      if (!passesCompFilters(j, compFloor, { meetsOnly, hideNoRange })) return false;
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
      av = ((a[sortKey as keyof Job] as string | null) ?? "").toLowerCase();
      bv = ((b[sortKey as keyof Job] as string | null) ?? "").toLowerCase();
      if (av < bv) return sortDir === "asc" ? -1 : 1;
      if (av > bv) return sortDir === "asc" ? 1 : -1;
      return 0;
    });

    return list;
    // meetsOnly, hideNoRange and compFloor belong here: omitting them leaves a
    // memo that paints correctly once and then never reacts to a toggle again.
  }, [jobs, search, statusFilter, sortKey, sortDir, meetsOnly, hideNoRange, compFloor]);

  async function handleStatus(job: Job, status: JobStatus) {
    setJobs((prev) => prev.map((j) => (j.id === job.id ? { ...j, status } : j)));
    await updateJob(job.id, { status });
  }

  async function handleDelete(id: string) {
    setJobs((prev) => prev.filter((j) => j.id !== id));
    await deleteJob(id);
  }

  async function handleFieldSave(id: string, field: keyof Job, value: string) {
    setJobs((prev) => prev.map((j) => (j.id === id ? { ...j, [field]: value } : j)));
    await updateJob(id, { [field]: value } as Partial<Job>);
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
            onClick={() => setShowRecruiter(true)}
            className="rounded-md border border-ink px-4 py-2 text-sm font-medium transition hover:bg-ink hover:text-white"
          >
            + Recruiter role
          </button>
          <button
            onClick={() => setShowAdd(true)}
            className="rounded-md border border-ink bg-ink px-4 py-2 text-sm font-medium text-white transition hover:bg-ink/90"
          >
            + Add manually
          </button>
        </div>
      </div>

      {/* Funnel summary */}
      <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        {FUNNEL.map((f) => (
          <button
            key={f.key}
            onClick={() => setStatusFilter(statusFilter === f.key ? "Open" : f.key as JobStatus | "All" | "Active" | "Out")}
            className={`rounded-lg border p-4 text-left transition ${
              statusFilter === f.key ? "border-ink" : "border-slate hover:border-ink/30"
            } bg-white`}
          >
            <div className="text-2xl font-heading font-semibold">{counts[f.key] ?? 0}</div>
            <div className="text-xs text-ink/60">{f.label}</div>
          </button>
        ))}
      </div>

      {/* Filters */}
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search company, role, or location…"
          className="w-full rounded-md border border-slate bg-white px-3 py-2 text-sm outline-none focus:border-ink sm:max-w-xs"
        />
        <div className="flex flex-wrap gap-2">
          {(["Open", "All", ...JOB_STATUSES] as const).map((s) => (
            <button
              key={s}
              onClick={() => setStatusFilter(s)}
              className={`rounded-full border px-3 py-1 text-xs font-medium transition ${
                statusFilter === s
                  ? "border-ink bg-ink text-white"
                  : "border-slate bg-white hover:border-ink"
              }`}
            >
              {s}
            </button>
          ))}
        </div>
      </div>

      {/* Compensation toggles. Chip STYLING from the status row above, not its
          mechanism — these two are independent, and neither is exclusive. */}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        {/* Hidden entirely when no floor is set: with nothing to compare
            against it would be a control that visibly does nothing. */}
        {compFloor !== null && (
          <button
            onClick={() => setMeetsOnly((v) => !v)}
            title={`Hide roles whose base tops out under $${compFloor.toLocaleString()}`}
            className={`rounded-full border px-3 py-1 text-xs font-medium transition ${
              meetsOnly ? "border-ink bg-ink text-white" : "border-slate bg-white hover:border-ink"
            }`}
          >
            Meets minimum
          </button>
        )}
        <button
          onClick={() => setHideNoRange((v) => !v)}
          title="Hide roles that published no readable salary range"
          className={`rounded-full border px-3 py-1 text-xs font-medium transition ${
            hideNoRange ? "border-ink bg-ink text-white" : "border-slate bg-white hover:border-ink"
          }`}
        >
          Hide no range listed
        </button>
      </div>

      {loading && <div className="py-12"><Spinner label="Loading roles…" /></div>}
      {error && !loading && (
        <div className="rounded-md border border-slate bg-white p-4 text-sm text-[#92400E]">{error}</div>
      )}
      {!loading && !error && filtered.length === 0 && (
        <div className="rounded-md border border-dashed border-slate p-12 text-center text-sm text-ink/50">
          No roles yet. Go to Discover, find a company, and click &quot;Find roles →&quot;.
        </div>
      )}

      {!loading && filtered.length > 0 && (
        <div className="rounded-lg border border-slate bg-white">
          {/* Sort bar */}
          <div className="flex items-center gap-1 border-b border-slate bg-canvas px-4 py-2 text-xs text-ink/50">
            <span>Sort:</span>
            {([["fit_score", "Fit"], ["company", "Company"], ["status", "Status"], ["stage", "Stage"]] as [SortKey, string][]).map(([key, label]) => (
              <button
                key={key}
                onClick={() => toggleSort(key)}
                className={`rounded px-2 py-0.5 transition ${sortKey === key ? "bg-ink text-white" : "hover:bg-slate"}`}
              >
                {label} {sortKey === key ? (sortDir === "asc" ? "↑" : "↓") : ""}
              </button>
            ))}
          </div>

          {filtered.map((job, idx) => (
            <div key={job.id} className={idx < filtered.length - 1 || expandedId === job.id ? "border-b border-slate" : ""}>
              {/* Main row */}
              <div
                className={`flex cursor-pointer items-center gap-4 px-4 py-3 transition hover:bg-canvas ${expandedId === job.id ? "bg-canvas" : ""}`}
                onClick={() => setExpandedId(expandedId === job.id ? null : job.id)}
              >
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
                    <CompTag job={job} floor={compFloor} />
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
                  {job.source === "Recruiter" && (
                    <span className="inline-flex items-center rounded-full bg-[#EDE9FE] px-2 py-0.5 text-xs font-medium text-[#5B21B6]">
                      Recruiter
                    </span>
                  )}
                  <StatusSelect value={job.status as JobStatus} onChange={(s) => handleStatus(job, s)} />
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

      {showAdd && (
        <AddPanel onClose={() => setShowAdd(false)} onAdded={() => { setShowAdd(false); void load(); }} />
      )}
      {showRecruiter && (
        <RecruiterPanel onClose={() => setShowRecruiter(false)} onAdded={() => { setShowRecruiter(false); void load(); }} />
      )}
    </div>
  );
}

/**
 * Names what a row's salary figure is when it is not a comparable base range.
 * "Range unreadable" is deliberately its own label: it is the only surface
 * where a salary-parser gap becomes visible to a human.
 */
function CompTag({ job, floor }: { job: Job; floor: number | null }) {
  const tag = COMP_BUCKET_TAGS[salaryBucketFor(job, floor)];
  if (!tag) return null;
  return (
    <span className="inline-flex items-center rounded-full border border-slate bg-canvas px-1.5 py-0.5 text-[10px] font-medium text-ink/50">
      {tag}
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

function StatusSelect({ value, onChange }: { value: JobStatus; onChange: (s: JobStatus) => void }) {
  const style = STATUS_STYLES[value] ?? "bg-[#F3F4F6] text-[#6B7280]";
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value as JobStatus)}
      className={`rounded-full border-0 px-2.5 py-1 text-xs font-medium outline-none cursor-pointer ${style}`}
    >
      {JOB_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
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

const EMPTY_FORM = {
  company: "", role_title: "", status: "New" as JobStatus,
  seniority: "", location: "", job_url: "", careers_url: "",
  category: "", salary_range: "", source: "", department: "", stage: "",
};

const EMPTY_ADD = {
  company: "", role_title: "", location: "", salary_range: "", department: "",
  job_url: "", company_url: "", company_description: "", stage: "", category: "",
  arr: "", exit_signal: "", backer: "", fit_summary: "", key_skills: "",
  ic_flag: false, status: "New" as JobStatus,
};

function AddPanel({ onClose, onAdded }: { onClose: () => void; onAdded: () => void }) {
  const [step, setStep] = useState<"url" | "review">("url");
  const [url, setUrl] = useState("");
  const [parsing, setParsing] = useState(false);
  const [parseError, setParseError] = useState<string | null>(null);
  const [form, setForm] = useState({ ...EMPTY_ADD });
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveStatus, setSaveStatus] = useState<string | null>(null);

  function set(k: keyof typeof EMPTY_ADD, v: string) {
    setForm((f) => ({ ...f, [k]: v }));
  }

  async function handleParse() {
    if (!url.trim()) return;
    setParsing(true);
    setParseError(null);
    const res = await parseJobUrl(url.trim());
    setParsing(false);
    if (res.error) { setParseError(res.error); return; }
    if (res.role) setForm((f) => ({ ...f, ...res.role }));
    setStep("review");
  }

  async function handleSave() {
    if (!form.company || !form.role_title) { setSaveError("Company and role title are required."); return; }
    setSaving(true);
    setSaveError(null);
    setSaveStatus("Scoring fit…");
    const [scoreRes, jobRes] = await Promise.all([
      scoreFit({
        company: form.company, role_title: form.role_title,
        company_description: form.company_description, key_skills: form.key_skills,
        fit_summary: form.fit_summary, department: form.department, location: form.location,
        arr: form.arr || undefined, exit_signal: form.exit_signal || undefined,
        backer: form.backer || undefined,
        // null, not omitted: this is a client component and cannot call
        // loadScoringInputs (it transitively imports `pg`). null tells the
        // server action to load the user's CURRENT stored fit brain, so a
        // manually-added role is scored against the edited criteria.
        fitInputs: null,
      }),
      addJob({
        company: form.company, role_title: form.role_title, status: form.status,
        location: form.location || null, salary_range: form.salary_range || null,
        department: form.department || null, job_url: form.job_url || null,
        company_url: form.company_url || null, company_description: form.company_description || null,
        stage: form.stage || null, category: form.category || null,
        arr: form.arr || null, exit_signal: form.exit_signal || null,
        backer: form.backer || null, ic_flag: form.ic_flag || false,
        fit_summary: form.fit_summary || null, key_skills: form.key_skills || null,
        source: "Manual",
      }),
    ]);
    if (jobRes.error) { setSaving(false); setSaveError(jobRes.error); return; }
    if (jobRes.job && scoreRes.score > 0) {
      const { updateJob } = await import("@/app/actions/jobs");
      await updateJob(jobRes.job.id, {
        fit_score: scoreRes.score,
        fit_summary: scoreRes.rationale || form.fit_summary || null,
      });
    }
    setSaving(false);
    setSaveStatus(null);
    onAdded();
  }

  const reviewFields: [keyof typeof EMPTY_ADD, string][] = [
    ["company", "Company *"], ["role_title", "Role title *"], ["stage", "Stage"],
    ["category", "Industry"], ["location", "Location"], ["salary_range", "Salary range"],
    ["arr", "ARR"], ["backer", "Backer"], ["exit_signal", "Exit signal"],
    ["company_url", "Company website"], ["job_url", "Job URL"],
  ];

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-ink/20">
      <div className="h-full w-full max-w-lg overflow-y-auto bg-white p-6">
        <div className="mb-4 flex items-center justify-between">
          <div>
            <h3 className="text-lg font-heading font-semibold">Add a role</h3>
            <p className="text-xs text-ink/50">
              {step === "url" ? "Paste a job posting URL to auto-fill details" : "Review and edit the extracted details"}
            </p>
          </div>
          <button onClick={onClose} className="text-ink/50 hover:text-ink">✕</button>
        </div>

        {step === "url" && (
          <div className="flex flex-col gap-4">
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-ink/60">Job posting URL</span>
              <input
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleParse()}
                placeholder="https://jobs.ashbyhq.com/company/..."
                className="w-full rounded-md border border-slate bg-canvas px-3 py-2 text-sm outline-none focus:border-ink"
              />
            </label>
            {parseError && <div className="rounded-md border border-slate p-3 text-sm text-[#92400E]">{parseError}</div>}
            {parsing && <Spinner label="Fetching job posting and company details…" />}
            <div className="flex gap-3">
              <button
                onClick={handleParse}
                disabled={parsing || !url.trim()}
                className="flex-1 rounded-md border border-ink bg-ink px-4 py-2 text-sm font-medium text-white transition hover:bg-ink/90 disabled:opacity-50"
              >
                {parsing ? "Fetching…" : "Fetch & extract →"}
              </button>
              <button onClick={onClose} className="rounded-md border border-slate px-4 py-2 text-sm hover:border-ink">Cancel</button>
            </div>
          </div>
        )}

        {step === "review" && (
          <div className="flex flex-col gap-4">
            <div className="rounded-lg border border-slate p-4">
              <div className="flex flex-col gap-3">
                {reviewFields.map(([key, label]) => (
                  <label key={key} className="block">
                    <span className="mb-1 block text-xs font-medium text-ink/60">{label}</span>
                    <input
                      value={form[key] as string}
                      onChange={(e) => set(key, e.target.value)}
                      className="w-full rounded-md border border-slate bg-white px-3 py-1.5 text-sm outline-none focus:border-ink"
                    />
                  </label>
                ))}
                <label className="block">
                  <span className="mb-1 block text-xs font-medium text-ink/60">Company description</span>
                  <textarea
                    value={form.company_description}
                    onChange={(e) => set("company_description", e.target.value)}
                    rows={2}
                    className="w-full rounded-md border border-slate bg-white px-3 py-1.5 text-sm outline-none focus:border-ink"
                  />
                </label>
                <label className="block">
                  <span className="mb-1 block text-xs font-medium text-ink/60">Status</span>
                  <select
                    value={form.status}
                    onChange={(e) => set("status", e.target.value)}
                    className="w-full rounded-md border border-slate bg-white px-3 py-1.5 text-sm outline-none focus:border-ink"
                  >
                    {JOB_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
                  </select>
                </label>
              </div>
            </div>
            {saveError && <div className="rounded-md border border-slate p-3 text-sm text-[#92400E]">{saveError}</div>}
            {saving && <Spinner label={saveStatus ?? "Saving…"} />}
            <div className="flex gap-3">
              <button onClick={handleSave} disabled={saving} className="flex-1 rounded-md border border-ink bg-ink px-4 py-2 text-sm font-medium text-white transition hover:bg-ink/90 disabled:opacity-50">
                {saving ? "Saving…" : "Save to Roles"}
              </button>
              <button onClick={() => setStep("url")} className="rounded-md border border-slate px-4 py-2 text-sm hover:border-ink">← Back</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
