"use client";

import { useState } from "react";
import { parseRecruiterText, scoreFit } from "@/app/actions/parse-role";
import { addJob } from "@/app/actions/jobs";
import { JOB_STATUSES, type JobStatus } from "@/lib/types";
import { Spinner } from "./ui";

interface Props {
  onClose: () => void;
  onAdded: () => void;
}

const EMPTY = {
  company: "",
  role_title: "",
  location: "",
  salary_range: "",
  department: "",
  job_url: "",
  company_url: "",
  company_description: "",
  stage: "",
  category: "",
  arr: "",
  exit_signal: "",
  backer: "",
  fit_summary: "",
  key_skills: "",
  recruiter_name: "",
  recruiter_email: "",
  recruiter_company: "",
  recruiter_notes: "",
  status: "New" as JobStatus,
};

export default function RecruiterPanel({ onClose, onAdded }: Props) {
  const [step, setStep] = useState<"paste" | "review">("paste");
  const [pasteText, setPasteText] = useState("");
  const [parsing, setParsing] = useState(false);
  const [parseError, setParseError] = useState<string | null>(null);
  const [form, setForm] = useState({ ...EMPTY });
  const [saving, setSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  function set(k: keyof typeof EMPTY, v: string) {
    setForm((f) => ({ ...f, [k]: v }));
  }

  async function handleParse() {
    if (!pasteText.trim()) return;
    setParsing(true);
    setParseError(null);
    const res = await parseRecruiterText(pasteText);
    setParsing(false);
    if (res.error) { setParseError(res.error); return; }
    if (res.role) setForm((f) => ({ ...f, ...res.role }));
    setStep("review");
  }

  async function handleSave() {
    if (!form.company || !form.role_title) {
      setSaveError("Company and role title are required.");
      return;
    }
    setSaving(true);
    setSaveError(null);

    // Score fit in parallel with saving.
    setSaveStatus("Scoring fit…");
    const [scoreRes, jobRes] = await Promise.all([
      scoreFit({
        company: form.company,
        role_title: form.role_title,
        company_description: form.company_description,
        key_skills: form.key_skills,
        fit_summary: form.fit_summary,
        department: form.department,
        location: form.location,
      }),
      addJob({
        company: form.company,
        role_title: form.role_title,
        status: form.status,
        location: form.location || null,
        salary_range: form.salary_range || null,
        department: form.department || null,
        job_url: form.job_url || null,
        company_url: form.company_url || null,
        company_description: form.company_description || null,
        stage: form.stage || null,
        category: form.category || null,
        arr: form.arr || null,
        exit_signal: form.exit_signal || null,
        backer: form.backer || null,
        fit_summary: form.fit_summary || null,
        key_skills: form.key_skills || null,
        recruiter_name: form.recruiter_name || null,
        recruiter_email: form.recruiter_email || null,
        recruiter_company: form.recruiter_company || null,
        recruiter_notes: form.recruiter_notes || null,
        notes: pasteText || null,
        source: "Recruiter",
      }),
    ]);

    if (jobRes.error) { setSaving(false); setSaveError(jobRes.error); return; }

    // If we got a fit score, patch it onto the saved job.
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

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-ink/20">
      <div className="h-full w-full max-w-lg overflow-y-auto bg-white p-6">
        <div className="mb-4 flex items-center justify-between">
          <div>
            <h3 className="text-lg font-heading font-semibold">Add recruiter role</h3>
            <p className="text-xs text-ink/50">
              {step === "paste"
                ? "Paste the recruiter message or job description"
                : "Review and edit the extracted details"}
            </p>
          </div>
          <button onClick={onClose} className="text-ink/50 hover:text-ink">✕</button>
        </div>

        {/* Step 1 — Paste */}
        {step === "paste" && (
          <div className="flex flex-col gap-4">
            <textarea
              value={pasteText}
              onChange={(e) => setPasteText(e.target.value)}
              placeholder="Paste the recruiter's email, LinkedIn message, or job description here…"
              rows={14}
              className="w-full rounded-md border border-slate bg-canvas px-3 py-2 text-sm outline-none focus:border-ink"
            />
            {parseError && (
              <div className="rounded-md border border-slate p-3 text-sm text-[#92400E]">{parseError}</div>
            )}
            {parsing && <Spinner label="Extracting role details and looking up company…" />}
            <div className="flex gap-3">
              <button
                onClick={handleParse}
                disabled={parsing || !pasteText.trim()}
                className="flex-1 rounded-md border border-ink bg-ink px-4 py-2 text-sm font-medium text-white transition hover:bg-ink/90 disabled:opacity-50"
              >
                {parsing ? "Extracting…" : "Extract role details →"}
              </button>
              <button onClick={onClose} className="rounded-md border border-slate px-4 py-2 text-sm hover:border-ink">
                Cancel
              </button>
            </div>
          </div>
        )}

        {/* Step 2 — Review */}
        {step === "review" && (
          <div className="flex flex-col gap-4">
            {/* Company info */}
            <div className="rounded-lg border border-slate p-4">
              <h4 className="mb-3 text-xs font-semibold uppercase tracking-wide text-ink/50">Company</h4>
              <div className="flex flex-col gap-3">
                {(
                  [
                    ["company", "Company name *"],
                    ["company_url", "Company website"],
                    ["arr", "ARR (e.g. $380M+)"],
                    ["backer", "Investor / Backer"],
                    ["exit_signal", "Exit signal (e.g. PE exit planned, IPO path)"],
                  ] as [keyof typeof EMPTY, string][]
                ).map(([key, label]) => (
                  <Field key={key} label={label}>
                    <input
                      value={form[key] as string}
                      onChange={(e) => set(key, e.target.value)}
                      className="w-full rounded-md border border-slate bg-white px-3 py-1.5 text-sm outline-none focus:border-ink"
                    />
                  </Field>
                ))}
                <Field label="Company description">
                  <textarea
                    value={form.company_description}
                    onChange={(e) => set("company_description", e.target.value)}
                    rows={2}
                    className="w-full rounded-md border border-slate bg-white px-3 py-1.5 text-sm outline-none focus:border-ink"
                  />
                </Field>
              </div>
            </div>

            {/* Role details */}
            <div className="rounded-lg border border-slate p-4">
              <h4 className="mb-3 text-xs font-semibold uppercase tracking-wide text-ink/50">Role details</h4>
              <div className="flex flex-col gap-3">
                {(
                  [
                    ["role_title", "Role title *"],
                    ["department", "Department"],
                    ["stage", "Stage (e.g. Series B, PE-backed, Public)"],
                    ["category", "Industry"],
                    ["location", "Location"],
                    ["salary_range", "Salary range"],
                    ["job_url", "Job URL"],
                    ["key_skills", "Key skills"],
                  ] as [keyof typeof EMPTY, string][]
                ).map(([key, label]) => (
                  <Field key={key} label={label}>
                    <input
                      value={form[key] as string}
                      onChange={(e) => set(key, e.target.value)}
                      className="w-full rounded-md border border-slate bg-white px-3 py-1.5 text-sm outline-none focus:border-ink"
                    />
                  </Field>
                ))}
                <Field label="Fit summary">
                  <textarea
                    value={form.fit_summary}
                    onChange={(e) => set("fit_summary", e.target.value)}
                    rows={2}
                    className="w-full rounded-md border border-slate bg-white px-3 py-1.5 text-sm outline-none focus:border-ink"
                  />
                </Field>
                <Field label="Status">
                  <select
                    value={form.status}
                    onChange={(e) => set("status", e.target.value)}
                    className="w-full rounded-md border border-slate bg-white px-3 py-1.5 text-sm outline-none focus:border-ink"
                  >
                    {JOB_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
                  </select>
                </Field>
              </div>
            </div>

            {/* Recruiter info */}
            <div className="rounded-lg border border-slate p-4">
              <h4 className="mb-3 text-xs font-semibold uppercase tracking-wide text-ink/50">Recruiter</h4>
              <div className="flex flex-col gap-3">
                {(
                  [
                    ["recruiter_name", "Name"],
                    ["recruiter_company", "Agency / Company"],
                    ["recruiter_email", "Email"],
                  ] as [keyof typeof EMPTY, string][]
                ).map(([key, label]) => (
                  <Field key={key} label={label}>
                    <input
                      value={form[key] as string}
                      onChange={(e) => set(key, e.target.value)}
                      className="w-full rounded-md border border-slate bg-white px-3 py-1.5 text-sm outline-none focus:border-ink"
                    />
                  </Field>
                ))}
                <Field label="Notes from conversation">
                  <textarea
                    value={form.recruiter_notes}
                    onChange={(e) => set("recruiter_notes", e.target.value)}
                    rows={3}
                    placeholder="e.g. Said they have 3 candidates, looking to move fast…"
                    className="w-full rounded-md border border-slate bg-white px-3 py-1.5 text-sm outline-none focus:border-ink"
                  />
                </Field>
              </div>
            </div>

            {saveError && (
              <div className="rounded-md border border-slate p-3 text-sm text-[#92400E]">{saveError}</div>
            )}

            {saving && <Spinner label={saveStatus ?? "Saving…"} />}

            <div className="flex gap-3">
              <button
                onClick={handleSave}
                disabled={saving}
                className="flex-1 rounded-md border border-ink bg-ink px-4 py-2 text-sm font-medium text-white transition hover:bg-ink/90 disabled:opacity-50"
              >
                {saving ? "Saving…" : "Save to Roles"}
              </button>
              <button
                onClick={() => setStep("paste")}
                className="rounded-md border border-slate px-4 py-2 text-sm hover:border-ink"
              >
                ← Back
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-ink/60">{label}</span>
      {children}
    </label>
  );
}
