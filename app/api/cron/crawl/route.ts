import { createHash, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { crawlCompany, type CrawlOutcome } from "@/lib/crawler";
import { DEFAULT_BATCH_LIMIT, DUE_COMPANIES_SQL } from "@/lib/crawl-schedule";
import { rawQuery } from "@/lib/supabase";

// Ceiling on caller-supplied `?limit=`. Without one, `?limit=100000` (or a
// typo in the cron command) selects every due company and crawls them all
// sequentially in one request — blowing past any HTTP timeout and burning an
// unbounded number of Claude calls. `DEFAULT_BATCH_LIMIT` is "the lever" for
// normal operation; this is the backstop for when that lever is turned too
// far.
const MAX_BATCH_LIMIT = 50;

export const dynamic = "force-dynamic";

// This is the only API route in the app. It both mutates the database and
// spends Anthropic credits, and the app has no auth, so the shared secret is
// the only thing standing between a public URL and unbounded spend.
function authorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const header = req.headers.get("authorization") ?? "";
  const provided =
    header.slice(0, 7).toLowerCase() === "bearer " ? header.slice(7) : "";
  // Hash both sides to fixed-width digests before comparing: this removes
  // the length as an observable side channel (timingSafeEqual would
  // otherwise require an explicit length-equality check, and a length
  // mismatch on the raw values would throw) and keeps the comparison itself
  // genuinely constant-time regardless of what the caller sent.
  const a = createHash("sha256").update(provided).digest();
  const b = createHash("sha256").update(secret).digest();
  return timingSafeEqual(a, b);
}

export async function GET(req: Request) {
  if (!authorized(req)) {
    return new NextResponse(null, { status: 401 });
  }

  const url = new URL(req.url);
  // Any presence of `dry` means dry-run unless explicitly disabled — a flag
  // whose whole purpose is safety must fail toward *not* writing when the
  // caller's spelling is unrecognized (`?dry=true`, `?dry=yes`, bare `?dry`),
  // not silently perform a real, credit-spending, database-writing run.
  const dryParam = url.searchParams.get("dry");
  const dryRun = dryParam !== null && dryParam !== "0" && dryParam !== "false";
  const rawLimit = Math.floor(Number(url.searchParams.get("limit")));
  const limit =
    Number.isFinite(rawLimit) && rawLimit > 0
      ? Math.min(rawLimit, MAX_BATCH_LIMIT)
      : DEFAULT_BATCH_LIMIT;

  const { data, error } = await rawQuery<{ company: string }>(
    DUE_COMPANIES_SQL,
    [limit]
  );
  if (error) {
    console.error(`cron/crawl: could not select due companies — ${error.message}`);
    return NextResponse.json(
      { error: `Could not select due companies: ${error.message}` },
      { status: 500 }
    );
  }

  const due = (data ?? []).map((r) => r.company);
  const results: CrawlOutcome[] = [];

  // Sequential on purpose: keeps the request inside normal HTTP timeouts and
  // avoids bursting the Anthropic API. One company failing never aborts the
  // batch.
  for (const company of due) {
    try {
      results.push(await crawlCompany(company, { dryRun }));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`cron/crawl: ${company} threw — ${message}`);
      results.push({
        company,
        method: null,
        rolesFound: 0,
        newRoles: 0,
        status: "error",
        error: message,
      });
    }
  }

  const totals = {
    newRoles: results.reduce((n, r) => n + r.newRoles, 0),
    failed: results.filter((r) => r.status === "error").length,
  };

  // The response body lands in the `crawler` service's curl output, not the
  // `web` service's logs — and vanishes entirely if that output is
  // redirected. This is the only durable record of a successful run in the
  // logs a human actually checks.
  console.log(
    `cron/crawl: dryRun=${dryRun} crawled=${results.length} newRoles=${totals.newRoles} failed=${totals.failed}`
  );

  return NextResponse.json({
    dryRun,
    crawled: results.length,
    totals,
    results,
  });
}
