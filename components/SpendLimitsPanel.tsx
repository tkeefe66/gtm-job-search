"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { getOwnSpendOverview, saveSpendLimits, type SpendOverview } from "@/app/actions/spend-limits";
import { parseSpendDollars, validateSpendLimits } from "@/lib/spend-limits";

const dollars = (cents: number) => `$${(cents / 100).toFixed(2)}`;
const draftDollars = (cents: number | null) => cents === null ? "" : (cents / 100).toFixed(2);

export default function SpendLimitsPanel({ isAdmin, provider }: { isAdmin: boolean; provider?: string }) {
  const [overview, setOverview] = useState<SpendOverview | null>(null);
  const [draft, setDraft] = useState({ daily: "", monthly: "" });
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const result = await getOwnSpendOverview();
      if (result.error !== undefined) { setError(result.error); return; }
      if (!result.overview) { setError("Could not load your spending. Refresh and try again."); return; }
      setOverview(result.overview);
      setDraft({ daily: draftDollars(result.overview.dailyCents), monthly: draftDollars(result.overview.monthlyCents) });
    } catch {
      setError("Could not load your spending. Check your connection and try again.");
    } finally { setLoading(false); }
  }

  useEffect(() => { void load(); }, []);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setNotice(null);
    const dailyCents = parseSpendDollars(draft.daily);
    const monthlyCents = parseSpendDollars(draft.monthly);
    if (dailyCents === undefined || monthlyCents === undefined) {
      setError("Enter a dollar amount with up to two decimal places, or leave the field blank for no limit.");
      return;
    }
    const limits = { dailyCents, monthlyCents };
    const invalid = validateSpendLimits(limits);
    if (invalid !== undefined) { setError(invalid); return; }
    setBusy(true);
    try {
      const result = await saveSpendLimits(limits);
      if (result.error !== undefined) { setError(result.error); return; }
      setNotice("Spending limits saved. They apply to new AI work immediately.");
      await load();
    } catch {
      setError("Could not confirm your spending limits were saved. Reload to check before trying again.");
    } finally { setBusy(false); }
  }

  return (
    <section className="mt-4 rounded-xl border border-slate bg-white p-5" aria-labelledby="spend-limits-heading">
      <h2 id="spend-limits-heading" className="font-display text-lg text-ink">Spending limits</h2>
      <p className="mt-1 text-sm text-ink/60">
        Control AI spending through this app, including searches, résumé work, and scheduled checks.
        Your provider’s own limits are separate.
      </p>

      {loading && <p className="mt-4 text-sm text-ink/60" role="status">Loading spending…</p>}
      {!loading && overview && (
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          {([
            { label: "Today", spent: overview.spentTodayCents, limit: overview.dailyCents, reset: overview.dailyReset },
            { label: "This month", spent: overview.spentMonthCents, limit: overview.monthlyCents, reset: overview.monthlyReset },
          ]).map((window) => (
            <div key={window.label} className="rounded-lg bg-paper p-3">
              <p className="text-xs text-ink/60">{window.label}</p>
              <p className="mt-1 text-lg tabular-nums text-ink">
                {dollars(window.spent)} <span className="text-sm text-ink/50">/ {window.limit === null ? "No app limit" : dollars(window.limit)}</span>
              </p>
              <p className="mt-1 text-xs text-ink/50">Resets {window.reset} at 00:00 UTC</p>
              {window.limit !== null && window.spent >= window.limit && <p className="mt-1 text-xs text-[#B42318]">Limit reached. New AI work is paused.</p>}
            </div>
          ))}
        </div>
      )}

      {error !== null && <div className="mt-3 text-sm text-[#B42318]" role="alert">
        <p>{error}</p>
        {!overview && !loading && <p className="mt-1">Existing values could not be loaded. Retry, or enter both fields below to replace your app limits.</p>}
        <button type="button" onClick={() => void load()} disabled={busy || loading} className="mt-1 underline">Reload spending</button>
      </div>}
      {notice && <p className="mt-3 text-sm text-[#166534]" role="status">{notice}</p>}

      {isAdmin ? <Link href="/admin" className="mt-4 inline-block text-sm underline">Change limits on Accounts</Link> : (
        <form onSubmit={save} className="mt-4">
          <fieldset disabled={busy || loading} className="grid gap-3 sm:grid-cols-2 disabled:opacity-60">
            <label className="text-sm text-ink" htmlFor="daily-spend-limit">Daily limit (USD)
              <input id="daily-spend-limit" inputMode="decimal" placeholder="Not set" value={draft.daily}
                onChange={(e) => { setDraft((value) => ({ ...value, daily: e.target.value })); setNotice(null); }}
                aria-describedby="spend-limits-help" className="mt-1 block w-full rounded-lg border border-slate px-3 py-2" />
            </label>
            <label className="text-sm text-ink" htmlFor="monthly-spend-limit">Monthly limit (USD)
              <input id="monthly-spend-limit" inputMode="decimal" placeholder="Not set" value={draft.monthly}
                onChange={(e) => { setDraft((value) => ({ ...value, monthly: e.target.value })); setNotice(null); }}
                aria-describedby="spend-limits-help" className="mt-1 block w-full rounded-lg border border-slate px-3 py-2" />
            </label>
          </fieldset>
          <p id="spend-limits-help" className="mt-2 text-xs text-ink/60">Leave either field blank for no limit. Enter 0 to pause AI work. Raising a limit does not reset your spending.</p>
          {provider === "google" && <p className="mt-2 text-sm text-[#B54708]">Gemini cannot enforce a search cap. With an app limit set, searches will be paused; choose Anthropic or OpenAI to run capped searches.</p>}
          <button type="submit" disabled={busy || loading} className="mt-3 rounded-lg bg-ink px-4 py-2 text-sm text-white disabled:opacity-50">
            {busy ? "Saving…" : "Save spending limits"}
          </button>
        </form>
      )}
      <p className="mt-3 text-xs text-ink/50">Spending is estimated from recorded API usage and may include work in progress. Requests already running can finish and take spending above a limit. Work that spans midnight counts toward the day it began. API key verification and usage outside this app are not included.</p>
    </section>
  );
}
