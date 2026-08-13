import { describe, expect, test } from "vitest";
import { isDisallowed, robotsUrlFor } from "./robots";

const ROBOTS = `
User-agent: BadBot
Disallow: /

User-agent: *
Disallow: /admin
Disallow: /internal/
Allow: /careers
`;

describe("robotsUrlFor", () => {
  test("resolves to the host root regardless of path", () => {
    expect(robotsUrlFor("https://example.com/careers/openings?x=1")).toBe(
      "https://example.com/robots.txt"
    );
  });

  test("preserves a non-default port", () => {
    expect(robotsUrlFor("https://example.com:8443/careers")).toBe(
      "https://example.com:8443/robots.txt"
    );
  });
});

describe("isDisallowed", () => {
  test("allows a path no rule covers", () => {
    expect(isDisallowed(ROBOTS, "/careers")).toBe(false);
  });

  test("blocks a path under a Disallow prefix", () => {
    expect(isDisallowed(ROBOTS, "/internal/jobs")).toBe(true);
  });

  test("only reads the wildcard group, not other user-agent groups", () => {
    // "Disallow: /" belongs to BadBot, not to *.
    expect(isDisallowed(ROBOTS, "/anything")).toBe(false);
  });

  test("an empty or missing robots.txt allows everything", () => {
    expect(isDisallowed("", "/careers")).toBe(false);
  });

  test("a bare 'Disallow:' with no value is not a block", () => {
    expect(isDisallowed("User-agent: *\nDisallow:", "/careers")).toBe(false);
  });
});
