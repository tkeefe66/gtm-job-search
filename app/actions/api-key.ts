"use server";

import { requireActor } from "@/lib/require-actor";
import { resolveTenantId } from "@/lib/tenant";
import { rawQuery } from "@/lib/supabase";
import { seal, lastFour } from "@/lib/secret-box";
import { describeWriteFailure } from "@/lib/write-failure";
import { providerFor } from "@/lib/providers/registry";

/**
 * Step 1 ships one provider, so this is a constant rather than an argument.
 * It is stored, bound into the AAD, and read back by lib/metered.ts, so adding
 * a second one later is a form field — not a migration and not a re-seal.
 */
const PROVIDER = "anthropic";

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
  provider?: string;
  model?: string | null;
}

export async function getApiKeyStatus(): Promise<ApiKeyStatus & { error?: string }> {
  await requireActor();
  const tenantId = await resolveTenantId();
  const { data, error } = await rawQuery<{
    last_four: string;
    added_at: string;
    status: string;
    provider: string;
    model: string | null;
  }>(
    `select last_four, added_at, status, provider, model from tenant_api_keys where tenant_id = $1`,
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
    provider: data[0].provider,
    model: data[0].model,
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
export async function saveApiKey(
  key: string,
  opts: { model?: string } = {}
): Promise<{ error?: string }> {
  await requireActor();
  const tenantId = await resolveTenantId();
  const trimmed = key.trim();
  const model = opts.model?.trim() || null;

  const { data: recent } = await rawQuery<{ recent: boolean }>(
    `select (last_verified_at > now() - interval '1 minute') as recent
       from tenant_api_keys where tenant_id = $1`,
    [tenantId],
    tenantId
  );
  if (recent[0]?.recent) {
    return { error: "Please wait a minute before trying another key." };
  }

  const provider = providerFor(PROVIDER);

  // The model the key will ACTUALLY run on — `null` means "the provider's
  // default", so that is what gets probed. Validating against the default
  // while storing something else proves nothing.
  const probeModel = model ?? provider.defaultModel;

  // A model this provider cannot PRICE must not be storable, and the check is
  // here rather than at spend time because the meter is the owner's only
  // runaway protection and the owner is the one holding the text box. An
  // unpriced model is metered at the default model's rate — for a 5x model
  // that records a fifth of real spend, passes both ceilings at ~5x the
  // intended dollars, and renders a per-run estimate wrong by the same factor.
  // `anthropicPrice`'s fallback stays as the last-resort guard it is; this gate
  // is what makes it unreachable from the save path.
  //
  // Before validateKey deliberately: it costs nothing and needs no network.
  if (!provider.pricedModels.includes(probeModel)) {
    return {
      error:
        `This app can only meter spend on models it has a price for. ` +
        `Choose one of: ${provider.pricedModels.join(", ")}.`,
    };
  }

  // The adapter owns both checks: the shape of its keys and whether the vendor
  // accepts this one on this model. What comes back is a REASON, never the
  // SDK's text — that embeds request URLs and sometimes the key itself, and
  // this string is rendered to a browser.
  const verdict = await provider.validateKey(trimmed, probeModel);
  if (!verdict.ok) {
    return {
      error:
        verdict.reason === "format"
          ? "That does not look like an Anthropic API key (they start with sk-ant-)."
          : `Anthropic rejected that key on ${probeModel}. Check both the key and the model, then try again.`,
    };
  }

  const sealed = seal(trimmed, { tenantId, provider: PROVIDER, model });
  const { error } = await rawQuery(
    `insert into tenant_api_keys
       (tenant_id, key_id, aad_version, ciphertext, nonce, auth_tag, last_four,
        provider, model, status, last_verified_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'ok', now())
     on conflict (tenant_id) do update
       set key_id = excluded.key_id,
           aad_version = excluded.aad_version,
           ciphertext = excluded.ciphertext,
           nonce = excluded.nonce,
           auth_tag = excluded.auth_tag,
           last_four = excluded.last_four,
           provider = excluded.provider,
           model = excluded.model,
           status = 'ok',
           last_verified_at = now()`,
    [tenantId, sealed.keyId, sealed.aadVersion, sealed.ciphertext, sealed.nonce,
     sealed.authTag, lastFour(trimmed), PROVIDER, model],
    tenantId
  );
  const described = describeWriteFailure(error ? error.message : undefined, "save your API key");
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
