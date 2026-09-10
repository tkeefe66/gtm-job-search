import { expect, test } from "vitest";
import { serialSave } from "./serial-save";

test("a slow earlier save cannot overwrite the newest answers", async () => {
  let release!: () => void;
  const started: number[] = [];
  let stored = 0;
  const save = serialSave(async (value: number) => {
    started.push(value);
    if (value === 1) await new Promise<void>(resolve => { release = resolve; });
    stored = value;
    return {};
  });
  const first = save(1);
  const second = save(2);
  await Promise.resolve();
  expect(started).toEqual([1]);
  release();
  await Promise.all([first, second]);
  expect(stored).toBe(2);
});

test("a rejected save is returned to its caller but does not poison retries", async () => {
  const save = serialSave(async (value: number) => {
    if (value === 1) throw new Error("connection failed");
    return value;
  });
  await expect(save(1)).rejects.toThrow("connection failed");
  await expect(save(2)).resolves.toBe(2);
});

test("drain waits for queued writes even when a write fails, without another save", async () => {
  let release!: () => void;
  const save = serialSave(async () => {
    await new Promise<void>(resolve => { release = resolve; });
    throw new Error("invalid input");
  });
  const write = save(undefined).catch(() => undefined);
  let drained = false;
  const drain = save.drain().then(() => { drained = true; });
  await Promise.resolve();
  expect(drained).toBe(false);
  release();
  await Promise.all([write, drain]);
  expect(drained).toBe(true);
});
