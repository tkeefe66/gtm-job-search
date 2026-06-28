"use client";

import { useEffect, useState } from "react";
import { getJobs, updateJob, deleteJob } from "@/app/actions/jobs";
import { JOB_STATUSES, type Job, type JobStatus } from "@/lib/types";
import { Spinner } from "./ui";

const STATUS_STYLES: Record<string, string> = {
  New: "bg-[#DBEAFE] text-[#1E40AF]",
  Reviewing: "bg-[#FEF3C7] text-[#92400E]",
  Applied: "bg-[#EDE9FE] text-[#5B21B6]",
  "Not Interested": "bg-[#F3F4F6] text-[#6B7280]",
  Rejected: "bg-[#FEE2E2] text-[#991B1B]",
  Offer: "bg-[#DCFCE7] text-[#14532D]",
};

export default function RolesTable() {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<JobStatus | "All">("All");
  const [expandedId, setExpandedId] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    const res = await getJobs();
    if (res.error) setError(res.error);
    else setError(null);
    setJobs(res.jobs);
    setLoading(false);
  }

  useEffect(() => { void load(); }, []);

  const filtered = jobs.filter((j) => {
    if (statusFilter !== "All" && j.status !== statusFilter) return false;
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

  async function handleStatus(job: Job, status: JobStatus) {
    setJobs((prev) =>
      prev.map((j) => (j.id === job.id ? { ...j, status } : j))
    );
    await updateJob(job.id, { status });
  }

  async function handleDelete(id: string) {
    setJobs((prev) => prev.filter((j) => j.id !== id));
    await deleteJob(id);
  }

  async function handleFieldSave(id: string, field: keyof Job, value: string) {
    setJobs((prev) =>
      prev.map((j) => (j.id === id ? { ...j, [field]: value } : j))
    );
    await updateJob(id, { [field]: value } as Partial<Job>);
  }

  return (
    <div>
      <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-xl font-heading font-semibold">Roles</h2>
          <p className="text-sm text-ink/60">
            {jobs.length} role{jobs.length !== 1 ? "s" : ""} tracked. Find new ones from the Discover tab.
          </p>
        </div>
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
          {(["All", ...JOB_STATUSES] as const).map((s) => (
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

      {loading && (
        <div className="py-12"><Spinner label="Loading roles…" /></div>
      )}

      {error && !loading && (
        <div className="rounded-md border border-slate bg-white p-4 text-sm text-[#92400E]">
          {error}
        </div>
      )}

      {!loading && !error && filtered.length === 0 && (
        <div className="rounded-md border border-dashed border-slate p-12 text-center text-sm text-ink/50">
          No roles yet. Go to Discover, find a company, and click &quot;Find product roles →&quot;.
        </div>
      )}

      {!loading && filtered.length > 0 && (
        <div className="overflow-x-auto rounded-lg border border-slate">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate bg-canvas text-left">
                <th className="px-4 py-3 font-medium text-ink/60 whitespace-nowrap">Company</th>
                <th className="px-4 py-3 font-medium text-ink/60 whitespace-nowrap">Job Title</th>
                <th className="px-4 py-3 font-medium text-ink/60 whitespace-nowrap">Department</th>
                <th className="px-4 py-3 font-medium text-ink/60 whitespace-nowrap">Location</th>
                <th className="px-4 py-3 font-medium text-ink/60 whitespace-nowrap">Salary Range</th>
                <th className="px-4 py-3 font-medium text-ink/60 whitespace-nowrap">Fit Score</th>
                <th className="px-4 py-3 font-medium text-ink/60 whitespace-nowrap">Status</th>
                <th className="px-4 py-3 font-medium text-ink/60 whitespace-nowrap">Source</th>
                <th className="px-4 py-3 font-medium text-ink/60 whitespace-nowrap"></th>
              </tr>
            </thead>
            <tbody className="bg-white">
              {filtered.map((job, idx) => (
                <>
                  <tr
                    key={job.id}
                    className={`cursor-pointer border-b border-slate transition hover:bg-canvas ${
                      expandedId === job.id ? "bg-canvas" : ""
                    } ${idx === filtered.length - 1 ? "border-b-0" : ""}`}
                    onClick={() =>
                      setExpandedId(expandedId === job.id ? null : job.id)
                    }
                  >
                    <td className="px-4 py-3 font-medium whitespace-nowrap">{job.company}</td>
                    <td className="px-4 py-3 whitespace-nowrap">
                      {job.job_url ? (
                        <a
                          href={job.job_url}
                          target="_blank"
                          rel="noreferrer"
                          onClick={(e) => e.stopPropagation()}
                          className="underline underline-offset-2 hover:text-ink/60"
                        >
                          {job.role_title}
                        </a>
                      ) : (
                        job.role_title
                      )}
                    </td>
                    <td className="px-4 py-3 text-ink/70 whitespace-nowrap">
                      {job.department ?? job.seniority ?? "—"}
                    </td>
                    <td className="px-4 py-3 text-ink/70 whitespace-nowrap">
                      {job.location ?? "—"}
                    </td>
                    <td className="px-4 py-3 text-ink/70 whitespace-nowrap">
                      {job.salary_range ?? "—"}
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap">
                      <FitScore
                        score={job.fit_score}
                        onChange={(n) => {
                          handleFieldSave(job.id, "fit_score", String(n));
                        }}
                        onClick={(e) => e.stopPropagation()}
                      />
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap" onClick={(e) => e.stopPropagation()}>
                      <StatusSelect
                        value={job.status as JobStatus}
                        onChange={(s) => handleStatus(job, s)}
                      />
                    </td>
                    <td className="px-4 py-3 text-ink/50 whitespace-nowrap">
                      {job.source ?? "—"}
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap" onClick={(e) => e.stopPropagation()}>
                      <button
                        onClick={() => handleDelete(job.id)}
                        className="rounded border border-slate px-2 py-1 text-xs text-[#92400E] hover:border-[#92400E]"
                      >
                        Delete
                      </button>
                    </td>
                  </tr>

                  {expandedId === job.id && (
                    <tr key={`${job.id}-expanded`} className="border-b border-slate">
                      <td colSpan={9} className="bg-canvas px-4 py-4">
                        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                          {job.fit_summary && (
                            <Detail label="Fit rationale">{job.fit_summary}</Detail>
                          )}
                          {job.key_skills && (
                            <Detail label="Key skills">{job.key_skills}</Detail>
                          )}
                          {job.traction && (
                            <Detail label="Traction">{job.traction}</Detail>
                          )}
                          <Detail label="Notes">
                            <InlineEdit
                              value={job.notes ?? ""}
                              onSave={(v) => handleFieldSave(job.id, "notes", v)}
                              placeholder="Add notes…"
                            />
                          </Detail>
                          <Detail label="Salary range">
                            <InlineEdit
                              value={job.salary_range ?? ""}
                              onSave={(v) => handleFieldSave(job.id, "salary_range", v)}
                              placeholder="e.g. $200K–$280K"
                            />
                          </Detail>
                          <Detail label="Department">
                            <InlineEdit
                              value={job.department ?? ""}
                              onSave={(v) => handleFieldSave(job.id, "department", v)}
                              placeholder="e.g. Product"
                            />
                          </Detail>
                          <div className="flex gap-3">
                            {job.job_url && (
                              <a href={job.job_url} target="_blank" rel="noreferrer" className="text-sm underline underline-offset-2 hover:text-ink/60">
                                Job listing →
                              </a>
                            )}
                            {job.careers_url && (
                              <a href={job.careers_url} target="_blank" rel="noreferrer" className="text-sm underline underline-offset-2 hover:text-ink/60">
                                Careers page →
                              </a>
                            )}
                          </div>
                        </div>
                      </td>
                    </tr>
                  )}
                </>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function StatusSelect({
  value,
  onChange,
}: {
  value: JobStatus;
  onChange: (s: JobStatus) => void;
}) {
  const style = STATUS_STYLES[value] ?? "bg-[#F3F4F6] text-[#6B7280]";
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value as JobStatus)}
      className={`rounded-full border-0 px-2.5 py-1 text-xs font-medium outline-none cursor-pointer ${style}`}
    >
      {JOB_STATUSES.map((s) => (
        <option key={s} value={s}>{s}</option>
      ))}
    </select>
  );
}

function FitScore({
  score,
  onChange,
  onClick,
}: {
  score: number | null;
  onChange: (n: number) => void;
  onClick: (e: React.MouseEvent) => void;
}) {
  return (
    <span className="inline-flex gap-0.5" onClick={onClick}>
      {[1, 2, 3, 4, 5].map((n) => (
        <button
          key={n}
          type="button"
          onClick={(e) => { e.stopPropagation(); onChange(n); }}
          className={`text-sm leading-none cursor-pointer ${
            score && n <= score ? "text-ink" : "text-slate"
          }`}
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

function InlineEdit({
  value,
  onSave,
  placeholder,
}: {
  value: string;
  onSave: (v: string) => void;
  placeholder?: string;
}) {
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
