import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * Authenticated encryption for tenant-supplied API keys.
 *
 * Five decisions here, each closing a specific hole:
 *
 * 1. AES-256-GCM, not a bare cipher. Without an auth tag, ciphertext can be
 *    modified undetectably.
 *
 * 2. `tenant_id` is bound as ADDITIONAL AUTHENTICATED DATA. Without it, anyone
 *    with a write path could copy tenant A's ciphertext and nonce into tenant
 *    B's row and then bill A's Anthropic account through B's session — no key
 *    material required. With it, decryption under the wrong tenant fails.
 *
 * 3. A `keyId` travels with every ciphertext, so the encryption key can ever be
 *    ROTATED. Without it there is no way to tell which rows use which key, and
 *    rotation becomes a flag day that silently corrupts whatever it misses.
 *
 * 4. The nonce is random per encryption and never reused. One nonce reused under
 *    the same GCM key is catastrophic — it leaks the keystream. The database
 *    also carries a unique index on it, so a bug that repeated one fails loudly
 *    rather than silently weakening every row.
 *
 * 5. The AAD is VERSIONED, per row. Binding `provider` and `model` into it (so
 *    the routing config cannot be swapped independently of the ciphertext it
 *    routes) changes the AAD of every row written before that binding existed.
 *    Those rows would stop opening, and a failed open is indistinguishable from
 *    "this tenant stored no key" — a total, silent loss behind a plausible
 *    screen. So each row records which AAD it was sealed under.
 *
 * The key itself lives ONLY in an environment variable, never in Postgres.
 * Backups contain these ciphertexts; if the key were a row in a settings table,
 * one leaked backup would be every tenant's Anthropic account.
 */

export interface Aad {
  tenantId: string;
  provider: string;
  /** Null means "the provider's default model" and is bound as an empty string. */
  model: string | null;
}

export interface SealedSecret {
  keyId: string;
  aadVersion: number;
  ciphertext: string;
  nonce: string;
  authTag: string;
}

/** Names the key material in use, so rotation can tell rows apart. */
export const CURRENT_KEY_ID = "v1";
export const CURRENT_AAD_VERSION = 2;

function aadBytes(version: number, aad: Aad): Buffer {
  // v1: the tenant alone, as written before migration 007.
  if (version === 1) return Buffer.from(aad.tenantId, "utf8");
  return Buffer.from(`${aad.tenantId}|${aad.provider}|${aad.model ?? ""}`, "utf8");
}

function keyBytes(): Buffer {
  const raw = process.env.APP_ENCRYPTION_KEY ?? "";
  const buf = Buffer.from(raw, "hex");
  // Throws rather than padding or hashing a short key into shape. A silently
  // weakened key is worse than a startup failure, and this is reached only when
  // a tenant actually stores a key.
  if (buf.length !== 32) {
    throw new Error(
      "APP_ENCRYPTION_KEY must be 32 bytes of hex (64 characters). Refusing to encrypt with a key of the wrong size."
    );
  }
  return buf;
}

export function seal(plaintext: string, aad: Aad): SealedSecret {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyBytes(), nonce);
  cipher.setAAD(aadBytes(CURRENT_AAD_VERSION, aad));
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return {
    keyId: CURRENT_KEY_ID,
    aadVersion: CURRENT_AAD_VERSION,
    ciphertext: ciphertext.toString("base64"),
    nonce: nonce.toString("base64"),
    authTag: cipher.getAuthTag().toString("base64"),
  };
}

/**
 * Returns null rather than throwing on a failed open.
 *
 * A failure here means the row was tampered with, moved between tenants, was
 * re-routed to a different provider or model, or was written under a key that
 * no longer exists — all of which are "this tenant has no usable key", not "the
 * request crashed". The CALLER decides what to do, and must never fall back to
 * the platform key silently.
 */
export function open(sealed: SealedSecret, aad: Aad): string | null {
  try {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      keyBytes(),
      Buffer.from(sealed.nonce, "base64")
    );
    decipher.setAAD(aadBytes(sealed.aadVersion, aad));
    decipher.setAuthTag(Buffer.from(sealed.authTag, "base64"));
    return Buffer.concat([
      decipher.update(Buffer.from(sealed.ciphertext, "base64")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    // Deliberately swallows the reason. Crypto failure text is the kind of
    // detail that ends up in a log aggregator next to the thing it describes.
    return null;
  }
}

/**
 * The only part of a key that may ever be shown again.
 *
 * Stored separately so displaying it never requires decrypting anything — the
 * plaintext is written once and never read back for the UI, including for the
 * admin.
 */
export function lastFour(key: string): string {
  return key.slice(-4);
}
