"use client";

import { useState } from "react";
import { countJobsByStatus, reassignStatus, saveJobStatuses } from "@/app/actions/settings";
import { slugify, type JobStatusDef } from "@/lib/job-statuses";
import { describeWriteFailure } from "@/lib/write-failure";
import { Spinner } from "./ui";

/** The row being deleted, and what we know about it. */
type Pending = { key: string; label: string; count: number; to: string };

export default function StatusEditor({ initial }: { initial: JobStatusDef[] }) {
  const [defs, setDefs] = useState<JobStatusDef[]>(initial);
  const [newLabel, setNewLabel] = useState("");
  const [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const patch = (key: string, next: Partial<JobStatusDef>) =>
    setDefs((prev) => prev.map((d) => (d.key === key ? { ...d, ...next } : d)));

  function move(index: number, delta: number) {
    const to = index + delta;
    if (to < 0 || to >= defs.length) return;
    const next = [...defs];
    [next[index], next[to]] = [next[to], next[index]];
    setDefs(next);
  }

  function addStatus() {
    const label = newLabel.trim();
    if (!label) return;
    const key = slugify(label, defs.map((d) => d.key));
    setDefs([...defs, { key, label, bucket: "active", hidden: false }]);
    setNewLabel("");
  }

  /** Reassignment may never target New — see the confirm copy below. */
  const targetsFor = (key: string) =>
    defs.filter((d) => d.key !== key && d.key !== "New");

  async function beginDelete(def: JobStatusDef) {
    setBusy(true);
    setError(null);
    const { counts, error: countError } = await countJobsByStatus();
    setBusy(false);
    // Presence, not truthiness: a failed count reading as 0 would silently
    // unlock this guard and delete a status with rows still on it.
    if (countError !== undefined) {
      // `?? null` because describeWriteFailure returns string | undefined and
      // this state is string | null — the same shape RolesTable.tsx:104 uses.
      setError(describeWriteFailure(countError, "check how many roles use that status") ?? null);
      return;
    }
    const count = counts[def.key] ?? 0;
    if (count === 0) {
      setDefs((prev) => prev.filter((d) => d.key !== def.key));
      return;
    }
    const targets = targetsFor(def.key);
    if (targets.length === 0) {
      setError("There is no other status to move those roles to.");
      return;
    }
    setPending({ key: def.key, label: def.label, count, to: targets[0].key });
  }

  /**
   * Reassign FIRST, then save.
   *
   * A failure between the two leaves rows on a key that is still in the list —
   * consistent and recoverable. The reverse order orphans them. But consistent
   * is not harmless: the UPDATE lands, the save fails, the banner reads "save
   * failed", and the user takes that to mean nothing happened while N rows of
   * hand-entered triage have been relabeled with no undo and no backups. Hence
   * the row count and the irreversibility in the confirm, and the moved count
   * in the result.
   */
  async function confirmDelete() {
    if (!pending) return;
    setBusy(true);
    setError(null);
    const { moved, error: moveError } = await reassignStatus(pending.key, pending.to);
    if (moveError !== undefined) {
      setBusy(false);
      setError(describeWriteFailure(moveError, "move those roles") ?? null);
      return;
    }
    const next = defs.filter((d) => d.key !== pending.key);
    const { error: saveError } = await saveJobStatuses(next);
    setBusy(false);
    if (saveError !== undefined) {
      // The rows ALREADY moved. Say so first — this is the half-applied case the
      // ordering comment above is about, and "save failed" alone would read as
      // "nothing happened".
      const detail = describeWriteFailure(saveError, "save your statuses") ?? "";
      setError(
        `${moved} role${moved === 1 ? "" : "s"} moved, but the status list did not save. ${detail}`
      );
      return;
    }
    setDefs(next);
    setPending(null);
    setNote(`Moved ${moved} role${moved === 1 ? "" : "s"} and deleted “${pending.label}”.`);
  }

  async function save() {
    setBusy(true);
    setError(null);
    setNote(null);
    const { error: saveError } = await saveJobStatuses(defs);
    setBusy(false);
    if (saveError !== undefined) {
      setError(describeWriteFailure(saveError, "save your statuses") ?? null);
      return;
    }
    setNote("Saved.");
  }

  return (
    <div className="rounded-lg border border-slate bg-white p-5">
      <h3 className="mb-1 font-heading text-sm font-semibold">Pipeline statuses</h3>
      <p className="mb-4 text-xs text-ink/60">
        Rename, reorder, hide, add or remove the statuses on your roles table.
        “Out” statuses are hidden by the table’s default filter and are skipped
        when you check links. New, Applied and Posting Closed are written by the
        app itself — you can rename them, but not remove them.
      </p>

      <div className="flex flex-col gap-2">
        {defs.map((d, i) => (
          <div key={d.key} className="flex items-center gap-2">
            <div className="flex flex-col">
              <button onClick={() => move(i, -1)} disabled={i === 0}
                className="px-1 text-xs disabled:opacity-25" aria-label="Move up">▲</button>
              <button onClick={() => move(i, 1)} disabled={i === defs.length - 1}
                className="px-1 text-xs disabled:opacity-25" aria-label="Move down">▼</button>
            </div>
            <input
              value={d.label}
              onChange={(e) => patch(d.key, { label: e.target.value })}
              className="flex-1 rounded-md border border-slate px-2 py-1 text-sm outline-none focus:border-ink"
            />
            <select
              value={d.bucket}
              // New must stay Open and Posting Closed must stay Out: the crawler
              // and the link-health pass both key off that split.
              disabled={d.key === "New" || d.key === "Posting Closed"}
              onChange={(e) =>
                patch(d.key, { bucket: e.target.value as JobStatusDef["bucket"] })
              }
              className="rounded-md border border-slate px-2 py-1 text-xs disabled:opacity-50"
            >
              <option value="active">Open</option>
              <option value="terminal">Out</option>
            </select>
            <label className="flex items-center gap-1 text-xs text-ink/60">
              <input
                type="checkbox"
                checked={d.hidden}
                disabled={Boolean(d.system)}
                onChange={(e) => patch(d.key, { hidden: e.target.checked })}
              />
              Hide
            </label>
            {d.system ? (
              <span className="w-16 text-center text-xs text-ink/30">system</span>
            ) : (
              <button onClick={() => void beginDelete(d)} disabled={busy}
                className="w-16 rounded px-2 py-1 text-xs text-[#991B1B] hover:bg-slate disabled:opacity-50">
                Delete
              </button>
            )}
          </div>
        ))}
      </div>

      {pending && (
        <div className="mt-4 rounded-md border border-[#991B1B]/40 p-3 text-sm">
          <p className="mb-2">
            Move {pending.count} role{pending.count === 1 ? "" : "s"} to{" "}
            <select
              value={pending.to}
              onChange={(e) => setPending({ ...pending, to: e.target.value })}
              className="rounded border border-slate px-1 py-0.5 text-sm"
            >
              {targetsFor(pending.key).map((t) => (
                <option key={t.key} value={t.key}>{t.label}</option>
              ))}
            </select>{" "}
            and delete “{pending.label}”?
          </p>
          <p className="mb-3 text-xs text-ink/60">
            This rewrites {pending.count} row{pending.count === 1 ? "" : "s"} and
            cannot be undone.
          </p>
          <div className="flex gap-2">
            <button onClick={() => void confirmDelete()} disabled={busy}
              className="rounded-md border border-ink bg-ink px-3 py-1 text-xs text-white disabled:opacity-50">
              Move and delete
            </button>
            <button onClick={() => setPending(null)} disabled={busy}
              className="rounded-md border border-slate px-3 py-1 text-xs">
              Cancel
            </button>
          </div>
        </div>
      )}

      <div className="mt-4 flex items-center gap-2">
        <input
          value={newLabel}
          onChange={(e) => setNewLabel(e.target.value)}
          placeholder="Add a status…"
          className="flex-1 rounded-md border border-slate px-2 py-1 text-sm outline-none focus:border-ink"
        />
        <button onClick={addStatus} disabled={!newLabel.trim()}
          className="rounded-md border border-slate px-3 py-1 text-xs disabled:opacity-50">
          Add
        </button>
      </div>

      <div className="mt-4 flex items-center gap-3">
        <button onClick={() => void save()} disabled={busy}
          className="rounded-md border border-ink bg-ink px-4 py-2 text-sm text-white disabled:opacity-50">
          Save statuses
        </button>
        {busy && <Spinner label="Saving…" />}
        {note && <span className="text-xs text-ink/60">{note}</span>}
      </div>

      {error && (
        <div className="mt-3 rounded-md border border-slate p-3 text-sm text-[#92400E]">
          {error}
        </div>
      )}
    </div>
  );
}
