import { AsyncLocalStorage } from "node:async_hooks";

export interface AIAttribution {
  company?: string;
  crawlRunId?: string;
  jobId?: string;
  trigger?: "scheduled" | "manual" | "on-track" | "recovery" | "other";
  phase?: string;
}
const g = globalThis as unknown as { __aiAttribution?: AsyncLocalStorage<Readonly<AIAttribution>> };
const storage = g.__aiAttribution ??= new AsyncLocalStorage<Readonly<AIAttribution>>();
export function aiAttribution(): Readonly<AIAttribution> { return storage.getStore() ?? {}; }
export function withAIAttribution<T>(value: AIAttribution, fn: () => Promise<T>): Promise<T> {
  return storage.run(Object.freeze({ ...aiAttribution(), ...value }), fn);
}
