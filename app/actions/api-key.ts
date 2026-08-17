"use server";

import Anthropic from "@anthropic-ai/sdk";
import { requireActor } from "@/lib/require-actor";
import { resolveTenantId } from "@/lib/tenant";
import { rawQuery } from "@/lib/supabase";
import { seal, lastFour } from "@/lib/secret-box";
import { describeWriteFailure } from "@/lib/write-failure";
import { MODEL } from "@/lib/anthropic";

/**
 * Bring-your-own Anthropic key.
 *
 * WRITE-ONLY by construction. The plaintext is never read back for display —
 * not for the tenant, and not for the admin. What the UI shows is `last_four`,
 * stored alongside the ciphertext precisely so that rendering it never requires
 * decrypting anything.
 *
 * Being honest about the limit of that: the platform holds the encryption key
 * and the database, so this is a PRODUCT-SURFACE control, not a cryptographic
 * guarantee against the operator. The UI says so where the tenant can read it.
 */

export interface ApiKeyStatus {
  present: boolean;
  lastFour?: string;
  addedAt?: string;
  status?: string;
}

export async function getApiKeyStatus(): Promise<ApiKeyStatus & { error?: string }> {
  await requireActor();
  const tenantId = await resolveTenantId();
  const { data, error } = await rawQuery<{
    last_four: string;
    added_at: string;
    status: string;
  }>(
    `select last_four, added_at, status from tenant_api_keys where tenant_id = $1`,
    [tenantId],
    tenantId
  );
  const described = describeWriteFailure(
    error ? error.message : undefined,
    "check your API key"
  );
  if (described !== undefined) return { present: false, error: described };
  if (data.length === 0) return { present: false };
  return {
    present: true,
    lastFour: data[0].last_four,
    addedAt: data[0].added_at,
    status: data[0].status,
  };
}

/**
 * Store a key, after proving it works.
 *
 * Verified with the cheapest possible call — one token — because storing a key
 * that does not work means every search silently fails later with an error the
 * tenant cannot connect to what they typed.
 *
 * Rate-limited per tenant. Without a limit this endpoint is an Anthropic
 * key-validation ORACLE: submit stolen keys, read "works" or "does not". One
 * attempt per minute makes it useless for that while remaining invisible to
 * someone pasting their own key once.
 */
export async function saveApiKey(key: string): Promise<{ error?: string }> {
  await requireActor();
  const tenantId = await resolveTenantId();
  const trimmed = key.trim();

  if (!trimmed.startsWith("sk-ant-")) {
    return { error: "That does not look like an Anthropic API key (they start with sk-ant-)." };
  }

  const { data: recent } = await rawQuery<{ recent: boolean }>(
    `select (last_verified_at > now() - interval '1 minute') as recent
       from tenant_api_keys where tenant_id = $1`,
    [tenantId],
    tenantId
  );
  if (recent[0]?.recent) {
    return { error: "Please wait a minute before trying another key." };
  }

  try {
    await new Anthropic({ apiKey: trimmed }).messages.create({
      model: MODEL,
      max_tokens: 1,
      messages: [{ role: "user", content: "hi" }],
    });
  } catch {
    // A closed-set message. The SDK's error text embeds request URLs and
    // sometimes the key itself, and this string is rendered to a browser.
    return { error: "Anthropic rejected that key. Check it and try again." };
  }

  const sealed = seal(trimmed, { tenantId, provider: "anthropic", model: null });
  const { error } = await rawQuery(
    `insert into tenant_api_keys
       (tenant_id, key_id, ciphertext, nonce, auth_tag, last_four, status, last_verified_at, aad_version)
     values ($1, $2, $3, $4, $5, $6, 'ok', now(), $7)
     on conflict (tenant_id) do update
       set key_id = excluded.key_id,
           ciphertext = excluded.ciphertext,
           nonce = excluded.nonce,
           auth_tag = excluded.auth_tag,
           last_four = excluded.last_four,
           status = 'ok',
           last_verified_at = now(),
           aad_version = excluded.aad_version`,
    [tenantId, sealed.keyId, sealed.ciphertext, sealed.nonce, sealed.authTag, lastFour(trimmed), sealed.aadVersion],
    tenantId
  );
  const described = describeWriteFailure(
    error ? error.message : undefined,
    "save your API key"
  );
  return described !== undefined ? { error: described } : {};
}

export async function removeApiKey(): Promise<{ error?: string }> {
  await requireActor();
  const tenantId = await resolveTenantId();
  const { error } = await rawQuery(
    `delete from tenant_api_keys where tenant_id = $1`,
    [tenantId],
    tenantId
  );
  const described = describeWriteFailure(
    error ? error.message : undefined,
    "remove your API key"
  );
  return described !== undefined ? { error: described } : {};
}
