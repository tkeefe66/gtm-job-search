import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * Authenticated encryption for tenant-supplied API keys.
 *
 * Four decisions here, each closing a specific hole:
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
 * The key itself lives ONLY in an environment variable, never in Postgres.
 * Backups contain these ciphertexts; if the key were a row in a settings table,
 * one leaked backup would be every tenant's Anthropic account.
 */

export interface SealedSecret {
  keyId: string;
  ciphertext: string;
  nonce: string;
  authTag: string;
}

/** Names the key material in use, so rotation can tell rows apart. */
export const CURRENT_KEY_ID = "v1";

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

export function seal(plaintext: string, tenantId: string): SealedSecret {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyBytes(), nonce);
  cipher.setAAD(Buffer.from(tenantId, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return {
    keyId: CURRENT_KEY_ID,
    ciphertext: ciphertext.toString("base64"),
    nonce: nonce.toString("base64"),
    authTag: cipher.getAuthTag().toString("base64"),
  };
}

/**
 * Returns null rather than throwing on a failed open.
 *
 * A failure here means the row was tampered with, moved between tenants, or was
 * written under a key that no longer exists — all of which are "this tenant has
 * no usable key", not "the request crashed". The CALLER decides what to do, and
 * must never fall back to the platform key silently.
 */
export function open(sealed: SealedSecret, tenantId: string): string | null {
  try {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      keyBytes(),
      Buffer.from(sealed.nonce, "base64")
    );
    decipher.setAAD(Buffer.from(tenantId, "utf8"));
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
