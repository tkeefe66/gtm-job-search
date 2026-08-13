import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { crawlCompany, type CrawlOutcome } from "@/lib/crawler";
import { DEFAULT_BATCH_LIMIT, DUE_COMPANIES_SQL } from "@/lib/crawl-schedule";
import { rawQuery } from "@/lib/supabase";

export const dynamic = "force-dynamic";

// This is the only API route in the app. It both mutates the database and
// spends Anthropic credits, and the app has no auth, so the shared secret is
// the only thing standing between a public URL and unbounded spend.
function authorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const header = req.headers.get("authorization") ?? "";
  const provided = header.startsWith("Bearer ") ? header.slice(7) : "";
  const a = Buffer.from(provided);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function GET(req: Request) {
  if (!authorized(req)) {
    return new NextResponse(null, { status: 401 });
  }

  const url = new URL(req.url);
  const dryRun = url.searchParams.get("dry") === "1";
  const limit = Number(url.searchParams.get("limit")) || DEFAULT_BATCH_LIMIT;

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

  return NextResponse.json({
    dryRun,
    crawled: results.length,
    totals: {
      newRoles: results.reduce((n, r) => n + r.newRoles, 0),
      failed: results.filter((r) => r.status === "error").length,
    },
    results,
  });
}
