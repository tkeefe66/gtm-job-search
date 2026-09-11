import { afterEach, expect, test, vi } from "vitest";
const transport = vi.hoisted(() => ({ safeHttp: vi.fn() }));
vi.mock("./safe-http", () => transport);
import { fetchAllowed, fetchPage } from "./fetch-page";

afterEach(() => { transport.safeHttp.mockReset(); vi.restoreAllMocks(); });

// Mutation this catches: treating blocked/oversized robots as absent and allowing a fetch.
test("transport refusals fail closed for both robots and page", async () => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  transport.safeHttp.mockRejectedValue(new Error("Outbound destination must resolve only to public IP addresses"));
  expect(await fetchAllowed("https://example.com/job")).toBe(false);
  expect(await fetchPage("https://example.com/job")).toBeNull();
  expect(transport.safeHttp.mock.calls.map(call => call[0])).toEqual(["https://example.com/robots.txt", "https://example.com/job"]);
  expect(transport.safeHttp.mock.calls[0][1]).toMatchObject({ maxBytes: 256 * 1024 });
});

// Mutation this catches: denying genuine missing robots or bypassing the page transport.
test("absent robots allow a bounded page fetch", async () => {
  transport.safeHttp.mockResolvedValueOnce({ status: 404 }).mockResolvedValueOnce({ ok: true, text: async () => "posting" });
  expect(await fetchAllowed("https://example.com/job")).toBe(true);
  expect(await fetchPage("https://example.com/job")).toBe("posting");
});
