const TIMEOUT_MS = 6000;
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

export type UrlStatus = "live" | "dead" | "unknown";

/**
 * Checks whether a job posting URL still resolves. Conservative by design:
 * only a definitive 404/410 counts as "dead". Everything else (auth walls,
 * bot blocks, rate limits, timeouts, network errors) is "unknown" so we
 * never mark a real posting closed on an ambiguous signal.
 */
export async function checkJobUrl(url: string): Promise<UrlStatus> {
  if (!url) return "unknown";

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "unknown";
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return "unknown";
  }

  try {
    let res = await fetchWithTimeout(url, "HEAD");
    if (res.status === 405 || res.status === 501) {
      res = await fetchWithTimeout(url, "GET");
    }

    if (res.status === 404 || res.status === 410) {
      console.warn(`Job URL dead (${res.status}): ${url}`);
      return "dead";
    }
    if (res.status >= 200 && res.status < 400) {
      return "live";
    }
    return "unknown";
  } catch (err) {
    console.warn(
      `Job URL check failed: ${url} — ${err instanceof Error ? err.message : String(err)}`
    );
    return "unknown";
  }
}

async function fetchWithTimeout(url: string, method: "HEAD" | "GET") {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, {
      method,
      redirect: "follow",
      signal: controller.signal,
      headers: { "User-Agent": USER_AGENT },
    });
  } finally {
    clearTimeout(timeout);
  }
}
