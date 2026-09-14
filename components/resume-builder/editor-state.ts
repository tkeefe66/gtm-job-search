export function moveItem<T>(items: T[], index: number, direction: number): T[] {
  const destination = index + direction;
  if (index < 0 || index >= items.length || destination < 0 || destination >= items.length) return items;
  const result = [...items];
  const [item] = result.splice(index, 1);
  result.splice(destination, 0, item);
  return result;
}
export function revisionReady(saved: boolean, busy: boolean, dirty: boolean): boolean {
  return saved && !busy && !dirty;
}
