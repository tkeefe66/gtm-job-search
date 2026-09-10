import { rawQuery, tenantTransaction } from "@/lib/supabase";
import { billingPeriod, dailyPeriod } from "@/lib/budget";

/**
 * The atomic reservation.
 *
 * The obvious implementation is wrong, and wrong in a way tests rarely catch:
 *
 *     const spent = await readSpent(tenantId);        // WRONG
 *     if (spent + estimate > ceiling) return refuse;
 *     await writeSpent(tenantId, spent + estimate);
 *
 * Server actions run concurrently, and the interleaved awaits mean N of them
 * read the same value and write the same value — the counter advances by one
 * estimate per burst rather than per request, and the ceiling is roughly as weak
 * as the concurrency is wide.
 *
 * So the ceiling lives INSIDE the statement. Zero rows returned means the
 * reservation was refused AND nothing was written, which is what removes the
 * release path: an earlier design reserved first and released on refusal, and a
 * crash between those two statements stranded the reservation permanently —
 * a tenant at their cap clicking twenty times could burn their next month
 * without a single Claude call succeeding.
 */
const RESERVE_SQL = `
  update usage_counters
     set spent_cents = spent_cents + $3, updated_at = now()
   where tenant_id = $1 and period = $2
     and ($4::integer is null or (spent_cents < $4 and spent_cents + $3 <= $4))
  returning spent_cents`;

/** Repair missing BYO counters from the recorded history before any debit. */
const SEED_SQL = `
  insert into usage_counters (tenant_id, period, spent_cents)
  select $1, $2, coalesce(sum(cost_cents), 0)::integer from usage_events
   where tenant_id = $1 and occurred_at >= $3::timestamptz and occurred_at < $4::timestamptz
  on conflict (tenant_id, period) do nothing`;

function periodBounds(now: Date, window: "daily" | "monthly"): [string, string] {
  const start = window === "daily"
    ? new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
    : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end = window === "daily"
    ? new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1))
    : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return [start.toISOString(), end.toISOString()];
}

export interface ReserveResult {
  ok: boolean;
  spentCents: number;
  reason?: "daily" | "monthly";
  /** Remaining room for this action after other requests' reservations. */
  availableCents?: number;
  /** Present (empty string included) when the database failed. Presence, not truthiness. */
  error?: string;
}

/**
 * Reserve `estimateCents` against this period's budget.
 *
 * Seed any missing counter from historical events, then apply a guarded UPDATE.
 * The guard covers first use as well as later calls. Null skips one window's cap;
 * zero refuses even a zero estimate. A refusal rolls back both windows.
 */
export async function reserveSpend(input: {
  tenantId: string;
  estimateCents: number;
  dailyCeilingCents: number | null;
  monthlyCeilingCents: number | null;
  now: Date;
}): Promise<ReserveResult> {
  try {
    return await tenantTransaction(input.tenantId, async (q) => {
      // BOTH windows in ONE transaction. Reserving them separately could commit
      // the daily debit and then fail the monthly one, charging a tenant for a
      // call that never ran — or, in the other order, let a burst through.
      const windows = [
        { reason: "daily", period: dailyPeriod(input.now), ceiling: input.dailyCeilingCents },
        { reason: "monthly", period: billingPeriod(input.now), ceiling: input.monthlyCeilingCents },
      ] as const;
      let availableCents = Infinity;
      for (const w of windows) {
        await q(SEED_SQL, [input.tenantId, w.period, ...periodBounds(input.now, w.reason)]);
        const r = await q(RESERVE_SQL, [
          input.tenantId,
          w.period,
          input.estimateCents,
          w.ceiling,
        ]);
        // Zero rows means the ceiling guard refused. Throwing rolls back
        // whichever window was already debited in this transaction.
        if (r.rows.length === 0) throw new BudgetRefused(w.reason);
        if (w.ceiling !== null) availableCents = Math.min(availableCents, w.ceiling - Number(r.rows[0].spent_cents) + input.estimateCents);
      }
      return { ok: true, spentCents: input.estimateCents, availableCents };
    });
  } catch (e) {
    if (e instanceof BudgetRefused) return { ok: false, spentCents: 0, reason: e.reason };
    return {
      ok: false,
      spentCents: 0,
      // Verbatim, empty message included — presence is what callers branch on.
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

/** Not an error condition — a refusal. Carried as a throw only so the
 *  transaction above rolls back the window it already debited. */
class BudgetRefused extends Error {
  constructor(readonly reason: "daily" | "monthly") { super(`Spending ${reason} limit reached`); }
}

/** Publish completed response spend above an action's reservation, without an event yet. */
export async function advanceSpend(input: { tenantId: string; deltaCents: number; now: Date }): Promise<{ error?: string }> {
  try {
    await tenantTransaction(input.tenantId, async (q) => {
      for (const window of ["daily", "monthly"] as const) {
        const period = window === "daily" ? dailyPeriod(input.now) : billingPeriod(input.now);
        await q(SEED_SQL, [input.tenantId, period, ...periodBounds(input.now, window)]);
        await q(`update usage_counters set spent_cents = spent_cents + $3, updated_at = now()
                   where tenant_id = $1 and period = $2`, [input.tenantId, period, input.deltaCents]);
      }
    });
    return {};
  } catch (e) { return { error: e instanceof Error ? e.message : String(e) }; }
}

/**
 * Reconcile an estimate against what a call actually cost, and record the event.
 *
 * `searches` is passed explicitly rather than derived from tokens. web_search
 * calls are billed per search and are NOT part of the usage token counts
 * (lib/providers/types.ts says so outright), so a cost reconstructed from tokens alone
 * understates every search-tier call — which is most of this app's spend.
 *
 * The delta may be NEGATIVE when a call came in under its estimate; the counter
 * is allowed to go down here, because refusing to would ratchet every tenant's
 * spend upward on every over-estimate.
 */
export async function reconcileSpend(input: {
  tenantId: string;
  estimateCents: number;
  actualCents: number;
  action: string;
  searches: number;
  inputTokens: number;
  outputTokens: number;
  billedTo: "platform" | "tenant";
  now: Date;
}): Promise<{ error?: string }> {
  const delta = input.actualCents - input.estimateCents;

  try {
    await tenantTransaction(input.tenantId, async (q) => {
      // Counters and event commit together. Seed historical BYO usage on first use.
      for (const window of ["daily", "monthly"] as const) {
        const period = window === "daily" ? dailyPeriod(input.now) : billingPeriod(input.now);
        await q(SEED_SQL, [input.tenantId, period, ...periodBounds(input.now, window)]);
        await q(
        `update usage_counters
            set spent_cents = greatest(0, spent_cents + $3), updated_at = now()
          where tenant_id = $1 and period = $2`,
        [input.tenantId, period, delta]
      );
      }

      await q(
    `insert into usage_events
       (tenant_id, action, searches, input_tokens, output_tokens, cost_cents, billed_to, occurred_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      input.tenantId,
      input.action,
      input.searches,
      input.inputTokens,
      input.outputTokens,
      input.actualCents,
      input.billedTo,
      input.now.toISOString(),
    ]
  );
    });
    return {};
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

/** This period's spend, or null when the read failed — never a drained zero. */
export async function readSpent(
  tenantId: string,
  now: Date,
  window: "daily" | "monthly" = "monthly"
): Promise<{ spentCents: number | null; error?: string }> {
  const { data, error } = await rawQuery<{ spent_cents: number }>(
    `select coalesce(
       (select spent_cents from usage_counters where tenant_id = $1 and period = $2),
       (select sum(cost_cents) from usage_events where tenant_id = $1
          and occurred_at >= $3::timestamptz and occurred_at < $4::timestamptz), 0
     )::integer as spent_cents`,
    [tenantId, window === "daily" ? dailyPeriod(now) : billingPeriod(now), ...periodBounds(now, window)],
    tenantId
  );
  // A failed read must NOT read as 0 — that would unlock a spent budget, which
  // is the same class of bug as a failed count unlocking a delete guard.
  if (error) return { spentCents: null, error: error.message };
  return { spentCents: data[0]?.spent_cents ?? 0 };
}
