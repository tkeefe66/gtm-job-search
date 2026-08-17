import { createCipheriv, randomBytes } from "node:crypto";
import { describe, expect, test, beforeAll } from "vitest";
import { seal, open, lastFour, CURRENT_KEY_ID } from "./secret-box";

const TENANT = "11111111-1111-1111-1111-111111111111";
const OTHER = "22222222-2222-2222-2222-222222222222";
const KEY = "sk-ant-api03-EXAMPLE-not-a-real-key-000000000000";
const AAD = { tenantId: TENANT, provider: "anthropic", model: null };

/** A row as it was written before migration 007: AAD is the tenant id alone. */
function sealV1ForTest(plaintext: string, tenantId: string) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(process.env.APP_ENCRYPTION_KEY!, "hex"), nonce);
  cipher.setAAD(Buffer.from(tenantId, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return {
    keyId: "v1",
    aadVersion: 1,
    ciphertext: ciphertext.toString("base64"),
    nonce: nonce.toString("base64"),
    authTag: cipher.getAuthTag().toString("base64"),
  };
}

beforeAll(() => {
  process.env.APP_ENCRYPTION_KEY = "a".repeat(64); // 32 bytes of hex
});

describe("seal / open", () => {
  test("round-trips under the same tenant", () => {
    expect(open(seal(KEY, AAD), AAD)).toBe(KEY);
  });

  test("the ciphertext never contains the plaintext", () => {
    const s = seal(KEY, AAD);
    expect(s.ciphertext).not.toContain(KEY);
    expect(s.ciphertext).not.toContain("sk-ant");
  });

  // THE reason tenant_id is bound as additional authenticated data. Without it,
  // anyone with a write path could copy A's row into B and bill A's Anthropic
  // account through B's session — no key material involved.
  test("a row copied to another tenant will not open", () => {
    expect(open(seal(KEY, AAD), { ...AAD, tenantId: OTHER })).toBeNull();
  });

  test("a tampered ciphertext will not open", () => {
    const s = seal(KEY, AAD);
    const bytes = Buffer.from(s.ciphertext, "base64");
    bytes[0] ^= 0xff;
    expect(open({ ...s, ciphertext: bytes.toString("base64") }, AAD)).toBeNull();
  });

  test("a swapped auth tag will not open", () => {
    const a = seal(KEY, AAD);
    const b = seal(KEY, AAD);
    expect(open({ ...a, authTag: b.authTag }, AAD)).toBeNull();
  });

  // One nonce reused under the same GCM key leaks the keystream. The database
  // carries a unique index on it too, so a bug that repeated one fails loudly.
  test("every seal uses a fresh nonce", () => {
    const nonces = new Set(Array.from({ length: 50 }, () => seal(KEY, AAD).nonce));
    expect(nonces.size).toBe(50);
  });

  test("carries a key id so the encryption key can be rotated", () => {
    expect(seal(KEY, AAD).keyId).toBe(CURRENT_KEY_ID);
  });

  // Failing to open is "this tenant has no usable key", not "the request
  // crashed" — the caller decides, and must never silently use the platform key.
  test("a failed open returns null rather than throwing", () => {
    const badSealed = { keyId: "v1", aadVersion: 2, ciphertext: "!!", nonce: "!!", authTag: "!!" };
    expect(() => open(badSealed, AAD)).not.toThrow();
    expect(open(badSealed, AAD)).toBeNull();
  });
});

describe("AAD binds the routing config, versioned", () => {
  const anthropic = { tenantId: "tenant-a", provider: "anthropic", model: null };

  test("a new seal is version 2 and round-trips", () => {
    const sealed = seal("sk-ant-secret", anthropic);
    expect(sealed.aadVersion).toBe(2);
    expect(open(sealed, anthropic)).toBe("sk-ant-secret");
  });

  test("a row will not open under a different provider", () => {
    const sealed = seal("sk-ant-secret", anthropic);
    expect(open(sealed, { ...anthropic, provider: "openai" })).toBeNull();
  });

  test("a row will not open under a different model", () => {
    const sealed = seal("sk-ant-secret", { ...anthropic, model: "claude-sonnet-4-6" });
    expect(open(sealed, { ...anthropic, model: "claude-opus-4-1" })).toBeNull();
  });

  test("a null model and an empty-string model are the same AAD, so neither can impersonate the other by accident", () => {
    const sealed = seal("sk-ant-secret", { ...anthropic, model: null });
    expect(open(sealed, { ...anthropic, model: "" })).toBe("sk-ant-secret");
  });

  // The reason aad_version exists at all. A v1 row was sealed before provider
  // routing existed; if it stopped opening, every stored key would silently
  // become "this tenant has no key" behind a plausible screen.
  test("a version 1 row, sealed against the tenant alone, still opens", () => {
    const legacy = sealV1ForTest("sk-ant-old", "tenant-a");
    expect(open(legacy, anthropic)).toBe("sk-ant-old");
  });

  test("a version 1 row still will not open under another tenant", () => {
    const legacy = sealV1ForTest("sk-ant-old", "tenant-a");
    expect(open(legacy, { ...anthropic, tenantId: "tenant-b" })).toBeNull();
  });
});

describe("key material", () => {
  test("refuses a key of the wrong size rather than padding it", () => {
    const saved = process.env.APP_ENCRYPTION_KEY;
    process.env.APP_ENCRYPTION_KEY = "abcd";
    expect(() => seal(KEY, AAD)).toThrow(/32 bytes/);
    process.env.APP_ENCRYPTION_KEY = saved;
  });

  test("refuses a missing key", () => {
    const saved = process.env.APP_ENCRYPTION_KEY;
    delete process.env.APP_ENCRYPTION_KEY;
    expect(() => seal(KEY, AAD)).toThrow(/32 bytes/);
    process.env.APP_ENCRYPTION_KEY = saved;
  });
});

describe("lastFour", () => {
  test("is the only part of a key that may be shown again", () => {
    expect(lastFour(KEY)).toBe(KEY.slice(-4));
    expect(lastFour(KEY)).toHaveLength(4);
  });
});
