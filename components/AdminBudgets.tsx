"use client";

import { useEffect, useState } from "react";
import { getBudgetOverview, setBudget, type TenantBudget } from "@/app/actions/admin";
import { Spinner } from "./ui";

const dollars = (cents: number) => `$${(cents / 100).toFixed(2)}`;

/** A spend bar. Amber past 75%, red at the ceiling — the point is to see it coming. */
function Meter({ spent, ceiling }: { spent: number; ceiling: number }) {
  const pct = ceiling > 0 ? Math.min(100, (spent / ceiling) * 100) : 0;
  const tone = pct >= 100 ? "bg-[#B42318]" : pct >= 75 ? "bg-[#B54708]" : "bg-ink/60";
  return (
    <div className="min-w-[120px]">
      <div className="flex justify-between text-xs text-ink/60">
        <span>{dollars(spent)}</span>
        <span>{dollars(ceiling)}</span>
      </div>
      <div className="mt-1 h-1.5 w-full rounded-full bg-slate">
        <div className={`h-1.5 rounded-full ${tone}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

export default function AdminBudgets() {
  const [rows, setRows] = useState<TenantBudget[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState({ daily: "", monthly: "" });
  const [busy, setBusy] = useState(false);

  async function load() {
    setLoading(true);
    const res = await getBudgetOverview();
    // Presence, not truthiness — an unreachable database reports an empty
    // message, and `if (res.error)` would render "no tenants" for it.
    setError(res.error !== undefined ? res.error : null);
    setRows(res.tenants);
    setLoading(false);
  }
  useEffect(() => { void load(); }, []);

  async function save(id: string) {
    setBusy(true);
    const res = await setBudget(id, Math.round(Number(draft.daily) * 100), Math.round(Number(draft.monthly) * 100));
    setError(res.error !== undefined ? res.error : null);
    setBusy(false);
    if (res.error === undefined) { setEditing(null); await load(); }
  }

  if (loading) return <Spinner label="Loading budgets" />;

  return (
    <div className="mt-10">
      <h2 className="font-display text-xl text-ink">Spend</h2>
      <p className="mt-1 text-sm text-ink/60">
        Daily contains a runaway; monthly is the outer bound. Raising your own
        limit takes effect immediately — a loop cannot press this button, which is
        why the cap can be hard without locking you out.
      </p>

      {error && (
        <p className="mt-3 rounded-lg border border-[#FCA5A5] bg-[#FEF2F2] px-3 py-2 text-sm text-[#991B1B]">
          {error}
        </p>
      )}

      <div className="mt-4 overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-slate text-left text-xs uppercase tracking-wide text-ink/50">
              <th className="py-2 pr-4">Account</th>
              <th className="py-2 pr-4">Today</th>
              <th className="py-2 pr-4">This month</th>
              <th className="py-2">Limits</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((t) => (
              <tr key={t.id} className="border-b border-slate/50 align-top">
                <td className="py-3 pr-4">
                  <div className="text-ink">{t.email}</div>
                  <div className="text-xs text-ink/50">
                    {t.role === "admin" ? "admin" : t.hasOwnKey ? "own API key — not metered" : "free"}
                  </div>
                </td>
                <td className="py-3 pr-4"><Meter spent={t.spentTodayCents} ceiling={t.dailyCents} /></td>
                <td className="py-3 pr-4"><Meter spent={t.spentMonthCents} ceiling={t.monthlyCents} /></td>
                <td className="py-3">
                  {editing === t.id ? (
                    <div className="flex flex-wrap items-center gap-2">
                      <label className="text-xs text-ink/60">
                        daily $
                        <input
                          value={draft.daily}
                          onChange={(e) => setDraft((d) => ({ ...d, daily: e.target.value }))}
                          className="ml-1 w-16 rounded border border-slate px-1 py-0.5"
                        />
                      </label>
                      <label className="text-xs text-ink/60">
                        monthly $
                        <input
                          value={draft.monthly}
                          onChange={(e) => setDraft((d) => ({ ...d, monthly: e.target.value }))}
                          className="ml-1 w-20 rounded border border-slate px-1 py-0.5"
                        />
                      </label>
                      <button
                        disabled={busy}
                        onClick={() => save(t.id)}
                        className="rounded bg-ink px-2 py-1 text-xs text-white disabled:opacity-40"
                      >
                        Save
                      </button>
                      <button onClick={() => setEditing(null)} className="text-xs text-ink/50">
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <button
                      onClick={() => {
                        setEditing(t.id);
                        setDraft({
                          daily: (t.dailyCents / 100).toFixed(2),
                          monthly: (t.monthlyCents / 100).toFixed(2),
                        });
                      }}
                      className="rounded border border-slate px-2 py-1 text-xs hover:border-ink"
                    >
                      Change
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
