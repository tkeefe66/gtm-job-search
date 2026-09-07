"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { deleteSavedResume, deleteSavedResumes } from "@/app/actions/saved-resumes";
import { UNDESCRIBED_DB_ERROR } from "@/lib/write-failure";
import { groupResumes, daysUntil } from "@/lib/saved-resume-grouping";
import type { SavedResumeSummary } from "@/lib/types";

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export default function SavedResumeList({ resumes }: { resumes: SavedResumeSummary[] }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [isPending, startTransition] = useTransition();

  const now = Date.now();
  const groups = groupResumes(resumes);
  const selectedIds = Object.keys(selected).filter((id) => selected[id]);

  function toggle(id: string) {
    setSelected((prev) => ({ ...prev, [id]: !prev[id] }));
  }

  function removeOne(r: SavedResumeSummary) {
    if (
      !window.confirm(
        `Delete this saved résumé for ${r.roleTitle} at ${r.company}? This cannot be undone.`
      )
    )
      return;
    setError(null);
    startTransition(async () => {
      const res = await deleteSavedResume(r.id);
      // Presence, not truthiness: the message can legitimately be "".
      if (res.error !== undefined) setError(res.error || UNDESCRIBED_DB_ERROR);
      else router.refresh();
    });
  }

  function removeSelected() {
    const ids = selectedIds;
    if (ids.length === 0) return;
    if (!window.confirm(`Delete ${ids.length} saved résumés? This cannot be undone.`)) return;
    setError(null);
    startTransition(async () => {
      const res = await deleteSavedResumes(ids);
      if (res.error !== undefined) setError(res.error || UNDESCRIBED_DB_ERROR);
      else {
        setSelected({});
        router.refresh();
      }
    });
  }

  return (
    <div className="mt-4 flex flex-col gap-6">
      <div className="flex items-center gap-3">
        <p className="text-sm text-ink/70">
          {resumes.length} saved {resumes.length === 1 ? "résumé" : "résumés"}
        </p>
        {selectedIds.length > 1 && (
          <button
            onClick={removeSelected}
            disabled={isPending}
            className="rounded border border-slate px-3 py-1.5 text-sm hover:border-ink disabled:opacity-50"
          >
            Delete selected ({selectedIds.length})
          </button>
        )}
      </div>

      {error && <p className="text-sm text-[#92400E]">{error}</p>}

      {groups.map((g) => (
        <section key={g.key} className="flex flex-col gap-2">
          <h2 className="text-sm font-semibold">
            {g.roleTitle} <span className="font-normal text-ink/60">at {g.company}</span>
          </h2>
          {g.jobId !== null ? (
            <Link
              href={`/resume?jobId=${g.jobId}`}
              className="text-xs text-ink/60 underline underline-offset-2"
            >
              Open the working draft
            </Link>
          ) : (
            <p className="text-xs text-ink/50">Role no longer tracked</p>
          )}

          <ul className="flex flex-col gap-2">
            {g.items.map((r) => {
              const days = daysUntil(r.expiresAt, now);
              return (
                <li
                  key={r.id}
                  className="flex flex-wrap items-center gap-3 rounded border border-slate px-3 py-2"
                >
                  <input
                    type="checkbox"
                    checked={!!selected[r.id]}
                    onChange={() => toggle(r.id)}
                    aria-label={`Select the résumé saved on ${formatDate(r.createdAt)}`}
                  />
                  <span className="text-sm">{formatDate(r.createdAt)}</span>
                  {r.label && <span className="text-sm text-ink/70">{r.label}</span>}
                  <span
                    className={
                      days < 7 ? "text-xs text-[#92400E]" : "text-xs text-ink/50"
                    }
                  >
                    expires in {days} {days === 1 ? "day" : "days"}
                  </span>
                  <span className="ml-auto flex items-center gap-3">
                    <Link
                      href={`/resume?savedId=${r.id}`}
                      className="text-sm underline underline-offset-2"
                    >
                      Open
                    </Link>
                    <button
                      onClick={() => removeOne(r)}
                      disabled={isPending}
                      className="text-sm text-ink/60 underline underline-offset-2 hover:text-ink disabled:opacity-50"
                    >
                      Delete
                    </button>
                  </span>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}
