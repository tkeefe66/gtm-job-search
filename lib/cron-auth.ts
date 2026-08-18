import { createHash, timingSafeEqual } from "node:crypto";

/**
 * The bearer check both cron routes share.
 *
 * Extracted from app/api/cron/crawl/route.ts unchanged when a second cron route
 * arrived. It is deliberately shared rather than copied: this is the only thing
 * standing between a public URL and a job that spends a tenant's Anthropic
 * credits, and two copies of an auth check are two chances to fix one of them.
 *
 * Hashes both sides to fixed-width digests before comparing. That removes length
 * as an observable side channel — timingSafeEqual would otherwise need an
 * explicit length-equality check, and a length mismatch on the raw values throws
 * — and keeps the comparison genuinely constant-time whatever the caller sent.
 *
 * FAILS CLOSED: an unset or empty CRON_SECRET rejects everyone. A deploy that
 * forgot the variable must break the crawler loudly, not open the route.
 */
export function cronAuthorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const header = req.headers.get("authorization") ?? "";
  const provided =
    header.slice(0, 7).toLowerCase() === "bearer " ? header.slice(7) : "";
  const a = createHash("sha256").update(provided).digest();
  const b = createHash("sha256").update(secret).digest();
  return timingSafeEqual(a, b);
}
