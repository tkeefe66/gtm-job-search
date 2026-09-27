/** Display recorded costs without turning missing evidence or fractions into zero. */
export function formatAICost(microusd: number | null | undefined): string {
  if (microusd == null || !Number.isFinite(microusd) || microusd < 0) return "Not recorded";
  if (microusd > 0 && microusd < 10_000) return "<$0.01";
  return `$${(microusd / 1_000_000).toFixed(2)}`;
}

export function crawlOutcomeText(outcome: {
  status: string; rolesFound: number; newRoles: number; error?: string;
}): string {
  if (outcome.status === "error") return outcome.error || "Check failed. Try again or update the careers page.";
  if (outcome.status === "needs_url") return outcome.error || "No careers page found. Add one below.";
  if (outcome.status === "skipped") return outcome.error || "Check deferred. Review the source and spending settings.";
  if (outcome.status === "unchanged") return "Source unchanged. No new roles.";
  if (outcome.status === "empty") return "No matching roles right now.";
  const result = `${outcome.rolesFound} role${outcome.rolesFound === 1 ? "" : "s"} found, ${outcome.newRoles} new.`;
  if (outcome.status === "partial") return `Partial check: ${result}${outcome.error ? ` ${outcome.error}` : ""}`;
  return result;
}

interface CostSummary {
  knownCostMicrousd: number | null;
  unknownRequests: number;
  inFlightRequests: number;
  latest: {
    occurredAt: string; costMicrousd: number | null; costComplete: boolean;
    status: string | null; newRoles: number | null;
  } | null;
}

const OUTCOME_LABELS: Record<string, string> = {
  ok: "Check completed", empty: "No matching roles", error: "Check failed",
  needs_url: "Needs a careers page", skipped: "Check deferred", partial: "Partial check",
  unchanged: "Source unchanged",
};

export function companyCostDisplay(summary: CostSummary | undefined) {
  const unknown = summary?.unknownRequests ?? 0;
  const pending = summary?.inFlightRequests ?? 0;
  const latest = summary?.latest;
  const measured = (amount: number | null | undefined, incomplete: boolean) =>
    incomplete && amount == null ? "Unknown; total incomplete" :
      `${formatAICost(amount)}${incomplete ? " recorded; total incomplete" : ""}`;
  return {
    month: measured(summary?.knownCostMicrousd, unknown + pending > 0),
    latest: measured(latest?.costMicrousd, latest?.costComplete === false),
    latestResult: latest ? [
      OUTCOME_LABELS[latest.status ?? ""] ?? "Result not recorded",
      latest.newRoles === null ? null : `${latest.newRoles} new role${latest.newRoles === 1 ? "" : "s"}`,
    ].filter(Boolean).join(" · ") : null,
    uncertainty: [
      unknown ? `${unknown} request${unknown === 1 ? " has" : "s have"} unknown cost.` : null,
      pending ? `${pending} request${pending === 1 ? " is" : "s are"} still running.` : null,
    ].filter(Boolean).join(" "),
  };
}
