/** Release UI state even if a browser RPC never settles. This does not cancel server work. */
export async function requestWithDeadline<T>(request: Promise<T>, ms = 300_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([request, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Request timed out. Server work may still finish.")), ms);
    })]);
  } finally { if (timer !== undefined) clearTimeout(timer); }
}
