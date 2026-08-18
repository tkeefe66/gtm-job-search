"use client";

import { useState } from "react";
import { countJobsByStatus, reassignStatus, saveJobStatuses } from "@/app/actions/settings";
import { sinkHidden, slugify, type JobStatusDef } from "@/lib/job-statuses";
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
  // Keyed by status key, so a bucket change explains itself next to the row it
  // happened on rather than in a banner at the bottom of the card.
  const [bucketNotes, setBucketNotes] = useState<Record<string, string>>({});

  const patch = (key: string, next: Partial<JobStatusDef>) =>
    setDefs((prev) => prev.map((d) => (d.key === key ? { ...d, ...next } : d)));

  /**
   * Explains a bucket change inline, because the consequences are invisible.
   *
   * Out → Open re-arms "Check links" against every role holding this status
   * (one HTTP liveness check per role — no Claude tokens) and returns those
   * rows to the table's default view. Open → Out does the reverse.
   *
   * Deliberately COUNTLESS. The count would need a `countJobsByStatus` round
   * trip on every flip of a <select>, and this component holds no counts of its
   * own — a database read for one clause of one sentence is not proportionate.
   */
  function changeBucket(key: string, bucket: JobStatusDef["bucket"]) {
    patch(key, { bucket });
    setBucketNotes((prev) => ({
      ...prev,
      [key]:
        bucket === "active"
          ? "Now an Open status: roles holding it come back into the table’s " +
            "default view, and “Check links” will re-check each one (an HTTP " +
            "request per role — no AI cost)."
          : "Now an Out status: roles holding it are hidden by the table’s " +
            "default filter and skipped when you check links.",
    }));
  }

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

  /**
   * DELETE IS ALWAYS LOCAL. Both paths through it remove the row from `defs`
   * and persist nothing; "Save statuses" is the only thing in this component
   * that writes the config.
   *
   * The alternative — deleting a status writes the whole array — made "Delete"
   * mean two different things depending on whether the status happened to have
   * rows on it: the zero-count path mutated state and stored nothing (delete,
   * navigate away, it is back), while the rows-present path committed every
   * unrelated pending rename, reorder and addition alongside it. Most statuses
   * have zero rows, so users met the path that looks broken first and the one
   * that quietly over-commits second.
   *
   * The reassignment still runs immediately — it moves database rows and there
   * is nowhere to stage that — so the rows-present path says so, in the note it
   * leaves behind.
   */
  async function beginDelete(def: JobStatusDef) {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const { counts, error: countError } = await countJobsByStatus();
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
        // Says what is and is not stored. Without this the row vanishes, the
        // user leaves, and the status is still there on the next load.
        setNote(`Removed “${def.label}” from the list. Click “Save statuses” to store it.`);
        return;
      }
      const targets = targetsFor(def.key);
      if (targets.length === 0) {
        setError("There is no other status to move those roles to.");
        return;
      }
      setPending({ key: def.key, label: def.label, count, to: targets[0].key });
    } catch (err) {
      // countJobsByStatus calls requireActor() first, which THROWS (rather than
      // returning an error) on an expired or missing session — see
      // lib/require-actor.ts, and the same catch in RecruiterPanel.tsx. A server
      // action can also reject on a restart or a 500. Without this the button
      // would stay disabled forever behind a `busy` that never cleared.
      setError(
        describeWriteFailure(
          err instanceof Error ? err.message : String(err),
          "check how many roles use that status"
        ) ?? null
      );
    } finally {
      setBusy(false);
    }
  }

  /**
   * Moves the rows, then removes the status from the LOCAL list only.
   *
   * Reassign first and store nothing: a failure leaves rows on a key that is
   * still in the config — consistent and recoverable — where the reverse order
   * orphans them. Because the config write no longer rides along, there is no
   * half-applied state to explain: either the rows moved or they did not.
   *
   * The removal is computed inside setDefs rather than from the closure's
   * `defs`, so a rename or reorder made while the reassignment was in flight
   * survives instead of being silently reverted.
   */
  async function confirmDelete() {
    if (!pending) return;
    const target = pending;
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const { moved, error: moveError } = await reassignStatus(target.key, target.to);
      if (moveError !== undefined) {
        setError(describeWriteFailure(moveError, "move those roles") ?? null);
        return;
      }
      setDefs((prev) => prev.filter((d) => d.key !== target.key));
      setPending(null);
      setNote(
        `Moved ${moved} role${moved === 1 ? "" : "s"}. Click “Save statuses” to ` +
          `finish removing “${target.label}”.`
      );
    } catch (err) {
      // Same reason as beginDelete's catch: requireActor throws, and a server
      // action can reject outright. A rejection cannot prove the UPDATE did not
      // land — the response may simply have been lost — so this promises
      // nothing about the rows and says how to find out.
      const detail =
        describeWriteFailure(
          err instanceof Error ? err.message : String(err),
          "move those roles"
        ) ?? "";
      setError(
        `${detail} “${target.label}” was NOT removed from the list, but some roles ` +
          `may already have moved — reload the page to see where they are.`
      );
    } finally {
      setBusy(false);
    }
  }

  /**
   * Saves the list with every hidden status sunk to the bottom.
   *
   * The reorder is what gets STORED, and `setDefs` puts the same array on
   * screen — the editor must not keep showing an order the config no longer
   * has, or the next save would write the stale one back.
   */
  async function save() {
    setBusy(true);
    setError(null);
    setNote(null);
    const ordered = sinkHidden(defs);
    const moved = ordered.some((d, i) => d.key !== defs[i].key);
    try {
      const { error: saveError } = await saveJobStatuses(ordered);
      if (saveError !== undefined) {
        setError(describeWriteFailure(saveError, "save your statuses") ?? null);
        return;
      }
      setDefs(ordered);
      setNote(moved ? "Saved. Hidden statuses moved to the bottom." : "Saved.");
    } catch (err) {
      // Same reason as beginDelete's catch. This one matters most: without it a
      // rejected save left the spinner up, the banner empty, and the user
      // believing their renames were stored.
      setError(
        describeWriteFailure(
          err instanceof Error ? err.message : String(err),
          "save your statuses"
        ) ?? null
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-lg border border-slate bg-white p-5">
      <h3 className="mb-1 font-heading text-sm font-semibold">Pipeline statuses</h3>
      <p className="mb-2 text-xs text-ink/60">
        Rename, reorder, hide, add or remove the statuses on your roles table.
        “Out” statuses are hidden by the table’s default filter and are skipped
        when you check links. Hidden statuses drop to the bottom of this list
        when you save. New, Applied and Posting Closed are written by the
        app itself — you can rename them, but not hide or remove them.
      </p>
      {/*
        Says the persistence rule once, plainly. Everything on this card is a
        draft until "Save statuses" — including a delete. The one exception is
        moving roles off a status you are deleting, which is a database write
        with nowhere to be staged.
      */}
      <p className="mb-4 text-xs text-ink/60">
        Nothing here is stored until you click “Save statuses”. The one
        exception: deleting a status that has roles on it moves those roles
        straight away, because that rewrites the roles themselves.
      </p>

      <div className="flex flex-col gap-2">
        {defs.map((d, i) => (
          <div key={d.key} className="flex flex-col gap-1">
            <div className="flex items-center gap-2">
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
                  changeBucket(d.key, e.target.value as JobStatusDef["bucket"])
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
            {bucketNotes[d.key] && (
              <p className="pl-8 text-xs text-[#92400E]">{bucketNotes[d.key]}</p>
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
            This rewrites {pending.count} row{pending.count === 1 ? "" : "s"} as
            soon as you confirm, and cannot be undone. Removing “{pending.label}”
            from the list itself is not stored until you click “Save statuses”.
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
        {/* "Working…", not "Saving…": `busy` also covers the count and the
            reassignment, and a delete deliberately saves nothing. */}
        {busy && <Spinner label="Working…" />}
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
