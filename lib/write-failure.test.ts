import { describe, expect, test } from "vitest";
import {
  UNDESCRIBED_DB_ERROR,
  aggregateCauses,
  describeWriteFailure,
} from "./write-failure";

describe("describeWriteFailure", () => {
  // The doctrine's two halves, pinned in the one place they are testable.
  // These duplicate lib/settings-store.test.ts's coverage on purpose: that
  // suite imports through the re-export, this one imports the definition, so a
  // future move that breaks the re-export fails there and a change to the
  // logic fails here.

  test("a write that succeeded is undefined, not a sentence", () => {
    expect(describeWriteFailure(undefined, "save the status change")).toBeUndefined();
  });

  test("an EMPTY message is still a failure — presence, not truthiness", () => {
    // The whole defect class. `if (error)` skips this case entirely, which is
    // how a hard write failure reported success with zero log output.
    // Mutate `if (error === undefined)` to `if (!error)` and this flips to
    // undefined.
    const described = describeWriteFailure("", "save the status change");
    expect(described).toBeDefined();
    expect(described).toContain(UNDESCRIBED_DB_ERROR);
  });

  test("the stand-in says the database is unreachable entirely, not that one write failed", () => {
    // Copy guard, and it is load-bearing rather than cosmetic: an empty
    // message is only ever produced by a CONNECTION-level failure, so a
    // message implying a single bad operation sends the reader looking for the
    // wrong thing. See the AggregateError note in lib/write-failure.ts.
    expect(UNDESCRIBED_DB_ERROR).toContain("unreachable entirely");
    expect(UNDESCRIBED_DB_ERROR).toContain("DATABASE_URL");
  });

  test("a described failure is quoted verbatim and does NOT get the stand-in", () => {
    const described = describeWriteFailure("relation \"jobs\" does not exist", "save it");
    expect(described).toBe('Could not save it — relation "jobs" does not exist');
    expect(described).not.toContain(UNDESCRIBED_DB_ERROR);
  });

  test("`what` completes \"Could not ___\"", () => {
    expect(describeWriteFailure("boom", "delete the role")).toBe(
      "Could not delete the role — boom"
    );
  });
});

describe("aggregateCauses", () => {
  test("recovers the per-address messages an AggregateError hides", () => {
    // The real shape, reproduced from a live probe of `pg` against a dead
    // localhost:5432 — message "", causes on .errors[]. This is the only
    // place those strings can still be read.
    const agg = new AggregateError(
      [
        new Error("connect ECONNREFUSED ::1:5432"),
        new Error("connect ECONNREFUSED 127.0.0.1:5432"),
      ],
      ""
    );
    expect(agg.message).toBe("");
    expect(aggregateCauses(agg)).toEqual([
      "connect ECONNREFUSED ::1:5432",
      "connect ECONNREFUSED 127.0.0.1:5432",
    ]);
  });

  test("an ordinary Error has no hidden causes", () => {
    // Guards the other direction: a described failure must not grow a phantom
    // diagnostic. Mutate the `Array.isArray` guard away and this returns
    // something non-empty.
    expect(aggregateCauses(new Error("getaddrinfo ENOTFOUND db.invalid"))).toEqual([]);
  });

  test("non-Error throwables yield nothing", () => {
    expect(aggregateCauses("a bare string")).toEqual([]);
    expect(aggregateCauses(undefined)).toEqual([]);
    expect(aggregateCauses({ errors: [new Error("not an Error instance")] })).toEqual([]);
  });

  test("nested aggregates are flattened", () => {
    const inner = new AggregateError([new Error("inner one"), new Error("inner two")], "");
    const outer = new AggregateError([inner, new Error("outer")], "");
    expect(aggregateCauses(outer)).toEqual(["inner one", "inner two", "outer"]);
  });

  test("a cause with an empty message of its own is dropped, not carried through", () => {
    // Otherwise the log line reads "Underlying causes: ; ; " and is worse than
    // saying nothing. Non-empty length asserted so the filter cannot pass by
    // returning [].
    const agg = new AggregateError([new Error(""), new Error("connect ECONNREFUSED")], "");
    const causes = aggregateCauses(agg);
    expect(causes).toHaveLength(1);
    expect(causes[0]).toBe("connect ECONNREFUSED");
  });
});
