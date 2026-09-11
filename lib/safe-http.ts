import * as http from "node:http";
import * as https from "node:https";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import type { Transform } from "node:stream";
import ipaddr from "ipaddr.js";

/** Fail closed for special-purpose, transition and non-global addresses. */
export function isPublicAddress(address: string): boolean {
  try {
    const ip = ipaddr.parse(address);
    if (ip.range() !== "unicast") return false;
    // IPv6 global unicast only. Exclude IETF special assignments (2001::/23)
    // and documentation (3fff::/20), even if an ipaddr release calls them unicast.
    if (ip.kind() === "ipv6") {
      const v6 = ip as ipaddr.IPv6;
      return v6.match(ipaddr.parse("2000::") as ipaddr.IPv6, 3)
        && !v6.match(ipaddr.parse("2001::") as ipaddr.IPv6, 23)
        && !v6.match(ipaddr.parse("3fff::") as ipaddr.IPv6, 20);
    }
    return true;
  } catch { return false; }
}

export interface SafeHttpOptions {
  method?: "GET" | "HEAD";
  headers?: Record<string, string>;
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
}

/**
 * Public-web transport. Each redirect resolves anew, rejects any private answer,
 * then pins Node's socket lookup to the validated address set. No proxy environment
 * or shared connection pool can bypass that binding. Host/SNI retain the URL host.
 * Both encoded and decoded bodies are bounded; the deadline covers DNS to EOF.
 */
export async function safeHttp(input: string, options: SafeHttpOptions = {}) {
  const maxBytes = options.maxBytes ?? 2 * 1024 * 1024;
  const maxRedirects = options.maxRedirects ?? 5;
  const timeoutMs = options.timeoutMs ?? 10_000;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || !Number.isSafeInteger(maxRedirects) || maxRedirects < 0 || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("Invalid outbound HTTP limits");
  }
  let cleanup = () => {};
  let expired = false;
  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      expired = true;
      cleanup();
      reject(new Error("Outbound HTTP request timed out"));
    }, timeoutMs);
  });
  const run = async () => {
    let url = new URL(input);
    for (let hop = 0; ; hop++) {
      if (expired) throw new Error("Outbound HTTP request timed out");
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
        throw new Error("Outbound URL must use HTTP(S) without credentials");
      }
      // URL normalizes the protocol's default port to an empty string.
      if (url.port) throw new Error("Outbound URL must use the standard HTTP(S) port");
      const hostname = url.hostname.replace(/^\[|\]$/g, "");
      const addresses = isIP(hostname)
        ? [{ address: hostname, family: isIP(hostname) }]
        : await lookup(hostname, { all: true, verbatim: true });
      if (expired) throw new Error("Outbound HTTP request timed out");
      if (!addresses.length || addresses.some(a => !isPublicAddress(a.address))) {
        throw new Error("Outbound destination must resolve only to public IP addresses");
      }
      const response = await new Promise<http.IncomingMessage>((resolve, reject) => {
        const requestOptions: http.RequestOptions & {
          autoSelectFamily: boolean;
          autoSelectFamilyAttemptTimeout: number;
        } = {
          method: options.method ?? "GET",
          agent: false,
          // Node races validated candidates after 250ms even when the first
          // address silently blackholes. A forced family disables this behavior.
          autoSelectFamily: true,
          autoSelectFamilyAttemptTimeout: 250,
          headers: { ...options.headers, "Accept-Encoding": "gzip, deflate, br" },
          lookup: (_host, lookupOptions, callback) => {
            if (lookupOptions.all) callback(null, addresses);
            else callback(null, addresses[0].address, addresses[0].family);
          },
        };
        const request = (url.protocol === "https:" ? https : http).request(url, requestOptions, resolve);
        cleanup = () => request.destroy();
        request.once("error", reject);
        request.end();
      });
      cleanup = () => response.destroy();
      const status = response.statusCode ?? 0;
      const location = response.headers.location;
      if ([301, 302, 303, 307, 308].includes(status) && location) {
        response.destroy();
        if (hop >= maxRedirects) throw new Error("Outbound HTTP redirect limit exceeded");
        url = new URL(location, url);
        continue;
      }
      let body = Buffer.alloc(0);
      if (options.method !== "HEAD") {
        const encoding = String(response.headers["content-encoding"] ?? "identity").toLowerCase();
        let decoder: Transform | undefined;
        if (encoding === "gzip") decoder = createGunzip();
        else if (encoding === "deflate") decoder = createInflate();
        else if (encoding === "br") decoder = createBrotliDecompress();
        else if (encoding !== "identity") {
          response.destroy();
          throw new Error("Unsupported outbound HTTP content encoding");
        }
        const decoded = decoder ?? response;
        cleanup = () => { response.destroy(); decoded.destroy(); };
        let encodedBytes = 0;
        response.on("data", (chunk: Buffer) => {
          encodedBytes += chunk.length;
          if (encodedBytes > maxBytes) decoded.destroy(new Error("Outbound HTTP encoded body limit exceeded"));
        });
        if (decoder) {
          response.on("error", error => decoded.destroy(error));
          response.on("aborted", () => decoded.destroy(new Error("Outbound HTTP response aborted")));
          response.pipe(decoder);
        }
        const chunks: Buffer[] = [];
        let bytes = 0;
        try {
          for await (const chunk of decoded) {
            const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            bytes += buffer.length;
            if (bytes > maxBytes) throw new Error("Outbound HTTP decoded body limit exceeded");
            chunks.push(buffer);
          }
          body = Buffer.concat(chunks, bytes);
        } finally { cleanup(); }
      } else { response.destroy(); }
      return {
        status, ok: status >= 200 && status < 300, url: url.href,
        text: async () => body.toString("utf8"),
        json: async (): Promise<unknown> => JSON.parse(body.toString("utf8")),
      };
    }
  };
  try { return await Promise.race([run(), deadline]); }
  finally { clearTimeout(timer!); cleanup(); }
}
