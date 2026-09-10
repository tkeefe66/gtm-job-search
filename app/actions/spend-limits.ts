"use server";

import { revalidatePath } from "next/cache";
import { requireActor } from "@/lib/require-actor";
import { rawQuery } from "@/lib/supabase";
import { describeWriteFailure } from "@/lib/write-failure";
import { readSpendLimits } from "@/lib/spend-limit-store";
import { readSpent } from "@/lib/usage-store";
import { SPEND_LIMITS_KEY, validateSpendLimits, type SpendLimits } from "@/lib/spend-limits";
import { resetsOn } from "@/lib/budget";

export interface SpendOverview extends SpendLimits {
  isAdmin: boolean;
  spentTodayCents: number;
  spentMonthCents: number;
  dailyReset: string;
  monthlyReset: string;
}

export async function getOwnSpendOverview(): Promise<{ overview?: SpendOverview; error?: string }> {
  const actor = await requireActor();
  const result = await readSpendLimits(actor.tenantId, actor.isAdmin);
  if (result.error !== undefined) return { error: result.error };
  const now = new Date();
  const daily = await readSpent(actor.tenantId, now, "daily");
  const monthly = await readSpent(actor.tenantId, now, "monthly");
  const failure = describeWriteFailure(daily.error ?? monthly.error, "load your spending");
  if (failure !== undefined) return { error: failure };
  return { overview: {
    ...result.limits, isAdmin: actor.isAdmin,
    spentTodayCents: daily.spentCents!, spentMonthCents: monthly.spentCents!,
    dailyReset: resetsOn("daily", now), monthlyReset: resetsOn("monthly", now),
  } };
}

export async function saveSpendLimits(input: SpendLimits): Promise<{ error?: string }> {
  const actor = await requireActor();
  if (actor.isAdmin) return { error: "Change admin spending limits on the Accounts page." };
  const invalid = validateSpendLimits(input);
  if (invalid !== undefined) return { error: invalid };
  // Pick only validated fields. Identity always comes from the authenticated actor.
  const limits: SpendLimits = { dailyCents: input.dailyCents, monthlyCents: input.monthlyCents };
  const { error } = await rawQuery(
    `insert into app_settings (tenant_id, key, value) values ($1, $2, $3::jsonb)
       on conflict (tenant_id, key) do update set value = excluded.value`,
    [actor.tenantId, SPEND_LIMITS_KEY, JSON.stringify(limits)], actor.tenantId
  );
  const failure = describeWriteFailure(error?.message, "save your spending limits");
  if (failure !== undefined) return { error: failure };
  console.info(`spend-limits: saved for tenant ${actor.tenantId}`);
  revalidatePath("/settings");
  revalidatePath("/admin");
  return {};
}
