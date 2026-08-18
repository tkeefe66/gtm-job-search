import { describe, expect, test } from "vitest";
import { partitionNeverLive } from "./never-live";
import type { Job } from "@/lib/types";

// Only the two fields the partition reads. Cast rather than building a full
// 30-field Job: a fixture that big would obscure what each case varies.
const job = (id: string, never_live: unknown): Job =>
  ({ id, company: "Clay", role_title: "RevOps Manager", never_live }) as unknown as Job;

describe("partitionNeverLive", () => {
  test("removes rows flagged never_live and counts them", () => {
    const res = partitionNeverLive([job("a", false), job("b", true), job("c", false)]);

    expect(res.visible.map((j) => j.id)).toEqual(["a", "c"]);
    expect(res.hiddenCount).toBe(1);
  });

  test("keeps rows read before the migration, where the column is undefined", () => {
    // A row selected from a database that has not had the column added yet
    // arrives with no such key. It must stay VISIBLE: failing open shows a row
    // that should have been hidden, failing closed hides a live role with
    // nothing on screen to explain it.
    const res = partitionNeverLive([job("a", undefined), job("b", null)]);

    expect(res.visible.map((j) => j.id)).toEqual(["a", "b"]);
    expect(res.hiddenCount).toBe(0);
  });

  test("preserves the order of the rows it keeps", () => {
    const res = partitionNeverLive([job("a", false), job("b", true), job("c", false), job("d", false)]);

    expect(res.visible.map((j) => j.id)).toEqual(["a", "c", "d"]);
  });

  test("an empty list hides nothing", () => {
    expect(partitionNeverLive([])).toEqual({ visible: [], hiddenCount: 0 });
  });

  test("every row hidden still returns a usable shape", () => {
    const res = partitionNeverLive([job("a", true), job("b", true)]);

    expect(res.visible).toEqual([]);
    expect(res.hiddenCount).toBe(2);
  });
});
