"use client";

import { useEffect, useMemo, useState } from "react";
import {
  getJobs,
  updateJobStatus,
  updateJob,
  deleteJob,
  addJob,
} from "@/app/actions/jobs";
import { JOB_STATUSES, type Job, type JobStatus } from "@/lib/types";
import { StatusBadge, SeniorityBadge, Stars, Spinner } from "./ui";

const FUNNEL: JobStatus[] = ["Tracking", "Applied", "Interviewing", "Offer"];

export default function Tracker({ refreshKey }: { refreshKey: number }) {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<JobStatus | "All">("All");
  const [search, setSearch] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);

  async function load() {
    setLoading(true);
    const res = await getJobs();
    if (res.error) setError(res.error);
    else setError(null);
    setJobs(res.jobs);
    setLoading(false);
  }

  useEffect(() => {
    void load();
  }, [refreshKey]);

  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const s of JOB_STATUSES) c[s] = 0;
    for (const j of jobs) c[j.status] = (c[j.status] ?? 0) + 1;
    return c;
  }, [jobs]);

  const filtered = useMemo(() => {
    return jobs.filter((j) => {
      if (statusFilter !== "All" && j.status !== statusFilter) return false;
      if (search) {
        const q = search.toLowerCase();
        if (
          !j.company.toLowerCase().includes(q) &&
          !j.role_title.toLowerCase().includes(q)
        )
          return false;
      }
      return true;
    });
  }, [jobs, statusFilter, search]);

  async function handleStatus(job: Job, status: JobStatus) {
    setJobs((prev) =>
      prev.map((j) => (j.id === job.id ? { ...j, status } : j))
    );
    const res = await updateJobStatus(job.id, status);
    if (res.error) void load();
  }

  async function handleStars(job: Job, n: number) {
    setJobs((prev) =>
      prev.map((j) => (j.id === job.id ? { ...j, fit_score: n } : j))
    );
    await updateJob(job.id, { fit_score: n });
  }

  async function handleNotes(job: Job, notes: string) {
    setJobs((prev) =>
      prev.map((j) => (j.id === job.id ? { ...j, notes } : j))
    );
    await updateJob(job.id, { notes });
  }

  async function handleDelete(id: string) {
    setJobs((prev) => prev.filter((j) => j.id !== id));
    await deleteJob(id);
  }

  return (
    <div>
      <div className="mb-6 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <h2 className="text-xl font-heading font-semibold">Job tracker</h2>
        <button
          onClick={() => setShowAdd(true)}
          className="rounded-md border border-ink bg-ink px-4 py-2 text-sm font-medium text-white transition hover:bg-ink/90"
        >
          + Add role manually
        </button>
      </div>

      {/* Funnel summary */}
      <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        {FUNNEL.map((s) => (
          <div
            key={s}
            className="rounded-lg border border-slate bg-white p-4"
          >
            <div className="text-2xl font-heading font-semibold">
              {counts[s] ?? 0}
            </div>
            <div className="text-xs text-ink/60">{s}</div>
          </div>
        ))}
      </div>

      {/* Filters */}
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search company or role…"
          className="w-full rounded-md border border-slate bg-white px-3 py-2 text-sm outline-none focus:border-ink sm:max-w-xs"
        />
        <div className="flex flex-wrap gap-2">
          {(["All", ...JOB_STATUSES] as const).map((s) => (
            <button
              key={s}
              onClick={() => setStatusFilter(s)}
              className={`rounded-md border px-3 py-1.5 text-sm transition ${
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
        <div className="py-12">
          <Spinner label="Loading your pipeline…" />
        </div>
      )}

      {error && !loading && (
        <div className="rounded-md border border-slate bg-white p-4 text-sm text-[#92400E]">
          {error}
        </div>
      )}

      {!loading && !error && filtered.length === 0 && (
        <div className="rounded-md border border-dashed border-slate p-12 text-center text-sm text-ink/50">
          No jobs yet. Add roles from Discover or click &quot;Add role
          manually&quot;.
        </div>
      )}

      <div className="overflow-hidden rounded-lg border border-slate bg-white">
        {filtered.map((job, idx) => (
          <div
            key={job.id}
            className={idx > 0 ? "border-t border-slate" : ""}
          >
            <div className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-heading font-semibold">
                    {job.company}
                  </span>
                  <span className="text-ink/40">·</span>
                  <span className="text-sm text-ink/80">{job.role_title}</span>
                  {job.seniority && (
                    <SeniorityBadge seniority={job.seniority} />
                  )}
                </div>
                {job.location && (
                  <div className="mt-1 text-xs text-ink/50">
                    {job.location}
                  </div>
                )}
              </div>

              <Stars
                score={job.fit_score}
                onChange={(n) => handleStars(job, n)}
              />

              <select
                value={job.status}
                onChange={(e) =>
                  handleStatus(job, e.target.value as JobStatus)
                }
                className="rounded-md border border-slate bg-white px-2 py-1 text-sm outline-none focus:border-ink"
              >
                {JOB_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>

              <div className="flex items-center gap-2 text-sm">
                <button
                  onClick={() =>
                    setExpanded(expanded === job.id ? null : job.id)
                  }
                  className="rounded-md border border-slate px-2 py-1 hover:border-ink"
                >
                  {expanded === job.id ? "Close" : "Notes"}
                </button>
                <button
                  onClick={() => handleDelete(job.id)}
                  className="rounded-md border border-slate px-2 py-1 text-[#92400E] hover:border-[#92400E]"
                >
                  Delete
                </button>
              </div>
            </div>

            {expanded === job.id && (
              <div className="border-t border-slate bg-canvas/50 p-4">
                <div className="mb-3 flex flex-wrap gap-3 text-sm">
                  {job.job_url && (
                    <a
                      href={job.job_url}
                      target="_blank"
                      rel="noreferrer"
                      className="underline-offset-2 hover:underline"
                    >
                      Job listing →
                    </a>
                  )}
                  {job.careers_url && (
                    <a
                      href={job.careers_url}
                      target="_blank"
                      rel="noreferrer"
                      className="underline-offset-2 hover:underline"
                    >
                      Careers page →
                    </a>
                  )}
                  {job.fit_summary && (
                    <span className="text-ink/60">
                      Fit: {job.fit_summary}
                    </span>
                  )}
                </div>
                <NotesEditor
                  initial={job.notes ?? ""}
                  onSave={(v) => handleNotes(job, v)}
                />
              </div>
            )}
          </div>
        ))}
      </div>

      {showAdd && (
        <AddPanel
          onClose={() => setShowAdd(false)}
          onAdded={() => {
            setShowAdd(false);
            void load();
          }}
        />
      )}
    </div>
  );
}

function NotesEditor({
  initial,
  onSave,
}: {
  initial: string;
  onSave: (v: string) => void;
}) {
  const [value, setValue] = useState(initial);
  const [dirty, setDirty] = useState(false);
  return (
    <div>
      <textarea
        value={value}
        onChange={(e) => {
          setValue(e.target.value);
          setDirty(true);
        }}
        onBlur={() => {
          if (dirty) {
            onSave(value);
            setDirty(false);
          }
        }}
        placeholder="Notes…"
        rows={3}
        className="w-full rounded-md border border-slate bg-white px-3 py-2 text-sm outline-none focus:border-ink"
      />
      <div className="mt-2 flex justify-end">
        <button
          onClick={() => {
            onSave(value);
            setDirty(false);
          }}
          className="rounded-md border border-ink px-3 py-1 text-sm hover:bg-ink hover:text-white"
        >
          Save
        </button>
      </div>
    </div>
  );
}

const EMPTY = {
  company: "",
  role_title: "",
  status: "Tracking" as JobStatus,
  seniority: "",
  location: "",
  job_url: "",
  careers_url: "",
  category: "",
};

function AddPanel({
  onClose,
  onAdded,
}: {
  onClose: () => void;
  onAdded: () => void;
}) {
  const [form, setForm] = useState({ ...EMPTY });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function set(k: keyof typeof EMPTY, v: string) {
    setForm((f) => ({ ...f, [k]: v }));
  }

  async function save() {
    if (!form.company || !form.role_title) {
      setError("Company and role title are required.");
      return;
    }
    setSaving(true);
    const res = await addJob({
      company: form.company,
      role_title: form.role_title,
      status: form.status,
      seniority: form.seniority || null,
      location: form.location || null,
      job_url: form.job_url || null,
      careers_url: form.careers_url || null,
      category: form.category || null,
    });
    setSaving(false);
    if (res.error) {
      setError(res.error);
      return;
    }
    onAdded();
  }

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-ink/20">
      <div className="h-full w-full max-w-md overflow-y-auto bg-white p-6">
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-lg font-heading font-semibold">Add a role</h3>
          <button
            onClick={onClose}
            className="text-ink/50 hover:text-ink"
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        {error && (
          <div className="mb-3 rounded-md border border-slate bg-canvas p-3 text-sm text-[#92400E]">
            {error}
          </div>
        )}

        <div className="flex flex-col gap-3">
          <Field label="Company *">
            <input
              value={form.company}
              onChange={(e) => set("company", e.target.value)}
              className="field"
            />
          </Field>
          <Field label="Role title *">
            <input
              value={form.role_title}
              onChange={(e) => set("role_title", e.target.value)}
              className="field"
            />
          </Field>
          <Field label="Status">
            <select
              value={form.status}
              onChange={(e) => set("status", e.target.value)}
              className="field"
            >
              {JOB_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Seniority">
            <input
              value={form.seniority}
              onChange={(e) => set("seniority", e.target.value)}
              placeholder="VP/CPO, Director, Senior PM, PM"
              className="field"
            />
          </Field>
          <Field label="Location">
            <input
              value={form.location}
              onChange={(e) => set("location", e.target.value)}
              className="field"
            />
          </Field>
          <Field label="Category">
            <input
              value={form.category}
              onChange={(e) => set("category", e.target.value)}
              className="field"
            />
          </Field>
          <Field label="Job URL">
            <input
              value={form.job_url}
              onChange={(e) => set("job_url", e.target.value)}
              className="field"
            />
          </Field>
          <Field label="Careers URL">
            <input
              value={form.careers_url}
              onChange={(e) => set("careers_url", e.target.value)}
              className="field"
            />
          </Field>
        </div>

        <div className="mt-6 flex gap-3">
          <button
            onClick={save}
            disabled={saving}
            className="flex-1 rounded-md border border-ink bg-ink px-4 py-2 text-sm font-medium text-white transition hover:bg-ink/90 disabled:opacity-50"
          >
            {saving ? "Saving…" : "Save role"}
          </button>
          <button
            onClick={onClose}
            className="rounded-md border border-slate px-4 py-2 text-sm hover:border-ink"
          >
            Cancel
          </button>
        </div>
      </div>

      <style jsx>{`
        :global(.field) {
          width: 100%;
          border: 1px solid #e8e8e6;
          background: #fff;
          border-radius: 0.375rem;
          padding: 0.5rem 0.75rem;
          font-size: 0.875rem;
          outline: none;
        }
        :global(.field:focus) {
          border-color: #141414;
        }
      `}</style>
    </div>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-ink/60">
        {label}
      </span>
      {children}
    </label>
  );
}
