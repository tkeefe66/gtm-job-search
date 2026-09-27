import type { ProviderId, SearchOpts } from "./types";

/** Resolve the tool capability once for both provider requests and metering. */
export function effectiveSearchMode(
  provider: ProviderId,
  model: string,
  requested?: SearchOpts["searchMode"]
): "basic" | "filtered" {
  return requested === "filtered" && provider === "anthropic" && model === "claude-sonnet-4-6"
    ? "filtered" : "basic";
}
