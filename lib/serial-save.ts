/** Serialize draft writes so a slow older request cannot land after a newer one. */
export function serialSave<T, R>(write: (value: T) => Promise<R>): ((value: T) => Promise<R>) & { drain: () => Promise<void> } {
  let tail: Promise<unknown> = Promise.resolve();
  const enqueue = (value: T) => {
    const result = tail.then(() => write(value));
    tail = result.catch(() => undefined);
    return result;
  };
  enqueue.drain = async () => { await tail; };
  return enqueue;
}
