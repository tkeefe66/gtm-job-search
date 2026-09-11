import { beforeEach, describe, expect, test, vi } from "vitest";
import { PassThrough } from "node:stream";
import { EventEmitter } from "node:events";
import { gzipSync } from "node:zlib";

const mocks = vi.hoisted(() => ({ lookup: vi.fn(), request: vi.fn() }));
vi.mock("node:dns/promises", () => ({ lookup: mocks.lookup }));
vi.mock("node:http", () => ({ request: mocks.request }));
vi.mock("node:https", () => ({ request: mocks.request }));
import { safeHttp, isPublicAddress } from "./safe-http";

let responses: Array<{ status?: number; headers?: Record<string, string>; body?: Buffer; hang?: boolean }>;
let streams: PassThrough[];
let sockets: string[];
beforeEach(() => {
  vi.clearAllMocks();
  responses = []; streams = []; sockets = [];
  mocks.lookup.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
  mocks.request.mockImplementation((_url, options, callback) => {
    const req = new EventEmitter() as EventEmitter & { end: () => void; destroy: () => void };
    req.destroy = vi.fn();
    req.end = () => {
      // Exercise the exact lookup callback supplied to Node's socket creation.
      options.lookup("example.com", {}, (err: Error | null, address: string) => {
        if (err) { req.emit("error", err); return; }
        sockets.push(address);
        const fixture = responses.shift() ?? {};
        const stream = Object.assign(new PassThrough(), {
          statusCode: fixture.status ?? 200, headers: fixture.headers ?? {},
        });
        streams.push(stream);
        callback(stream);
        if (!fixture.hang) stream.end(fixture.body ?? Buffer.from("ok"));
      });
    };
    return req;
  });
});

describe("public outbound HTTP", () => {
  // Mutation this catches: allowing a reserved range or mapped private IPv4.
  test.each(["127.0.0.1", "10.1.2.3", "169.254.169.254", "100.64.0.1", "192.0.0.1", "192.0.2.1", "198.18.0.1", "224.0.0.1", "0.0.0.0", "::1", "::", "fc00::1", "fe80::1", "::ffff:127.0.0.1", "2001:db8::1", "2002:7f00:1::", "64:ff9b::7f00:1"])("rejects %s", address => {
    expect(isPublicAddress(address)).toBe(false);
  });
  // Mutation this catches: rejecting all addresses as an SSRF fix.
  test.each(["8.8.8.8", "93.184.216.34", "2606:4700:4700::1111"])("allows public %s", address => {
    expect(isPublicAddress(address)).toBe(true);
  });
  // Mutation this catches: skipping URL and all-answer DNS validation.
  test("rejects credentials, non-http and mixed private DNS before any request", async () => {
    await expect(safeHttp("https://user:secret@example.com")).rejects.toThrow();
    await expect(safeHttp("file:///etc/passwd")).rejects.toThrow();
    mocks.lookup.mockResolvedValue([{ address: "8.8.8.8", family: 4 }, { address: "10.0.0.1", family: 4 }]);
    await expect(safeHttp("https://example.com")).rejects.toThrow(/public/);
    expect(mocks.request).not.toHaveBeenCalled();
  });
  // Mutation this catches: allowing outbound probes of arbitrary service ports.
  test("rejects nonstandard destination ports before DNS", async () => {
    await expect(safeHttp("https://example.com:8080/job")).rejects.toThrow(/port/);
    await expect(safeHttp("http://example.com:22/job")).rejects.toThrow(/port/);
    expect(mocks.lookup).not.toHaveBeenCalled();
    expect(mocks.request).not.toHaveBeenCalled();
  });
  // Mutation this catches: validating DNS then letting the socket resolve again.
  test("pins socket lookup to the validated address despite later DNS changes", async () => {
    mocks.lookup.mockResolvedValueOnce([{ address: "8.8.8.8", family: 4 }]).mockResolvedValue([{ address: "127.0.0.1", family: 4 }]);
    const result = await safeHttp("https://example.com/path");
    expect(sockets).toEqual(["8.8.8.8"]);
    expect(mocks.lookup).toHaveBeenCalledTimes(1);
    expect(mocks.request.mock.calls[0][1]).toMatchObject({ agent: false, autoSelectFamily: true, autoSelectFamilyAttemptTimeout: 250 });
    expect(await result.text()).toBe("ok");
  });
  // Mutation this catches: forcing one family, disabling Happy Eyeballs, or returning only the first DNS answer.
  test("supplies the full pinned set to native fallback when the first address stalls", async () => {
    const candidates = [{ address: "2606:4700:4700::1111", family: 6 }, { address: "8.8.8.8", family: 4 }];
    mocks.lookup.mockResolvedValueOnce(candidates).mockResolvedValue([{ address: "127.0.0.1", family: 4 }]);
    mocks.request.mockImplementationOnce((_url, options, callback) => {
      const req = Object.assign(new EventEmitter(), { destroy: vi.fn(), end: () => {} });
      req.end = () => options.lookup("example.com", { all: true }, (_err: unknown, addresses: typeof candidates) => {
        expect(addresses).toEqual(candidates);
        expect(options.family).toBeUndefined();
        expect(options.autoSelectFamily).toBe(true);
        expect(options.autoSelectFamilyAttemptTimeout).toBe(250);
        // Simulated Node connection race: first address never emits an error;
        // auto-selection can move on using only the already validated second IP.
        sockets.push(addresses[1].address);
        const stream = Object.assign(new PassThrough(), { statusCode: 200, headers: {} });
        streams.push(stream);
        callback(stream);
        stream.end("fallback");
      });
      return req;
    });
    expect(await (await safeHttp("https://example.com")).text()).toBe("fallback");
    expect(sockets).toEqual(["8.8.8.8"]);
    expect(mocks.lookup).toHaveBeenCalledTimes(1);
    expect(mocks.request).toHaveBeenCalledTimes(1);
  });
  // Mutation this catches: retrying an exhausted native connection race indefinitely.
  test("terminates when native fallback exhausts all validated candidates", async () => {
    mocks.lookup.mockResolvedValue([{ address: "8.8.8.8", family: 4 }, { address: "1.1.1.1", family: 4 }]);
    mocks.request.mockImplementation(() => {
      const req = Object.assign(new EventEmitter(), { destroy: vi.fn(), end: () => {} });
      req.end = () => req.emit("error", Object.assign(new Error("Connection refused"), { code: "ECONNREFUSED" }));
      return req;
    });
    await expect(safeHttp("https://example.com")).rejects.toThrow(/Connection refused/);
    expect(mocks.request).toHaveBeenCalledTimes(1);
  });
  // Mutation this catches: following a redirect without validating the destination.
  test("rejects private redirects and closes redirect stream", async () => {
    responses.push({ status: 302, headers: { location: "http://169.254.169.254/latest" }, hang: true });
    await expect(safeHttp("https://example.com")).rejects.toThrow(/public/);
    expect(mocks.request).toHaveBeenCalledTimes(1);
    expect(streams[0].destroyed).toBe(true);
  });
  // Mutation this catches: dropping final URL/status or looping redirects indefinitely.
  test("retains final URL/status and bounds redirects", async () => {
    responses.push({ status: 302, headers: { location: "/final" } }, { status: 410 });
    const result = await safeHttp("https://example.com/posting");
    expect(result.url).toBe("https://example.com/final");
    expect(result.status).toBe(410);
    responses.push({ status: 302, headers: { location: "/again" } });
    await expect(safeHttp("https://example.com", { maxRedirects: 0 })).rejects.toThrow(/redirect/i);
  });
  // Mutation this catches: limiting compressed bytes only or buffering past the limit.
  test("limits decompressed bytes and destroys oversized streams", async () => {
    responses.push({ headers: { "content-encoding": "gzip" }, body: gzipSync(Buffer.alloc(50000, 65)) });
    await expect(safeHttp("https://example.com", { maxBytes: 1000 })).rejects.toThrow(/limit/);
    expect(streams[0].destroyed).toBe(true);
  });
  // Mutation this catches: clearing timeout at headers before body completion.
  test("times out a stalled body and destroys the stream", async () => {
    responses.push({ hang: true });
    await expect(safeHttp("https://example.com", { timeoutMs: 20 })).rejects.toThrow(/timed out/);
    expect(streams[0].destroyed).toBe(true);
  });
  // Mutation this catches: timing only sockets and opening one after DNS times out.
  test("deadline includes DNS and prevents a late DNS result opening a socket", async () => {
    let resolveDns!: (value: unknown) => void;
    mocks.lookup.mockImplementation(() => new Promise(resolve => { resolveDns = resolve; }));
    await expect(safeHttp("https://example.com", { timeoutMs: 20 })).rejects.toThrow(/timed out/);
    resolveDns([{ address: "8.8.8.8", family: 4 }]);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(mocks.request).not.toHaveBeenCalled();
  });
  // Mutation this catches: reusing the previous host's validation for redirects.
  test("resolves each redirect host and refuses a private DNS destination", async () => {
    responses.push({ status: 302, headers: { location: "https://other.example/path" } });
    mocks.lookup.mockResolvedValueOnce([{ address: "8.8.8.8", family: 4 }]).mockResolvedValueOnce([{ address: "10.0.0.1", family: 4 }]);
    await expect(safeHttp("https://example.com")).rejects.toThrow(/public/);
    expect(mocks.lookup.mock.calls.map(call => call[0])).toEqual(["example.com", "other.example"]);
    expect(mocks.request).toHaveBeenCalledTimes(1);
  });
  // Mutation this catches: rejecting at equality or failing to bound identity bodies.
  test("accepts exactly the byte limit and rejects one extra byte", async () => {
    responses.push({ body: Buffer.from("1234") }, { body: Buffer.from("12345") });
    expect(await (await safeHttp("https://example.com", { maxBytes: 4 })).text()).toBe("1234");
    await expect(safeHttp("https://example.com", { maxBytes: 4 })).rejects.toThrow(/limit/);
    expect(streams[1].destroyed).toBe(true);
  });
  // Mutation this catches: waiting for a HEAD body or leaving its stream open.
  test("HEAD returns status without awaiting a body and closes the response", async () => {
    responses.push({ status: 405, hang: true });
    expect((await safeHttp("https://example.com", { method: "HEAD" })).status).toBe(405);
    expect(streams[0].destroyed).toBe(true);
  });
});
