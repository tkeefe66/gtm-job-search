import { expect, test } from "vitest";
// Mutation: remove the header configuration and permit third-party framing again.
test("all routes disallow framing and carry baseline browser protections", async () => {
  const config = (await import("../next.config.js")).default;
  const rules = await config.headers?.();
  expect(rules).toBeDefined();
  const headers = Object.fromEntries(rules![0].headers.map(({ key, value }: { key: string; value: string }) => [key, value]));
  expect(rules![0].source).toBe("/:path*");
  expect(headers["Content-Security-Policy"]).toContain("frame-ancestors 'none'");
  expect(headers["X-Frame-Options"]).toBe("DENY");
  expect(headers["X-Content-Type-Options"]).toBe("nosniff");
  expect(headers["Referrer-Policy"]).toBe("strict-origin-when-cross-origin");
  expect(headers["Strict-Transport-Security"]).toBe("max-age=31536000");
});
