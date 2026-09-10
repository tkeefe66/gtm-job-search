import { ROLE_SEARCH_BATCH_SIZE } from "./role-search-policy";
import { normalizeRoleKey } from "./role-key";

/** Sequential calls keep metering current and stop buying work after a failure. */
export async function runRoleSearchBatches<T extends { company: string; role_title: string }>(
  queries: string[], maxSearches: number,
  run: (queries: string[], maxSearches: number) => Promise<T[]>
): Promise<{ items: T[]; error?: string }> {
  const found = new Map<string, T>();
  let remaining = maxSearches;
  for (let offset = 0; offset < queries.length && remaining > 0;) {
    const size = Math.min(ROLE_SEARCH_BATCH_SIZE, remaining, queries.length - offset);
    const batch = queries.slice(offset, offset + size);
    try {
      const items = await run(batch, size);
      for (const item of items) {
        const key = normalizeRoleKey(item.company, item.role_title);
        if (!found.has(key)) found.set(key, item);
      }
    } catch (error) {
      if (found.size === 0) throw error;
      console.error(`role search: stopped after ${offset} queries; keeping ${found.size} roles`);
      return {
        items: Array.from(found.values()),
        error: "Partial results: a later search batch failed. Earlier results are shown; the previous complete search cache was kept. Retry to finish the search.",
      };
    }
    remaining -= size;
    offset += size;
  }
  return { items: Array.from(found.values()) };
}
