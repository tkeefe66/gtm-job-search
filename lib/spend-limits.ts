/** User-selected app limits, in cents. Null means that window has no app cap. */
export interface SpendLimits {
  dailyCents: number | null;
  monthlyCents: number | null;
}

export const SPEND_LIMITS_KEY = "spend_limits";
export const MAX_SPEND_CENTS = 100_000_000;

export function validateSpendLimits(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "Enter daily and monthly limits.";
  const limits = value as SpendLimits;
  for (const cents of [limits.dailyCents, limits.monthlyCents]) {
    if (cents !== null && (typeof cents !== "number" || !Number.isSafeInteger(cents) || cents < 0 || cents > MAX_SPEND_CENTS)) {
      return "Limits must be between $0 and $1,000,000, with no more than two decimal places. Leave a field blank for no limit.";
    }
  }
  if (limits.dailyCents !== null && limits.monthlyCents !== null && limits.dailyCents > limits.monthlyCents) {
    return "The daily limit cannot exceed the monthly limit.";
  }
}

export function hasSpendLimit(limits: SpendLimits): boolean {
  return limits.dailyCents !== null || limits.monthlyCents !== null;
}

/** Parse dollars without allowing blank input to silently become a zero cap. */
export function parseSpendDollars(value: string): number | null | undefined {
  const text = value.trim();
  if (text === "") return null;
  if (!/^\d+(?:\.\d{1,2})?$/.test(text)) return undefined;
  const cents = Math.round(Number(text) * 100);
  return Number.isSafeInteger(cents) && cents <= MAX_SPEND_CENTS ? cents : undefined;
}
