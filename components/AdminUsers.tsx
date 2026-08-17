"use client";

import { useEffect, useState } from "react";
import { listUsers, approveUser, denyUser, suspendUser, type AdminUser } from "@/app/actions/admin";
import { Spinner } from "./ui";
import AdminBudgets from "./AdminBudgets";

const BADGE: Record<string, string> = {
  pending: "bg-[#FEF3C7] text-[#92400E]",
  active: "bg-[#DCFCE7] text-[#166534]",
  denied: "bg-[#F3F4F6] text-[#6B7280]",
  suspended: "bg-[#FEE2E2] text-[#991B1B]",
};

export default function AdminUsers() {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    const res = await listUsers();
    // Presence, not truthiness — an unreachable database reports an EMPTY
    // message, and `if (res.error)` would render "no users" for it. The action
    // already composed the sentence, so it is shown as-is rather than wrapped
    // a second time.
    setError(res.error !== undefined ? res.error : null);
    setUsers(res.users);
    setLoading(false);
  }

  useEffect(() => { void load(); }, []);

  async function act(id: string, fn: (id: string) => Promise<{ error?: string }>) {
    setBusy(id);
    const res = await fn(id);
    setError(res.error !== undefined ? res.error : null);
    setBusy(null);
    await load();
  }

  if (loading) return <Spinner label="Loading accounts" />;

  const pending = users.filter((u) => u.status === "pending");

  return (
    <div>
      <h1 className="font-display text-2xl text-ink">Accounts</h1>
      <p className="mt-1 text-sm text-ink/60">
        {pending.length > 0
          ? `${pending.length} waiting for approval`
          : "Nobody is waiting for approval"}
      </p>

      {/*
        Stated on the page itself, not just in a doc. Approving somebody today
        gives them THIS pipeline — there is no tenant_id on any table yet, so
        every account reads and writes the same rows.
      */}
      <p className="mt-4 rounded-lg border border-[#FCD34D] bg-[#FFFBEB] px-3 py-2 text-sm text-[#92400E]">
        <strong>Data is not yet separated per account.</strong> Anyone you approve
        will see and be able to edit this pipeline, watchlist and fit brain. Keep
        the waitlist closed until tenancy ships.
      </p>

      {error && (
        <p className="mt-3 rounded-lg border border-[#FCA5A5] bg-[#FEF2F2] px-3 py-2 text-sm text-[#991B1B]">
          {error}
        </p>
      )}

      <div className="mt-6 overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-slate text-left text-xs uppercase tracking-wide text-ink/50">
              <th className="py-2 pr-4">Email</th>
              <th className="py-2 pr-4">Status</th>
              <th className="py-2 pr-4">Role</th>
              <th className="py-2 pr-4">Joined</th>
              <th className="py-2">Actions</th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id} className="border-b border-slate/50 align-top">
                <td className="py-3 pr-4">
                  <div className="text-ink">{u.email}</div>
                  {u.name && <div className="text-xs text-ink/50">{u.name}</div>}
                </td>
                <td className="py-3 pr-4">
                  <span className={`rounded px-2 py-0.5 text-xs ${BADGE[u.status] ?? BADGE.denied}`}>
                    {u.status}
                  </span>
                </td>
                <td className="py-3 pr-4 text-ink/70">{u.role}</td>
                <td className="py-3 pr-4 text-ink/50">{u.created_at?.slice(0, 10)}</td>
                <td className="py-3">
                  <div className="flex flex-wrap gap-2">
                    {u.status !== "active" && (
                      <button
                        disabled={busy === u.id}
                        onClick={() => act(u.id, approveUser)}
                        className="rounded border border-slate px-2 py-1 text-xs hover:border-ink disabled:opacity-40"
                      >
                        Approve
                      </button>
                    )}
                    {u.status === "pending" && (
                      <button
                        disabled={busy === u.id}
                        onClick={() => act(u.id, denyUser)}
                        className="rounded border border-slate px-2 py-1 text-xs hover:border-ink disabled:opacity-40"
                      >
                        Deny
                      </button>
                    )}
                    {u.status === "active" && u.role !== "admin" && (
                      <button
                        disabled={busy === u.id}
                        onClick={() => act(u.id, suspendUser)}
                        className="rounded border border-slate px-2 py-1 text-xs hover:border-ink disabled:opacity-40"
                      >
                        Suspend
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <AdminBudgets />
    </div>
  );
}
