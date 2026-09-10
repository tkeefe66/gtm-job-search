import { rawQuery } from "@/lib/supabase";
import { describeWriteFailure } from "@/lib/write-failure";
import { SPEND_LIMITS_KEY, validateSpendLimits, type SpendLimits } from "@/lib/spend-limits";

export async function readSpendLimits(tenantId: string, isAdmin: boolean): Promise<
  { limits: SpendLimits; error?: undefined } | { limits?: undefined; error: string }
> {
  if (!isAdmin) {
    const { data, error } = await rawQuery<{ value: unknown }>(
      `select value from app_settings where tenant_id = $1 and key = $2`,
      [tenantId, SPEND_LIMITS_KEY], tenantId
    );
    const failure = describeWriteFailure(error?.message, "load your spending limits");
    if (failure !== undefined) return { error: failure };
    if (!data.length) return { limits: { dailyCents: null, monthlyCents: null } };
    if (validateSpendLimits(data[0].value) !== undefined) {
      return { error: "Your saved spending limits are invalid. Save new limits in Settings before starting more AI work." };
    }
    return { limits: data[0].value as SpendLimits };
  }

  // Admin limits continue to use the existing enforced overrides and defaults.
  const { data: users, error } = await rawQuery<{ daily_budget_cents: number | null; monthly_budget_cents: number | null }>(
    `select daily_budget_cents, monthly_budget_cents from users where id = $1`, [tenantId]
  );
  const failure = describeWriteFailure(error?.message, "load your spending limits");
  if (failure !== undefined) return { error: failure };
  if (!users.length) return { error: "Could not find this account's spending limits. Refresh and try again." };
  const { data: settings, error: defaultsError } = await rawQuery<{ key: string; value: unknown }>(
    `select key, value from platform_settings`
  );
  const defaultsFailure = describeWriteFailure(defaultsError?.message, "load spending defaults");
  if (defaultsFailure !== undefined) return { error: defaultsFailure };
  const num = (key: string, fallback: number) => {
    const value = settings.find((row) => row.key === key)?.value;
    return typeof value === "number" ? value : fallback;
  };
  const limits = {
    dailyCents: users[0].daily_budget_cents ?? num("adminDailyBudgetCents", 1000),
    monthlyCents: users[0].monthly_budget_cents ?? num("adminMonthlyBudgetCents", 10000),
  };
  const invalid = validateSpendLimits(limits);
  return invalid !== undefined ? { error: invalid } : { limits };
}
