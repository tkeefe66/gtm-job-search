// Discover started asking the model for `signal` — one legible sentence per
// employer — in this task. Every `discovered_startups` row cached before
// this shipped has no such field; it has the old venture-only trio instead
// (`raised`, `stage`, `lead_investor`). Rather than let those rows render an
// empty line, this composes the same one-line shape `signal` now provides
// out of whichever of the three old fields are present, so old cache rows
// keep reading well until they age out or get re-fetched.

export function legacySignalFrom(s: {
  raised?: string;
  stage?: string;
  lead_investor?: string;
}): string {
  const parts: string[] = [];
  if (s.raised) parts.push(`Raised ${s.raised}`);
  if (s.stage) parts.push(s.raised ? `(${s.stage})` : s.stage);
  if (s.lead_investor) parts.push(`led by ${s.lead_investor}`);
  return parts.join(" ");
}
