import { beforeEach, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({ connect: vi.fn(), query: vi.fn(), end: vi.fn(), on: vi.fn() }));
vi.mock("pg", () => ({ Client: class { constructor() { return db; } } }));
import { databaseReady } from "./readiness";
import { GET } from "../app/api/health/route";

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("DATABASE_URL", "postgres://synthetic@localhost/test");
  db.connect.mockResolvedValue(undefined);
  db.query.mockResolvedValue({ rows: [] });
  db.end.mockResolvedValue(undefined);
});

it("checks schema and closes its connection", async () => {
  expect(await databaseReady()).toBe(true);
  expect(db.query).toHaveBeenCalledWith(expect.stringContaining("limit 0"));
  expect(db.end).toHaveBeenCalledOnce();
});

it.each(["connect", "query"] as const)("returns 503 without leaking %s failures", async (step) => {
  db[step].mockRejectedValue(new Error("private host and credential details"));
  const response = await GET();
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ status: "unavailable" });
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect(db.end).toHaveBeenCalledOnce();
});
