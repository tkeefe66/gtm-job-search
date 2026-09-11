import { safeHttp } from "./safe-http";
// The plain-HTTP tier's transport: fetching a page, and the robots.txt gate in
// front of it.
//
// Extracted from lib/crawler.ts so the enrich backfill (app/actions/enrich.ts)
// reads a single posting through the SAME gate the crawler reads a careers page
// through. Two copies of the robots rule would be a policy regression rather
// than a bug — silent, and only visible to the site being fetched — so
// fetchPage and fetchAllowed travel together and neither is exported without
// the other.

import { isDisallowed, robotsUrlFor } from "@/lib/robots";

const FETCH_TIMEOUT_MS = 10_000;
const USER_AGENT =
  "GTMJobSearchBot/1.0 (personal job-search tool; contact tkeefe66@gmail.com)";

/** Fetches a page's HTML, or null for any non-2xx, timeout or network error. */
export async function fetchPage(url: string): Promise<string | null> {
  try {
    const res = await safeHttp(url, {
      timeoutMs: FETCH_TIMEOUT_MS,
      headers: { "User-Agent": USER_AGENT },
    });
    if (!res.ok) {
      console.warn(`fetchPage: fetch of ${url} returned ${res.status}`);
      return null;
    }
    return await res.text();
  } catch (err) {
    console.warn(
      `fetchPage: fetch of ${url} failed — ${err instanceof Error ? err.message : String(err)}`
    );
    return null;
  }
}

// Three-way outcome of fetching robots.txt itself, kept distinct from what
// fetchPage returns (which flattens "absent" and "errored" to the same
// null). A 404/410 means the site simply doesn't publish one — that's a
// normal, well-formed "allowed" signal. A network error, timeout, or 5xx
// means we could not read the rules at all, which is not the same thing and
// must not be treated as permission.
type RobotsFetch =
  | { kind: "ok"; body: string }
  | { kind: "absent" }
  | { kind: "error" };

async function fetchRobotsTxt(url: string): Promise<RobotsFetch> {
  try {
    const res = await safeHttp(url, {
      timeoutMs: FETCH_TIMEOUT_MS,
      maxBytes: 256 * 1024,
      headers: { "User-Agent": USER_AGENT },
    });
    if (res.status === 404 || res.status === 410) {
      return { kind: "absent" };
    }
    if (!res.ok) {
      console.warn(`robots: robots.txt fetch of ${url} returned ${res.status}`);
      return { kind: "error" };
    }
    return { kind: "ok", body: await res.text() };
  } catch (err) {
    console.warn(
      `robots: robots.txt fetch of ${url} failed — ${err instanceof Error ? err.message : String(err)}`
    );
    return { kind: "error" };
  }
}

/**
 * Whether robots.txt permits fetching this URL.
 *
 * A robots.txt that could not be READ is not permission — see RobotsFetch.
 * Callers must gate on this BEFORE fetchPage, never after.
 */
export async function fetchAllowed(url: string): Promise<boolean> {
  const result = await fetchRobotsTxt(robotsUrlFor(url));
  if (result.kind === "absent") return true; // no robots.txt served — allowed
  if (result.kind === "error") return false; // could not read the rules — don't guess
  return !isDisallowed(result.body, new URL(url).pathname);
}
