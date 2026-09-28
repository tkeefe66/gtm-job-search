/** Display recorded costs without turning missing evidence or fractions into zero. */
export function formatAICost(microusd: number | null | undefined): string {
  if (microusd == null || !Number.isFinite(microusd) || microusd < 0) return "Not recorded";
  if (microusd > 0 && microusd < 10_000) return "<$0.01";
  return `$${(microusd / 1_000_000).toFixed(2)}`;
}

interface CrawlIssue {
  label: string;
  explanation: string;
  nextStep: string;
}

/** Recognize recorded provider/model errors, including rows saved before errors were sanitized. */
function knownCrawlIssue(error: string | null | undefined): CrawlIssue | null {
  const message = error ?? "";
  // crawlCompany can append a failed database write to the original AI error.
  // Summarize the original cause while retaining the warning that the row is stale.
  const saveFailure = message.indexOf(" (also failed to record the crawl on the watchlist:");
  if (saveFailure >= 0) {
    const cause = knownCrawlIssue(message.slice(0, saveFailure));
    return cause ? { ...cause, explanation: `${cause.explanation}${message.slice(saveFailure)}` } : null;
  }
  const lowCredits = /credit balance is too low/i.test(message);
  if (lowCredits || /^(Anthropic|OpenAI|Google): billing allowance exhausted\./.test(message)) {
    return {
      label: lowCredits ? "API credits too low" : "API billing blocked",
      explanation: lowCredits
        ? "At the last attempt, the AI provider refused the request because API credits were too low. This does not tell us whether the company has a job board."
        : "At the last attempt, the AI provider refused the request because its billing allowance was exhausted. This does not tell us whether the company has a job board.",
      nextStep: "Review credits and billing limits with your AI provider before retrying AI work.",
    };
  }
  if (message === "The AI did not finish a usable answer. Please retry." ||
      message === "The search produced too much data to finish. Please retry.") {
    return {
      label: "AI response incomplete",
      explanation: "The AI did not return a complete, usable answer on the last attempt. This does not tell us whether the company has a job board.",
      nextStep: "Use Check now to retry the direct source. If that cannot read the listings, review the careers link or choose Deep search, which uses paid AI search.",
    };
  }
  return null;
}

/** A status establishes failure; missing or empty error text must never hide it. */
export function crawlIssueDisplay(status: string | null | undefined, error: string | null | undefined): CrawlIssue | null {
  if (status === "needs_url") return {
    label: "Needs a careers URL",
    explanation: "The last check could not find a usable careers URL. The company may still have a job board.",
    nextStep: "Add or correct the careers URL below, then choose Save and check.",
  };
  if (!["error", "partial", "skipped"].includes(status ?? "")) return null;
  const known = knownCrawlIssue(error);
  if (known) return { ...known, label: status === "partial" ? `Partial · ${known.label}` : known.label };
  return {
    label: status === "partial" ? "Partial check" : status === "skipped" ? "Check deferred" : "Check failed",
    explanation: error?.trim() || "No reason was recorded for the last unsuccessful check. This does not tell us whether the company has a job board.",
    nextStep: status === "error"
      ? "Review the careers link, then use Check now to retry the direct source."
      : "Review the recorded reason and the source or spending settings before retrying.",
  };
}

export function crawlOutcomeText(outcome: {
  status: string; rolesFound: number; newRoles: number; error?: string;
}): string {
  const known = knownCrawlIssue(outcome.error);
  const error = known ? `${known.explanation} ${known.nextStep}` : outcome.error;
  if (outcome.status === "error") return error || "Check failed. Try again or update the careers page.";
  if (outcome.status === "needs_url") return outcome.error || "No careers page found. Add one below.";
  if (outcome.status === "skipped") return error || "Check deferred. Review the source and spending settings.";
  if (outcome.status === "unchanged") return "Source unchanged. No new roles.";
  if (outcome.status === "empty") return "No matching roles right now.";
  const result = `${outcome.rolesFound} role${outcome.rolesFound === 1 ? "" : "s"} found, ${outcome.newRoles} new.`;
  if (outcome.status === "partial") return `Partial check: ${result}${error ? ` ${error}` : ""}`;
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
