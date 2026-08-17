/**
 * How many companies one tenant may keep under nightly crawling.
 *
 * NOT primarily a cost control. The nightly batch is 3 sequential crawls at
 * 60-120s each — about 21 company-crawls a week for the WHOLE platform — and
 * splitCrawlBatch divides that between tenants. So a tenant tracking 200
 * companies does not mainly spend money; they consume a shared, fixed capacity
 * and push everyone else's companies further apart in time.
 *
 * That distinction matters because it survives the free tier going away. Even if
 * every tenant pays for their own model calls, the crawl batch is still one
 * queue, and one tenant can still starve it.
 */

export interface QuotaVerdict {
  allow: boolean;
  /** Present when refused — a sentence for the user, not a code. */
  reason?: string;
}

export function crawlQuotaVerdict(input: {
  tracked: number;
  quota: number;
  isAdmin: boolean;
}): QuotaVerdict {
  // The admin is exempt from the COUNT but not from the consequence: their
  // companies still come out of the same nightly batch. Exempt because the
  // owner should be able to see what a large watchlist does to the schedule
  // rather than be stopped from creating one.
  if (input.isAdmin) return { allow: true };

  if (input.tracked >= input.quota) {
    return {
      allow: false,
      reason:
        `You're tracking ${input.tracked} companies, which is the limit for your account. ` +
        `Untrack one to add another — the nightly crawl is shared, so every tracked ` +
        `company makes the others less frequent.`,
    };
  }
  return { allow: true };
}
