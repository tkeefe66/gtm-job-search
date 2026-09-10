/** Failures in model output are never evidence that an employer's page is dead. */
export class ModelResponseError extends Error {
  constructor(message = "The AI response could not be validated. Please retry.") {
    super(message);
    this.name = "ModelResponseError";
  }
}

export const SEARCH_RESPONSE_TOO_LARGE =
  "The search produced too much data to finish. Please retry.";

/** Forced function calls finish with tool_use on Anthropic only. */
export function isModelComplete(stopReason: string | null, forcedTool = false): boolean {
  return ["end_turn", "stop_sequence", "completed", "STOP"].includes(stopReason ?? "") ||
    (forcedTool && stopReason === "tool_use");
}

export function assertModelComplete(stopReason: string | null, forcedTool = false): void {
  if (isModelComplete(stopReason, forcedTool)) return;
  if (["max_tokens", "MAX_TOKENS", "incomplete"].includes(stopReason ?? "")) {
    throw new ModelResponseError(SEARCH_RESPONSE_TOO_LARGE);
  }
  throw new ModelResponseError("The AI did not finish a usable answer. Please retry.");
}
