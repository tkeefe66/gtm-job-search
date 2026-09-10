import { ModelResponseError } from "./model-response";

/** Read complete top-level values only; never salvage a nested fragment. */
export function parseModelJson<T>(raw: string): T {
  const text = raw.trim();
  try { return JSON.parse(text) as T; } catch { /* Framed model answer. */ }
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) {
    try { return JSON.parse(fence[1].trim()) as T; }
    catch { throw new ModelResponseError(); }
  }
  const candidates: unknown[] = [];
  for (let start = 0; start < text.length; start++) {
    if (text[start] !== "[" && text[start] !== "{") continue;
    const stack: string[] = [];
    let quoted = false;
    let escaped = false;
    let end = start;
    for (; end < text.length; end++) {
      const char = text[end];
      if (quoted) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === '"') quoted = false;
        continue;
      }
      if (char === '"') quoted = true;
      else if (char === "[" || char === "{") stack.push(char);
      else if (char === "]" || char === "}") {
        if (stack.pop() !== (char === "]" ? "[" : "{")) throw new ModelResponseError();
        if (stack.length === 0) break;
      }
    }
    if (end === text.length) throw new ModelResponseError();
    const chunk = text.slice(start, end + 1);
    // Numeric brackets in narration are citations, not answer envelopes.
    if (!/^\[\s*\d+(?:\s*,\s*\d+)*\s*\]$/.test(chunk)) {
      try { candidates.push(JSON.parse(chunk)); }
      catch { if (text[start] === "{") throw new ModelResponseError(); }
    }
    start = end;
  }
  if (candidates.length !== 1) throw new ModelResponseError();
  return candidates[0] as T;
}
