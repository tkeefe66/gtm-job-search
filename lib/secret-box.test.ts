import { describe, expect, test, beforeAll } from "vitest";
import { seal, open, lastFour, CURRENT_KEY_ID } from "./secret-box";

const TENANT = "11111111-1111-1111-1111-111111111111";
const OTHER = "22222222-2222-2222-2222-222222222222";
const KEY = "sk-ant-api03-EXAMPLE-not-a-real-key-000000000000";

beforeAll(() => {
  process.env.APP_ENCRYPTION_KEY = "a".repeat(64); // 32 bytes of hex
});

describe("seal / open", () => {
  test("round-trips under the same tenant", () => {
    expect(open(seal(KEY, TENANT), TENANT)).toBe(KEY);
  });

  test("the ciphertext never contains the plaintext", () => {
    const s = seal(KEY, TENANT);
    expect(s.ciphertext).not.toContain(KEY);
    expect(s.ciphertext).not.toContain("sk-ant");
  });

  // THE reason tenant_id is bound as additional authenticated data. Without it,
  // anyone with a write path could copy A's row into B and bill A's Anthropic
  // account through B's session — no key material involved.
  test("a row copied to another tenant will not open", () => {
    expect(open(seal(KEY, TENANT), OTHER)).toBeNull();
  });

  test("a tampered ciphertext will not open", () => {
    const s = seal(KEY, TENANT);
    const bytes = Buffer.from(s.ciphertext, "base64");
    bytes[0] ^= 0xff;
    expect(open({ ...s, ciphertext: bytes.toString("base64") }, TENANT)).toBeNull();
  });

  test("a swapped auth tag will not open", () => {
    const a = seal(KEY, TENANT);
    const b = seal(KEY, TENANT);
    expect(open({ ...a, authTag: b.authTag }, TENANT)).toBeNull();
  });

  // One nonce reused under the same GCM key leaks the keystream. The database
  // carries a unique index on it too, so a bug that repeated one fails loudly.
  test("every seal uses a fresh nonce", () => {
    const nonces = new Set(Array.from({ length: 50 }, () => seal(KEY, TENANT).nonce));
    expect(nonces.size).toBe(50);
  });

  test("carries a key id so the encryption key can be rotated", () => {
    expect(seal(KEY, TENANT).keyId).toBe(CURRENT_KEY_ID);
  });

  // Failing to open is "this tenant has no usable key", not "the request
  // crashed" — the caller decides, and must never silently use the platform key.
  test("a failed open returns null rather than throwing", () => {
    expect(() => open({ keyId: "v1", ciphertext: "!!", nonce: "!!", authTag: "!!" }, TENANT)).not.toThrow();
    expect(open({ keyId: "v1", ciphertext: "!!", nonce: "!!", authTag: "!!" }, TENANT)).toBeNull();
  });
});

describe("key material", () => {
  test("refuses a key of the wrong size rather than padding it", () => {
    const saved = process.env.APP_ENCRYPTION_KEY;
    process.env.APP_ENCRYPTION_KEY = "abcd";
    expect(() => seal(KEY, TENANT)).toThrow(/32 bytes/);
    process.env.APP_ENCRYPTION_KEY = saved;
  });

  test("refuses a missing key", () => {
    const saved = process.env.APP_ENCRYPTION_KEY;
    delete process.env.APP_ENCRYPTION_KEY;
    expect(() => seal(KEY, TENANT)).toThrow(/32 bytes/);
    process.env.APP_ENCRYPTION_KEY = saved;
  });
});

describe("lastFour", () => {
  test("is the only part of a key that may be shown again", () => {
    expect(lastFour(KEY)).toBe(KEY.slice(-4));
    expect(lastFour(KEY)).toHaveLength(4);
  });
});
