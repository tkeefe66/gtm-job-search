// Minimal robots.txt support for the careers-page fetch tier. Reads only the
// wildcard (User-agent: *) group, which is all this crawler needs — it makes
// one request per company per week and identifies itself honestly.
//
// Erring toward "disallowed" is safe: the crawler falls back to the
// web_search tier, which reads publicly indexed pages instead.

export function robotsUrlFor(pageUrl: string): string {
  const u = new URL(pageUrl);
  return `${u.protocol}//${u.host}/robots.txt`;
}

export function isDisallowed(robotsTxt: string, path: string): boolean {
  if (!robotsTxt.trim()) return false;

  let inWildcardGroup = false;
  const disallowed: string[] = [];

  for (const rawLine of robotsTxt.split(/\r?\n/)) {
    const line = rawLine.split("#")[0].trim();
    if (!line) continue;

    const [rawField, ...rest] = line.split(":");
    const field = rawField.trim().toLowerCase();
    const value = rest.join(":").trim();

    if (field === "user-agent") {
      inWildcardGroup = value === "*";
      continue;
    }
    if (field === "disallow" && inWildcardGroup && value) {
      disallowed.push(value);
    }
  }

  return disallowed.some((prefix) => path.startsWith(prefix));
}
