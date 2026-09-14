import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test, vi } from "vitest";
import Nav from "@/components/Nav";

vi.mock("next/navigation", () => ({ usePathname: () => "/resume/builder" }));
vi.stubGlobal("React", React);

// Mutation: tie resume navigation to administrator status instead of the capability.
test("an enabled ordinary tenant can reach the resume builder without Accounts", () => {
  const html = renderToStaticMarkup(React.createElement(Nav, {isAdmin:false,resumeBuilder:true}));
  expect(html).toContain('href="/resume/builder"');
  expect(html).not.toContain('href="/admin"');
});

// Mutation: expose the builder to tenants whose rollout capability is disabled.
test("a disabled ordinary tenant has no resume navigation", () => {
  const html = renderToStaticMarkup(React.createElement(Nav, {isAdmin:false,resumeBuilder:false}));
  expect(html).not.toContain('href="/resume');
});

// Mutation: replace the legacy archive URL even when the new builder is unavailable.
test("admins retain the legacy archive when the builder is disabled", () => {
  const html = renderToStaticMarkup(React.createElement(Nav, {isAdmin:true,resumeBuilder:false}));
  expect(html).toContain('href="/resume"');
  expect(html).toContain('href="/admin"');
});
