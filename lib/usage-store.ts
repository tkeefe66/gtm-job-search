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
  insert into usage_counters (tenant_id, period, spent_cents)
  values ($1, $2, $3)
  on conflict (tenant_id, period) do update
     set spent_cents = usage_counters.spent_cents + $3,
         updated_at = now()
   where usage_counters.spent_cents + $3 <= $4
  returning spent_cents`;

export interface ReserveResult {
  ok: boolean;
  spentCents: number;
  /** Present (empty string included) when the database failed. Presence, not truthiness. */
  error?: string;
}

/**
 * Reserve `estimateCents` against this period's budget.
 *
 * The caller must already have checked `estimateCents <= ceilingCents`
 * (reserveVerdict does): the ON CONFLICT guard covers the UPDATE branch only, so
 * a first-of-the-month call larger than the whole ceiling would otherwise insert
 * unchecked.
 */
export async function reserveSpend(input: {
  tenantId: string;
  estimateCents: number;
  dailyCeilingCents: number;
  monthlyCeilingCents: number;
  now: Date;
}): Promise<ReserveResult> {
  try {
    return await tenantTransaction(input.tenantId, async (q) => {
      // BOTH windows in ONE transaction. Reserving them separately could commit
      // the daily debit and then fail the monthly one, charging a tenant for a
      // call that never ran — or, in the other order, let a burst through.
      const windows = [
        { period: dailyPeriod(input.now), ceiling: input.dailyCeilingCents },
        { period: billingPeriod(input.now), ceiling: input.monthlyCeilingCents },
      ];
      for (const w of windows) {
        const r = await q(RESERVE_SQL, [
          input.tenantId,
          w.period,
          input.estimateCents,
          w.ceiling,
        ]);
        // Zero rows means the ceiling guard refused. Throwing rolls back
        // whichever window was already debited in this transaction.
        if (r.rows.length === 0) throw new BudgetRefused();
      }
      return { ok: true, spentCents: input.estimateCents };
    });
  } catch (e) {
    if (e instanceof BudgetRefused) return { ok: false, spentCents: 0 };
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
class BudgetRefused extends Error {}

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

  if (delta !== 0) {
    // Both windows, or they drift apart: the daily counter would carry the
    // estimate forever while the monthly one carried the truth.
    for (const period of [dailyPeriod(input.now), billingPeriod(input.now)]) {
      const { error } = await rawQuery(
        `update usage_counters
            set spent_cents = greatest(0, spent_cents + $3), updated_at = now()
          where tenant_id = $1 and period = $2`,
        [input.tenantId, period, delta],
        input.tenantId
      );
      if (error) return { error: error.message };
    }
  }

  const { error } = await rawQuery(
    `insert into usage_events
       (tenant_id, action, searches, input_tokens, output_tokens, cost_cents, billed_to)
     values ($1, $2, $3, $4, $5, $6, $7)`,
    [
      input.tenantId,
      input.action,
      input.searches,
      input.inputTokens,
      input.outputTokens,
      input.actualCents,
      input.billedTo,
    ],
    input.tenantId
  );
  return { error: error?.message };
}

/** This period's spend, or null when the read failed — never a drained zero. */
export async function readSpent(
  tenantId: string,
  now: Date,
  window: "daily" | "monthly" = "monthly"
): Promise<{ spentCents: number | null; error?: string }> {
  const { data, error } = await rawQuery<{ spent_cents: number }>(
    `select spent_cents from usage_counters where tenant_id = $1 and period = $2`,
    [tenantId, window === "daily" ? dailyPeriod(now) : billingPeriod(now)],
    tenantId
  );
  // A failed read must NOT read as 0 — that would unlock a spent budget, which
  // is the same class of bug as a failed count unlocking a delete guard.
  if (error) return { spentCents: null, error: error.message };
  return { spentCents: data[0]?.spent_cents ?? 0 };
}
