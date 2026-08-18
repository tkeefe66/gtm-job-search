import { afterEach, describe, expect, test } from "vitest";
import { cronAuthorized } from "./cron-auth";

const req = (auth?: string) =>
  new Request("https://example.test/api/cron/x", auth ? { headers: { authorization: auth } } : undefined);

const original = process.env.CRON_SECRET;
afterEach(() => {
  if (original === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = original;
});

describe("cronAuthorized", () => {
  // FAILS CLOSED. A deploy that forgot the variable must reject every caller,
  // not accept every caller.
  test("no secret configured rejects even a correct-looking bearer", () => {
    delete process.env.CRON_SECRET;
    expect(cronAuthorized(req("Bearer anything"))).toBe(false);
  });

  test("an empty secret is treated as unconfigured", () => {
    process.env.CRON_SECRET = "";
    expect(cronAuthorized(req("Bearer "))).toBe(false);
  });

  test("the matching bearer token is accepted", () => {
    process.env.CRON_SECRET = "s3cret";
    expect(cronAuthorized(req("Bearer s3cret"))).toBe(true);
  });

  test("a wrong token is rejected", () => {
    process.env.CRON_SECRET = "s3cret";
    expect(cronAuthorized(req("Bearer wrong"))).toBe(false);
  });

  test("no authorization header at all is rejected", () => {
    process.env.CRON_SECRET = "s3cret";
    expect(cronAuthorized(req())).toBe(false);
  });

  test("the scheme is matched case-insensitively, as HTTP requires", () => {
    process.env.CRON_SECRET = "s3cret";
    expect(cronAuthorized(req("bearer s3cret"))).toBe(true);
  });

  test("the raw secret without the scheme is not enough", () => {
    process.env.CRON_SECRET = "s3cret";
    expect(cronAuthorized(req("s3cret"))).toBe(false);
  });
});
