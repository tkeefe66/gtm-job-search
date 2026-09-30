import type { DeepSearchAdvice } from "./deep-search-advice";

/** A group toggle changes only its own names, including when other selections are hidden. */
export function toggleCompanySelection(selected: ReadonlySet<string>, names: string[]): Set<string> {
  const next = new Set(selected);
  const clear = names.length > 0 && names.every(name => next.has(name));
  for (const name of names) { if (clear) next.delete(name); else next.add(name); }
  return next;
}

export function selectedTrackedCompanies(selected: ReadonlySet<string>, companies: {company: string; tracking_enabled: boolean}[]): string[] {
  return companies.filter(item => item.tracking_enabled && selected.has(item.company)).map(item => item.company);
}

export function deepSearchBatchPlan(names: string[], advice: DeepSearchAdvice[], acknowledgements: Record<string, string>) {
  const ready: {company: string; acknowledgementKey?: string}[] = [];
  const blocked: string[] = [], unreviewed: string[] = [];
  for (const company of Array.from(new Set(names))) {
    const item = advice.find(entry => entry.company === company);
    if (!item || item.blocked) blocked.push(company);
    else if (item.requiresAcknowledgement && acknowledgements[company] !== item.acknowledgementKey) unreviewed.push(company);
    else ready.push({company, acknowledgementKey: item.requiresAcknowledgement ? acknowledgements[company] : undefined});
  }
  return {ready, blocked, unreviewed};
}
