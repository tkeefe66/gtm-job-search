# Provider registry (step 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route every model call in the app through a `Provider` interface resolved per tenant, with Anthropic as the sole implementation — so that adding a second provider later is an adapter, not a refactor.

**Architecture:** A stateless adapter per provider (`lib/providers/`) exposing `complete` / `searchAndComplete` / `costCents` / `validateKey`. A registry maps a `ProviderId` to its adapter. `BillingScope` (already ambient via `AsyncLocalStorage`) carries the resolved `provider` and `model` alongside the key, so the three-levels-deep `scoreFit` call inside `ingestRoles`' `Promise.all` reaches them without threading a parameter through every signature. `lib/anthropic.ts` becomes `lib/model-call.ts` — a provider-neutral facade over the registry that keeps the existing `callWithWebSearch` / `callStructured` call sites unchanged.

**Tech Stack:** Next.js 14 App Router, TypeScript, Postgres via `lib/supabase.ts`, `@anthropic-ai/sdk` 0.32.1, vitest.

**Spec:** `docs/superpowers/specs/2026-08-17-model-agnostic-design.md` (revision 2, approved for planning). Also read `docs/superpowers/2026-08-17-provider-registry-handoff.md` for the ground state and the traps.

## Global Constraints

- **Step 1 only.** Do not write an OpenAI or Google adapter. `providerFor("openai")` must throw a named error, and a test pins that it does.
- **The gate is `npm run build && npm test`.** `npm run lint` is non-functional in this repo — never add it to the gate. `npm run build` includes the typecheck.
- **Errors are `{ error?: string }` and the string can be EMPTY.** Branch on presence (`!== undefined`), never truthiness. Read `.claude/skills/swallowed-string-errors` before writing any action or any `if (res.error)`. Transports keep the driver's message verbatim, empty included.
- **A failure that is NOT the database substitutes its own fallback at the catch** — `UNDESCRIBED_DB_ERROR` names the database and would be a false sentence for a model or parse failure.
- **SDK error text must never reach the browser.** `saveApiKey`'s existing comment is the rule: the SDK's error strings embed request URLs and sometimes the key itself. Every user-visible message here is a closed set written by us.
- **`"use server"` forbids non-async exports.** Nothing in `app/actions/*.ts` can be exported pure or reached from a test. Pure logic goes in `lib/`.
- **767 tests pass on `main` at `617b546`.** Any red test after a task is that task's fault; do not proceed past a red gate.
- **Deploy order is load-bearing.** The migration must be applied to the production database BEFORE the code that reads the new columns is pushed, because `web` autodeploys from GitHub `main` on push. Task 8 covers this; do not push earlier tasks to `main` mid-plan unless the migration has already run.
- **Model prices, verbatim:** `claude-sonnet-4-6` is $3.00 / MTok input, $15.00 / MTok output, $0.30 / MTok cached read, $3.75 / MTok cache write. `web_search` is $10 per 1,000 searches = 1 cent each. These already appear as `3`/`15` in `lib/metered.ts:238`, as `DOLLARS_PER_INPUT_TOKEN` in `lib/cost-estimate.ts:6`, and as `CENTS_PER_SEARCH` in `lib/budget.ts:28`. After this plan there is exactly one copy.

---

## File Structure

**Created**

| File | Responsibility |
|---|---|
| `db/migrations/007_provider_routing.sql` | `provider`, `model`, `aad_version` on `tenant_api_keys` |
| `lib/providers/types.ts` | `Provider`, `Usage`, `Completion`, `ProviderId`, `KeyVerdict`. Pure types + `mustRefuseSearch`. No SDK import. |
| `lib/providers/anthropic-pricing.ts` | The single Anthropic price table and `anthropicCostCents`. Pure — **must not import the SDK**, because `lib/cost-estimate.ts` reaches it from a client component. |
| `lib/providers/anthropic.ts` | The adapter. Owns the SDK, the `web_search` tool shape, the `server_tool_use` block guard, and `report()` to coach-web. |
| `lib/providers/registry.ts` | `providerFor(id)`. Throws a named error for a provider that is not implemented. |
| `lib/providers/resolution.ts` | Pure: a stored key row → `{ providerId, model }`, or null when it cannot be routed. |
| `lib/model-call.ts` | The provider-neutral facade: `callWithWebSearch`, `callStructured`, `complete`, `parseJson`. Replaces `lib/anthropic.ts`. |
| `lib/providers/types.test.ts`, `lib/providers/anthropic-pricing.test.ts`, `lib/providers/anthropic.test.ts`, `lib/providers/registry.test.ts`, `lib/providers/resolution.test.ts` | Their units. |

**Modified**

| File | Change |
|---|---|
| `lib/secret-box.ts` | AAD becomes `{ tenantId, provider, model }` with a per-row version; v1 rows keep opening |
| `lib/billing-context.ts` | `BillingScope` gains `provider`, `model`, `cachedInputTokens` |
| `lib/metered.ts` | Resolves provider+model with the key; reconciles through `provider.costCents`; catches the search refusal |
| `lib/budget.ts` | `reserveVerdict` takes `centsPerSearch` instead of importing the constant |
| `lib/cost-estimate.ts` | Reads the shared price table |
| `app/actions/parse-role.ts` | `scoreFit` drops the raw SDK for the facade |
| `app/actions/api-key.ts` | Validation via `provider.validateKey`; stores provider + model |
| `components/ApiKeyPanel.tsx` | Optional model field; shows the stored provider and model |
| `lib/crawler.ts`, `app/actions/{roles,discover,role-search,parse-role}.ts` | Import path only, `@/lib/anthropic` → `@/lib/model-call` |
| `app/actions/{roles,parse-role}.test.ts` | Mock the new module path and shape |
| `lib/budget.test.ts`, `lib/secret-box.test.ts` | Updated for the new signatures |

**Deleted**

- `lib/anthropic.ts` (renamed to `lib/model-call.ts`; `export const MODEL` and `clientFor` do not survive the move)

---

### Task 1: Provider routing columns and versioned AAD

The spec requires `provider` and `model` bound into the AEAD's additional authenticated data alongside `tenant_id`, "or the routing config can be swapped independently of the ciphertext it routes."

Two consequences, both deliberate:

1. **Existing sealed rows were bound to `tenantId` alone and would stop opening.** A failed open returns null, which `loadTenantKey` reads as "no usable key", which resolves the tenant to tier `none` — a silent, total loss of every stored key with a plausible-looking "add a key" screen in front of it. So the AAD carries a **version per row**: v1 is `tenantId`, v2 is `tenantId|provider|model`. Old rows keep opening under v1; every new seal writes v2.
2. **Changing the model re-seals the key**, and the plaintext is never read back, so the tenant must paste the key again. That is the honest cost of binding it. Task 6's UI says so in words.

**Files:**
- Create: `db/migrations/007_provider_routing.sql`
- Modify: `lib/secret-box.ts`
- Test: `lib/secret-box.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `interface Aad { tenantId: string; provider: string; model: string | null }`
  - `const CURRENT_AAD_VERSION = 2`
  - `seal(plaintext: string, aad: Aad): SealedSecret` where `SealedSecret` gains `aadVersion: number`
  - `open(sealed: SealedSecret, aad: Aad): string | null`
  - Table `tenant_api_keys` gains `provider text not null default 'anthropic'`, `model text` (nullable), `aad_version smallint not null default 1`.

- [ ] **Step 1: Write the failing tests**

Add to `lib/secret-box.test.ts`:

```ts
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
```

`sealV1ForTest` is a test-local helper — put it at the top of the same file:

```ts
import { createCipheriv, randomBytes } from "node:crypto";

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
```

Also update the existing tests in that file: every `seal(x, "tenant-a")` becomes `seal(x, { tenantId: "tenant-a", provider: "anthropic", model: null })`, and the same for `open`. The existing test "a row copied to another tenant will not open" stays — it is still the primary property.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run lib/secret-box.test.ts`
Expected: FAIL — `seal` currently takes a string, so TypeScript rejects the object argument and `sealed.aadVersion` does not exist.

- [ ] **Step 3: Implement the versioned AAD**

In `lib/secret-box.ts`, replace the `seal`/`open` pair. Keep the existing file header comment and add the fifth decision to it:

```ts
/**
 * 5. The AAD is VERSIONED, per row. Binding `provider` and `model` into it (so
 *    the routing config cannot be swapped independently of the ciphertext it
 *    routes) changes the AAD of every row written before that binding existed.
 *    Those rows would stop opening, and a failed open is indistinguishable from
 *    "this tenant stored no key" — a total, silent loss behind a plausible
 *    screen. So each row records which AAD it was sealed under.
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

export const CURRENT_KEY_ID = "v1";
export const CURRENT_AAD_VERSION = 2;

function aadBytes(version: number, aad: Aad): Buffer {
  // v1: the tenant alone, as written before migration 007.
  if (version === 1) return Buffer.from(aad.tenantId, "utf8");
  return Buffer.from(`${aad.tenantId}|${aad.provider}|${aad.model ?? ""}`, "utf8");
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

export function open(sealed: SealedSecret, aad: Aad): string | null {
  try {
    const decipher = createDecipheriv("aes-256-gcm", keyBytes(), Buffer.from(sealed.nonce, "base64"));
    decipher.setAAD(aadBytes(sealed.aadVersion, aad));
    decipher.setAuthTag(Buffer.from(sealed.authTag, "base64"));
    return Buffer.concat([
      decipher.update(Buffer.from(sealed.ciphertext, "base64")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run lib/secret-box.test.ts`
Expected: PASS, all cases including the pre-existing ones.

- [ ] **Step 5: Write the migration**

Create `db/migrations/007_provider_routing.sql`:

```sql
-- Provider routing for a tenant's stored key.
--
-- provider and model are bound into the AEAD's additional authenticated data
-- (lib/secret-box.ts) alongside tenant_id, so the routing config cannot be
-- swapped independently of the ciphertext it routes: flipping this row's
-- provider to another vendor would otherwise send this tenant's decrypted key
-- to that vendor.
--
-- aad_version exists because that binding changes the AAD of every row written
-- before it. Rows already stored were sealed against tenant_id alone; they keep
-- their version 1 and keep opening. Every new seal writes version 2.
alter table tenant_api_keys add column if not exists provider    text not null default 'anthropic';
alter table tenant_api_keys add column if not exists model       text;
alter table tenant_api_keys add column if not exists aad_version smallint not null default 1;

-- Defence in depth behind lib/providers/registry.ts: a value that cannot be
-- routed must not be storable in the first place.
alter table tenant_api_keys drop constraint if exists tenant_api_keys_provider_check;
alter table tenant_api_keys add  constraint tenant_api_keys_provider_check
  check (provider in ('anthropic', 'openai', 'google'));
```

- [ ] **Step 6: Verify the migration is well-formed without touching production**

Run: `node db/migrate.mjs --dry`
Expected: lists `007_provider_routing.sql` as pending and touches nothing. If it cannot reach a database, that is fine for this step — the file being picked up by the runner is what is being checked. It is applied for real in Task 8, after a backup.

- [ ] **Step 7: Run the full gate**

Run: `npm run build && npm test`
Expected: build succeeds; tests fail in `lib/metered.ts` / `app/actions/api-key.ts` compile only if those call `seal`/`open` with the old signature — fix those two call sites now by passing `{ tenantId, provider: "anthropic", model: null }`, which is exactly what they mean today. Tasks 3 and 6 replace those literals with resolved values.

- [ ] **Step 8: Commit**

```bash
git add db/migrations/007_provider_routing.sql lib/secret-box.ts lib/secret-box.test.ts lib/metered.ts app/actions/api-key.ts
git commit -m "feat: bind provider and model into the key's AAD, versioned so old rows still open"
```

---

### Task 2: The Provider interface and the Anthropic adapter

**Files:**
- Create: `lib/providers/types.ts`, `lib/providers/anthropic-pricing.ts`, `lib/providers/anthropic.ts`, `lib/providers/registry.ts`
- Test: `lib/providers/types.test.ts`, `lib/providers/anthropic-pricing.test.ts`, `lib/providers/anthropic.test.ts`, `lib/providers/registry.test.ts`

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces:
  - `type ProviderId = "anthropic" | "openai" | "google"`
  - `interface Usage { inputTokens: number; cachedInputTokens: number; outputTokens: number; searches: number }`
  - `interface Completion { text: string; usage: Usage }`
  - `type KeyVerdict = { ok: true } | { ok: false; reason: "format" | "rejected" }`
  - `interface Provider` with `id`, `defaultModel`, `searchCapEnforcement`, `complete`, `searchAndComplete`, `costCents`, `validateKey`
  - `function mustRefuseSearch(enforcement: SearchCapEnforcement, maxSearches: number | null): boolean`
  - `function providerFor(id: string): Provider` — throws `ProviderNotImplementedError`
  - `const ANTHROPIC_PRICES`, `function anthropicCostCents(usage: Usage, model: string): number`, `const CENTS_PER_SEARCH_ANTHROPIC = 1`

- [ ] **Step 1: Write the failing tests**

Create `lib/providers/types.test.ts`:

```ts
import { describe, expect, test } from "vitest";
import { mustRefuseSearch } from "./types";

// The spec: "On a provider reporting `none`, a metered tier's search calls are
// REFUSED, not silently uncapped — the admin daily cap is runaway protection
// and must not degrade to a pre-call check."
describe("mustRefuseSearch", () => {
  test("a metered call on a provider that cannot cap in-request is refused", () => {
    expect(mustRefuseSearch("none", 12)).toBe(true);
  });

  test("an uncapped (BYO) call is allowed even when the provider cannot cap", () => {
    // Null is BYO: the tenant spends their own money and is recorded, not rationed.
    expect(mustRefuseSearch("none", null)).toBe(false);
  });

  test("a provider that caps in-request is never refused", () => {
    expect(mustRefuseSearch("in-request", 12)).toBe(false);
    expect(mustRefuseSearch("in-request", null)).toBe(false);
  });

  test("a cap of zero is still a cap, and still refused on a provider that cannot enforce it", () => {
    expect(mustRefuseSearch("none", 0)).toBe(true);
  });
});
```

Create `lib/providers/anthropic-pricing.test.ts`:

```ts
import { describe, expect, test } from "vitest";
import { anthropicCostCents, ANTHROPIC_PRICES } from "./anthropic-pricing";

const none = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, searches: 0 };

describe("anthropicCostCents", () => {
  test("prices tokens at the model's own rate, not a shared constant", () => {
    // 1M input at $3 = 300c; 1M output at $15 = 1500c.
    const cents = anthropicCostCents(
      { ...none, inputTokens: 1_000_000, outputTokens: 1_000_000 },
      "claude-sonnet-4-6"
    );
    expect(cents).toBe(1800);
  });

  test("cached input is priced separately and far cheaper than fresh input", () => {
    const fresh = anthropicCostCents({ ...none, inputTokens: 1_000_000 }, "claude-sonnet-4-6");
    const cached = anthropicCostCents({ ...none, cachedInputTokens: 1_000_000 }, "claude-sonnet-4-6");
    expect(fresh).toBe(300);
    expect(cached).toBe(30);
  });

  test("searches are a cent each and are invisible to token usage", () => {
    expect(anthropicCostCents({ ...none, searches: 7 }, "claude-sonnet-4-6")).toBe(7);
  });

  // An unpriced model must not silently cost zero — that reads as a free call
  // and would let a runaway pass every ceiling.
  test("an unknown model falls back to the default model's price rather than zero", () => {
    const known = anthropicCostCents({ ...none, inputTokens: 1_000_000 }, "claude-sonnet-4-6");
    expect(anthropicCostCents({ ...none, inputTokens: 1_000_000 }, "claude-fictional-9")).toBe(known);
  });

  test("the default model is priced", () => {
    expect(ANTHROPIC_PRICES["claude-sonnet-4-6"]).toBeDefined();
  });
});
```

Create `lib/providers/registry.test.ts`:

```ts
import { describe, expect, test } from "vitest";
import { providerFor, ProviderNotImplementedError } from "./registry";

describe("providerFor", () => {
  test("resolves anthropic", () => {
    expect(providerFor("anthropic").id).toBe("anthropic");
  });

  // Step 1 ships one provider. A stored row naming another one must fail loudly
  // at the routing decision, not fall back to Anthropic and bill the wrong key.
  test("a provider that is not implemented throws rather than falling back", () => {
    expect(() => providerFor("openai")).toThrow(ProviderNotImplementedError);
  });

  test("an unrecognised string throws too", () => {
    expect(() => providerFor("not-a-provider")).toThrow(ProviderNotImplementedError);
  });
});
```

Create `lib/providers/anthropic.test.ts` — this one injects a fake SDK client, so no network:

```ts
import { describe, expect, test, vi } from "vitest";
import { createAnthropicProvider } from "./anthropic";

function fakeClient(response: unknown) {
  const create = vi.fn().mockResolvedValue(response);
  return { create, factory: () => ({ messages: { create } }) };
}

const textOnly = {
  content: [{ type: "text", text: "hello" }],
  usage: { input_tokens: 100, output_tokens: 20 },
};

describe("the Anthropic adapter", () => {
  test("complete returns the concatenated text and normalised usage", async () => {
    const { factory } = fakeClient(textOnly);
    const p = createAnthropicProvider({ createClient: factory });

    const out = await p.complete({
      apiKey: "sk-ant-x", model: "claude-sonnet-4-6",
      system: "s", prompt: "p", maxTokens: 500,
    });

    expect(out.text).toBe("hello");
    expect(out.usage).toEqual({
      inputTokens: 100, cachedInputTokens: 0, outputTokens: 20, searches: 0,
    });
  });

  // The normalisation the spec calls out: Anthropic's input_tokens EXCLUDES
  // cached tokens, OpenAI's prompt_tokens includes them. Renaming the field
  // would over- or under-count by exactly the cached portion.
  test("cached tokens are reported separately, and input_tokens is left excluding them", async () => {
    const { factory } = fakeClient({
      ...textOnly,
      usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 900 },
    });
    const p = createAnthropicProvider({ createClient: factory });

    const out = await p.complete({
      apiKey: "sk-ant-x", model: "claude-sonnet-4-6", system: "s", prompt: "p", maxTokens: 500,
    });

    expect(out.usage.inputTokens).toBe(100);
    expect(out.usage.cachedInputTokens).toBe(900);
  });

  test("searchAndComplete counts the searches the model ISSUED, not the ones it was allowed", async () => {
    const { factory, create } = fakeClient({
      content: [
        { type: "server_tool_use", name: "web_search", input: { query: "a" } },
        { type: "server_tool_use", name: "web_search", input: { query: "b" } },
        { type: "text", text: "done" },
      ],
      usage: { input_tokens: 10, output_tokens: 5 },
    });
    const p = createAnthropicProvider({ createClient: factory });

    const out = await p.searchAndComplete({
      apiKey: "sk-ant-x", model: "claude-sonnet-4-6",
      system: "s", prompt: "p", maxTokens: 8000, maxSearches: 9,
    });

    expect(out.usage.searches).toBe(2);
    expect(create.mock.calls[0][0].tools[0].max_uses).toBe(9);
  });

  test("no maxSearches means the field is absent from the request, not zero", async () => {
    const { factory, create } = fakeClient(textOnly);
    const p = createAnthropicProvider({ createClient: factory });

    await p.searchAndComplete({
      apiKey: "sk-ant-x", model: "claude-sonnet-4-6", system: "s", prompt: "p", maxTokens: 8000,
    });

    expect(create.mock.calls[0][0].tools[0]).not.toHaveProperty("max_uses");
  });

  test("caps searches in-request, which is what makes a ceiling enforceable", () => {
    const p = createAnthropicProvider({ createClient: fakeClient(textOnly).factory });
    expect(p.searchCapEnforcement).toBe("in-request");
  });

  test("a key of the wrong shape is rejected on format, without a network call", async () => {
    const { factory, create } = fakeClient(textOnly);
    const p = createAnthropicProvider({ createClient: factory });

    expect(await p.validateKey("hunter2")).toEqual({ ok: false, reason: "format" });
    expect(create).not.toHaveBeenCalled();
  });

  test("a key the API rejects comes back as rejected, with no SDK text attached", async () => {
    const create = vi.fn().mockRejectedValue(new Error("401 https://api.anthropic.com key=sk-ant-leak"));
    const p = createAnthropicProvider({ createClient: () => ({ messages: { create } }) });

    const verdict = await p.validateKey("sk-ant-plausible");

    expect(verdict).toEqual({ ok: false, reason: "rejected" });
    expect(JSON.stringify(verdict)).not.toContain("sk-ant-leak");
  });

  test("a key the API accepts comes back ok", async () => {
    const p = createAnthropicProvider({ createClient: fakeClient(textOnly).factory });
    expect(await p.validateKey("sk-ant-plausible")).toEqual({ ok: true });
  });

  test("a json schema is sent as a forced tool, because constrained decoding is what makes weak models return parseable JSON", async () => {
    const { factory, create } = fakeClient({
      content: [{ type: "tool_use", name: "emit", input: { score: 4 } }],
      usage: { input_tokens: 10, output_tokens: 5 },
    });
    const p = createAnthropicProvider({ createClient: factory });

    const out = await p.complete({
      apiKey: "sk-ant-x", model: "claude-sonnet-4-6", system: "s", prompt: "p", maxTokens: 500,
      jsonSchema: { type: "object", properties: { score: { type: "number" } } },
    });

    expect(create.mock.calls[0][0].tool_choice).toEqual({ type: "tool", name: "emit" });
    expect(JSON.parse(out.text)).toEqual({ score: 4 });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run lib/providers/`
Expected: FAIL — none of these modules exist.

- [ ] **Step 3: Write `lib/providers/types.ts`**

```ts
/**
 * What the app needs from a model provider, and nothing more.
 *
 * Three fields here exist because a review found each of them missing, and each
 * one is a place where a second provider would otherwise be silently wrong:
 *
 * - `searchCapEnforcement`, because a ceiling is only enforceable INSIDE the
 *   request. web_search calls are billed per search and are invisible to token
 *   usage, so a pre-call check catches the next click, not this one.
 * - `costCents`, because Sonnet's $3/$15 was hardcoded in two places, one of
 *   them rendered to users. A GPT tenant would read Claude-priced fiction.
 * - `Usage`, normalised, because Anthropic's `input_tokens` EXCLUDES cached
 *   tokens and OpenAI's `prompt_tokens` includes them. Renaming the field would
 *   over- or under-count by exactly the cached portion.
 */

export type ProviderId = "anthropic" | "openai" | "google";

/** Whether a max-searches ceiling can be enforced inside the request itself. */
export type SearchCapEnforcement = "in-request" | "none";

export interface Usage {
  /** EXCLUDING cached input. Normalised across providers. */
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  /** Counted by the adapter from what the model ISSUED, never from the cap. */
  searches: number;
}

export interface Completion {
  text: string;
  usage: Usage;
}

export interface CallOpts {
  apiKey: string;
  model: string;
  system: string;
  prompt: string;
  maxTokens: number;
}

export interface CompleteOpts extends CallOpts {
  /** Constrained decoding. On the interface from the start: freezing the
   *  signature without it means rewriting every adapter later. */
  jsonSchema?: Record<string, unknown>;
}

export interface SearchOpts extends CallOpts {
  maxSearches?: number;
}

/**
 * Why a key was refused. A REASON, not a message: the message is UI copy and
 * lives with the action, because SDK error text embeds request URLs and
 * sometimes the key itself and must never reach a browser.
 */
export type KeyVerdict = { ok: true } | { ok: false; reason: "format" | "rejected" };

export interface Provider {
  id: ProviderId;
  defaultModel: string;
  searchCapEnforcement: SearchCapEnforcement;
  complete(opts: CompleteOpts): Promise<Completion>;
  searchAndComplete(opts: SearchOpts): Promise<Completion>;
  /** Cost in cents, per provider AND resolved model. Never a shared constant. */
  costCents(usage: Usage, model: string): number;
  validateKey(key: string): Promise<KeyVerdict>;
}

/**
 * A metered call on a provider that cannot cap searches inside the request is
 * REFUSED, not run uncapped.
 *
 * `maxSearches` is null only for BYO, who spend their own money and are recorded
 * rather than rationed. Any number means a ceiling is in force, and a ceiling
 * that cannot be enforced in-request is not a ceiling — search billing is
 * invisible to token usage, so nothing downstream would notice it being blown.
 */
export function mustRefuseSearch(
  enforcement: SearchCapEnforcement,
  maxSearches: number | null
): boolean {
  return enforcement === "none" && maxSearches !== null;
}
```

- [ ] **Step 4: Write `lib/providers/anthropic-pricing.ts`**

```ts
import type { Usage } from "./types";

/**
 * The ONE Anthropic price table.
 *
 * Deliberately free of any SDK import: lib/cost-estimate.ts reads this and is
 * reached from components/Settings.tsx, a client component. Pulling the SDK in
 * here would drag it into the browser bundle.
 *
 * Dollars per million tokens, as published.
 */
export const ANTHROPIC_PRICES: Record<
  string,
  { input: number; cachedInput: number; output: number }
> = {
  "claude-sonnet-4-6": { input: 3, cachedInput: 0.3, output: 15 },
};

export const ANTHROPIC_DEFAULT_MODEL = "claude-sonnet-4-6";

/** web_search server tool: $10 per 1,000 searches. */
export const ANTHROPIC_CENTS_PER_SEARCH = 1;

/**
 * An unpriced model falls back to the default model's price rather than zero.
 * Zero would read as a free call and let a runaway pass every ceiling — the
 * exact failure the daily cap exists to prevent.
 */
export function anthropicPrice(model: string) {
  return ANTHROPIC_PRICES[model] ?? ANTHROPIC_PRICES[ANTHROPIC_DEFAULT_MODEL];
}

export function anthropicCostCents(usage: Usage, model: string): number {
  const p = anthropicPrice(model);
  const tokenDollars =
    (usage.inputTokens * p.input +
      usage.cachedInputTokens * p.cachedInput +
      usage.outputTokens * p.output) /
    1_000_000;
  return Math.round(tokenDollars * 100) + usage.searches * ANTHROPIC_CENTS_PER_SEARCH;
}
```

- [ ] **Step 5: Write `lib/providers/anthropic.ts`**

Move the `server_tool_use` structural guard and the `web_search` tool cast out of `lib/anthropic.ts` verbatim — including their comments, which record why they are hand-written rather than typed.

```ts
import Anthropic from "@anthropic-ai/sdk";
import { report } from "../usage.js";
import { ANTHROPIC_DEFAULT_MODEL, anthropicCostCents } from "./anthropic-pricing";
import type { Completion, CompleteOpts, KeyVerdict, Provider, SearchOpts, Usage } from "./types";

// The installed @anthropic-ai/sdk's ContentBlock union (TextBlock | ToolUseBlock)
// predates the web_search server tool and has no type for the `server_tool_use`
// blocks the API actually returns. There is no SDK type to import, so this is a
// hand-written structural guard rather than a cast to `any` — it only reads
// fields it has checked exist, and a block that doesn't match falls through.
interface WebSearchUseBlock {
  type: "server_tool_use";
  name: "web_search";
  input: { query?: unknown };
}

function isWebSearchUseBlock(block: unknown): block is WebSearchUseBlock {
  if (typeof block !== "object" || block === null) return false;
  const b = block as { type?: unknown; name?: unknown };
  return b.type === "server_tool_use" && b.name === "web_search";
}

interface RawUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

/**
 * Anthropic's `input_tokens` already EXCLUDES cached reads, so it maps straight
 * across. Cache CREATION is charged as (more expensive) fresh input, so it is
 * added to inputTokens rather than to cachedInputTokens — putting it in the
 * cached bucket would under-price it by 12x.
 */
function normaliseUsage(raw: RawUsage | undefined, searches: number): Usage {
  return {
    inputTokens: (raw?.input_tokens ?? 0) + (raw?.cache_creation_input_tokens ?? 0),
    cachedInputTokens: raw?.cache_read_input_tokens ?? 0,
    outputTokens: raw?.output_tokens ?? 0,
    searches,
  };
}

function textOf(content: unknown[]): string {
  return content
    .filter((b): b is { type: "text"; text: string } =>
      typeof b === "object" && b !== null && (b as { type?: unknown }).type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
}

/** The injected seam is what lets the adapter be tested without a network. */
export interface AnthropicDeps {
  createClient?: (apiKey: string) => { messages: { create: (body: unknown) => Promise<unknown> } };
}

export function createAnthropicProvider(deps: AnthropicDeps = {}): Provider {
  const createClient =
    deps.createClient ??
    ((apiKey: string) =>
      new Anthropic({ apiKey }) as unknown as {
        messages: { create: (body: unknown) => Promise<unknown> };
      });

  return {
    id: "anthropic",
    defaultModel: ANTHROPIC_DEFAULT_MODEL,
    searchCapEnforcement: "in-request",

    costCents: anthropicCostCents,

    async complete(opts: CompleteOpts): Promise<Completion> {
      const body: Record<string, unknown> = {
        model: opts.model,
        max_tokens: opts.maxTokens,
        system: opts.system,
        messages: [{ role: "user", content: opts.prompt }],
      };
      if (opts.jsonSchema) {
        // Constrained decoding, expressed the way this SDK version allows: a
        // single tool the model is FORCED to call. The tool input is the JSON.
        body.tools = [{ name: "emit", description: "Return the result.", input_schema: opts.jsonSchema }];
        body.tool_choice = { type: "tool", name: "emit" };
      }

      const message = (await createClient(opts.apiKey).messages.create(body)) as {
        content: unknown[];
        usage?: RawUsage;
      };
      report("gtm-job-search", opts.model, message.usage);

      const toolBlock = opts.jsonSchema
        ? (message.content.find(
            (b) => typeof b === "object" && b !== null && (b as { type?: unknown }).type === "tool_use"
          ) as { input?: unknown } | undefined)
        : undefined;

      return {
        text: toolBlock ? JSON.stringify(toolBlock.input) : textOf(message.content),
        usage: normaliseUsage(message.usage, 0),
      };
    },

    async searchAndComplete(opts: SearchOpts): Promise<Completion> {
      // The same force-cast as before, and for the same reason: the installed
      // SDK (0.32.1) has no type for the web_search server tool at all, so
      // neither the `type` discriminator nor `max_uses` is expressible against
      // Anthropic.Tool. Built as a plain literal so its shape is still checked
      // internally, then cast once at the boundary.
      const webSearchTool = {
        type: "web_search_20250305",
        name: "web_search",
        ...(opts.maxSearches !== undefined ? { max_uses: opts.maxSearches } : {}),
      };

      const message = (await createClient(opts.apiKey).messages.create({
        model: opts.model,
        max_tokens: opts.maxTokens,
        system: opts.system,
        tools: [webSearchTool],
        messages: [{ role: "user", content: opts.prompt }],
      })) as { content: unknown[]; usage?: RawUsage };

      report("gtm-job-search", opts.model, message.usage);

      const issued = message.content.filter(isWebSearchUseBlock);

      // Logging side-channel: which searches the model actually issued, as
      // opposed to which ones it was offered. Never let this break the call.
      try {
        if (issued.length > 0) {
          const queries = issued.map((b) =>
            typeof b.input?.query === "string" ? b.input.query : JSON.stringify(b.input)
          );
          console.log(`anthropic.searchAndComplete: issued ${issued.length} searches — ${queries.join(" | ")}`);
        }
      } catch (err) {
        console.error("anthropic.searchAndComplete: failed to log issued searches —", err);
      }

      return { text: textOf(message.content), usage: normaliseUsage(message.usage, issued.length) };
    },

    async validateKey(key: string): Promise<KeyVerdict> {
      if (!key.startsWith("sk-ant-")) return { ok: false, reason: "format" };
      try {
        // The cheapest possible call — one token. Storing a key that does not
        // work means every search fails later with an error the tenant cannot
        // connect to what they typed.
        await createClient(key).messages.create({
          model: ANTHROPIC_DEFAULT_MODEL,
          max_tokens: 1,
          messages: [{ role: "user", content: "hi" }],
        });
        return { ok: true };
      } catch {
        // Deliberately drops the SDK's text: it embeds request URLs and
        // sometimes the key itself, and the caller renders this to a browser.
        return { ok: false, reason: "rejected" };
      }
    },
  };
}
```

Note the import list: `ANTHROPIC_CENTS_PER_SEARCH` is *not* imported here — the adapter's search price reaches callers only through `costCents`, so there is no second name for it to drift from.

- [ ] **Step 6: Write `lib/providers/registry.ts`**

```ts
import { createAnthropicProvider } from "./anthropic";
import type { Provider, ProviderId } from "./types";

export class ProviderNotImplementedError extends Error {
  constructor(id: string) {
    super(`No adapter for provider "${id}".`);
    this.name = "ProviderNotImplementedError";
  }
}

/**
 * One instance per provider. The adapters are stateless — key and model arrive
 * per call — so a shared instance cannot leak one tenant's key into another's
 * request, which is the race the old mutated-singleton client had.
 */
const PROVIDERS: Partial<Record<ProviderId, Provider>> = {
  anthropic: createAnthropicProvider(),
};

/**
 * Throws rather than falling back. A stored row naming a provider this build
 * cannot serve is a routing failure; resolving it to Anthropic anyway would
 * send that tenant's key, and their bill, to a vendor they did not choose.
 */
export function providerFor(id: string): Provider {
  const p = PROVIDERS[id as ProviderId];
  if (!p) throw new ProviderNotImplementedError(id);
  return p;
}
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npx vitest run lib/providers/`
Expected: PASS — all of `types`, `anthropic-pricing`, `anthropic`, `registry`.

- [ ] **Step 8: Run the full gate and commit**

Run: `npm run build && npm test`
Expected: PASS. Nothing imports the new modules yet, so the count rises and nothing else moves.

```bash
git add lib/providers/
git commit -m "feat: a Provider interface, an Anthropic adapter behind it, and one price table"
```

---

### Task 3: Per-tenant provider resolution, and a meter that prices through the adapter

**Files:**
- Create: `lib/providers/resolution.ts`, `lib/providers/resolution.test.ts`
- Modify: `lib/billing-context.ts`, `lib/budget.ts`, `lib/metered.ts`
- Test: `lib/budget.test.ts` (existing, updated)

**Interfaces:**
- Consumes: `Usage`, `Provider`, `ProviderId` (Task 2); `providerFor` (Task 2); `Aad`, `open` (Task 1).
- Produces:
  - `BillingScope` gains `provider: ProviderId`, `model: string`, `cachedInputTokens: number`
  - `recordUsage` accepts `cachedInputTokens`
  - `resolveProviderConfig(row: StoredKeyRow | null): { providerId: ProviderId; model: string } | null`
  - `reserveVerdict(input: { …; centsPerSearch: number })`

- [ ] **Step 1: Write the failing resolution test**

Create `lib/providers/resolution.test.ts`:

```ts
import { describe, expect, test } from "vitest";
import { resolveProviderConfig } from "./resolution";

describe("resolveProviderConfig", () => {
  test("no stored row means the platform's own provider and model", () => {
    // Reached only on the admin branch: every other keyless tenant is refused
    // before this point, because there is no free tier.
    expect(resolveProviderConfig(null)).toEqual({
      providerId: "anthropic",
      model: "claude-sonnet-4-6",
    });
  });

  test("a stored row with no model gets the provider's default", () => {
    expect(resolveProviderConfig({ provider: "anthropic", model: null })).toEqual({
      providerId: "anthropic",
      model: "claude-sonnet-4-6",
    });
  });

  test("a stored model wins over the default", () => {
    expect(resolveProviderConfig({ provider: "anthropic", model: "claude-opus-4-1" })).toEqual({
      providerId: "anthropic",
      model: "claude-opus-4-1",
    });
  });

  // Defence behind the CHECK constraint in migration 007. A row this build
  // cannot route is "no usable key" — never a silent fallback to Anthropic,
  // which would bill a key the tenant chose for another vendor.
  test("a provider this build cannot serve resolves to null, not to Anthropic", () => {
    expect(resolveProviderConfig({ provider: "openai", model: null })).toBeNull();
    expect(resolveProviderConfig({ provider: "nonsense", model: null })).toBeNull();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run lib/providers/resolution.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `lib/providers/resolution.ts`**

```ts
import { providerFor } from "./registry";
import { ANTHROPIC_DEFAULT_MODEL } from "./anthropic-pricing";
import type { ProviderId } from "./types";

export interface StoredKeyRow {
  provider: string;
  model: string | null;
}

export interface ProviderConfig {
  providerId: ProviderId;
  model: string;
}

/**
 * Which provider and model a call should run against.
 *
 * Null means "this row cannot be routed by this build" — a stored provider with
 * no adapter. The caller must treat that exactly like a key that will not open:
 * no usable key. Falling back to Anthropic would send a tenant's OpenAI key to
 * Anthropic, and bill whoever's key resolved instead.
 */
export function resolveProviderConfig(row: StoredKeyRow | null): ProviderConfig | null {
  if (row === null) {
    return { providerId: "anthropic", model: ANTHROPIC_DEFAULT_MODEL };
  }
  try {
    const provider = providerFor(row.provider);
    return { providerId: provider.id, model: row.model ?? provider.defaultModel };
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run lib/providers/resolution.test.ts`
Expected: PASS.

- [ ] **Step 5: Widen `BillingScope`**

In `lib/billing-context.ts`, add three fields and extend `recordUsage`:

```ts
export interface BillingScope {
  /** Cap handed to every search tool in this scope. null = uncapped (BYO). */
  maxSearches: number | null;
  /** The key these calls bill. */
  apiKey: string;
  /** Which adapter routes these calls, and at which model. Resolved per tenant
   *  in lib/metered.ts, because a module-level constant cannot be a DB read. */
  provider: ProviderId;
  model: string;
  /** Accumulated, by the facade in lib/model-call.ts. */
  searches: number;
  inputTokens: number;
  /** Separate from inputTokens because providers disagree about whether their
   *  input count includes cached reads, and they are priced ~10x apart. */
  cachedInputTokens: number;
  outputTokens: number;
}
```

```ts
export function recordUsage(u: {
  searches?: number;
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
}): void {
  const s = store.getStore();
  if (!s) return;
  s.searches += u.searches ?? 0;
  s.inputTokens += u.inputTokens ?? 0;
  s.cachedInputTokens += u.cachedInputTokens ?? 0;
  s.outputTokens += u.outputTokens ?? 0;
}
```

Import `ProviderId` as a **type-only** import: `import type { ProviderId } from "@/lib/providers/types";`

- [ ] **Step 6: Make `reserveVerdict` take the price instead of importing it**

In `lib/budget.ts`, delete `export const CENTS_PER_SEARCH = 1` and add `centsPerSearch` to `reserveVerdict`'s input:

```ts
export function reserveVerdict(input: {
  tier: Tier;
  daily: Window;
  monthly: Window;
  estimateCents: number;
  /** From the resolved provider — searches are not a cents-per-unit constant
   *  shared across vendors, and a cap computed at the wrong price is not a cap. */
  centsPerSearch: number;
}): ReserveVerdict {
  …
  return { allow: true, maxSearches: Math.max(1, Math.floor(remaining / input.centsPerSearch)) };
}
```

In `lib/metered.ts`, drop `CENTS_PER_SEARCH` from the `@/lib/budget` import at line 7 — Step 7 replaces its only use, at line 237.

In `lib/budget.test.ts`, drop `CENTS_PER_SEARCH` from the import at line 12 and rewrite line 92's assertion as `expect(v.maxSearches).toBe(100)` (the test passes `centsPerSearch: 1`, so the arithmetic it was expressing is now literal). Add `centsPerSearch: 1` to every `reserveVerdict` call — they are all in the `describe("reserveVerdict")` block, lines 61–150 — and add one new test:

```ts
test("the cap is computed at the resolved provider's search price, not a fixed cent", () => {
  const v = reserveVerdict({
    tier: "admin",
    daily: { spentCents: 0, ceilingCents: 100 },
    monthly: { spentCents: 0, ceilingCents: 1000 },
    estimateCents: 1,
    centsPerSearch: 4,
  });
  expect(v).toEqual({ allow: true, maxSearches: 25 });
});
```

- [ ] **Step 7: Resolve provider and model in `lib/metered.ts`, and price through the adapter**

Change `loadTenantKey` to return the whole routing decision, and give `runScope` the provider:

```ts
interface TenantKey {
  apiKey: string;
  config: ProviderConfig;
}

/**
 * This tenant's key AND how to route it, or null.
 *
 * Null covers four cases that are all "no usable key": nothing stored, a row
 * that will not open, a key marked failed, and — new — a stored provider this
 * build has no adapter for. None may fall back to the platform key or to
 * Anthropic; either would bill somebody who believes they are paying their own
 * vendor.
 */
async function loadTenantKey(tenantId: string): Promise<TenantKey | null> {
  const { data } = await rawQuery<{
    key_id: string;
    aad_version: number;
    ciphertext: string;
    nonce: string;
    auth_tag: string;
    provider: string;
    model: string | null;
  }>(
    `select key_id, aad_version, ciphertext, nonce, auth_tag, provider, model
       from tenant_api_keys where tenant_id = $1 and status = 'ok'`,
    [tenantId],
    tenantId
  );
  if (data.length === 0) return null;
  const row = data[0];

  const config = resolveProviderConfig({ provider: row.provider, model: row.model });
  if (config === null) {
    console.error(`metered: a stored API key names a provider this build cannot route: ${row.provider}`);
    return null;
  }

  const plain = open(
    {
      keyId: row.key_id,
      aadVersion: row.aad_version,
      ciphertext: row.ciphertext,
      nonce: row.nonce,
      authTag: row.auth_tag,
    },
    { tenantId, provider: row.provider, model: row.model }
  );
  if (plain === null) {
    console.error(`metered: a stored API key for a tenant could not be opened`);
    return null;
  }
  return { apiKey: plain, config };
}
```

`withBudget` then reads `ownKey?.apiKey` where it read `ownKey`, and passes `ownKey?.config ?? resolveProviderConfig(null)!` down to `runScope`. Its `reserveVerdict` call gains `centsPerSearch: providerFor(config.providerId).costCents({ inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, searches: 1 }, config.model)` — one search, priced by the adapter, which is the definition of the number.

`runScope` builds the wider scope and reconciles through the adapter:

```ts
const provider = providerFor(config.providerId);
const scope: BillingScope = {
  maxSearches: caps.maxSearches,
  apiKey: ownKey ?? (tier === "admin" ? process.env.ANTHROPIC_API_KEY || "" : ""),
  provider: config.providerId,
  model: config.model,
  searches: 0,
  inputTokens: 0,
  cachedInputTokens: 0,
  outputTokens: 0,
};

try {
  const result = await runWithBilling(scope, opts.fn);
  return { result };
} catch (err) {
  // A search refused because this provider cannot cap uses in-request is a
  // REFUSAL, not a crash: the caller renders it as a sentence, the same way a
  // hit ceiling is rendered. Anything else propagates untouched.
  if (err instanceof SearchUnavailableError) return { capped: err.message };
  throw err;
} finally {
  const actual = provider.costCents(
    {
      inputTokens: scope.inputTokens,
      cachedInputTokens: scope.cachedInputTokens,
      outputTokens: scope.outputTokens,
      searches: scope.searches,
    },
    scope.model
  );
  await reconcileSpend({ …unchanged…, actualCents: actual });
}
```

`SearchUnavailableError` is defined in Task 4; if implementing tasks in order, add the import and the catch in Task 4 rather than leaving a dangling reference here.

- [ ] **Step 8: Run the gate**

Run: `npm run build && npm test`
Expected: PASS. `lib/budget.test.ts` covers the new `centsPerSearch`; nothing else changes behaviour, because `resolveProviderConfig(null)` reproduces exactly today's Anthropic + Sonnet routing.

- [ ] **Step 9: Commit**

```bash
git add lib/providers/resolution.ts lib/providers/resolution.test.ts lib/billing-context.ts lib/budget.ts lib/budget.test.ts lib/metered.ts
git commit -m "feat: resolve provider and model per tenant, and price the meter through the adapter"
```

---

### Task 4: The facade — `lib/anthropic.ts` becomes `lib/model-call.ts`

After this task the file contains no Anthropic specifics, so it must not keep the name. A file named for the vendor it no longer knows about is the kind of lie this codebase's comments exist to prevent.

**Files:**
- Create: `lib/model-call.ts`, `lib/model-call.test.ts`
- Delete: `lib/anthropic.ts`
- Modify: `lib/crawler.ts:1`, `app/actions/roles.ts:7`, `app/actions/discover.ts:7`, `app/actions/role-search.ts:7`, `app/actions/parse-role.ts:6`, `lib/metered.ts` (the catch from Task 3)
- Test: `app/actions/roles.test.ts:72,87`, `app/actions/parse-role.test.ts:30,39` (mock path and shape)

**Interfaces:**
- Consumes: `providerFor` (Task 2), `mustRefuseSearch` (Task 2), `billingScope`/`recordUsage` (Task 3).
- Produces:
  - `callWithWebSearch(opts: { system; prompt; maxTokens?; maxSearches? }): Promise<string>` — signature unchanged from today
  - `callStructured(opts: { system; prompt; maxTokens? }): Promise<string>` — unchanged
  - `complete(opts: { system; prompt; maxTokens?; jsonSchema? }): Promise<string>` — new; what `scoreFit` uses in Task 5
  - `parseJson<T>(raw: string): T` — moved verbatim
  - `class SearchUnavailableError extends Error`

- [ ] **Step 1: Write the failing facade test**

Create `lib/model-call.test.ts`:

```ts
import { describe, expect, test, vi, beforeEach } from "vitest";
import { runWithBilling } from "./billing-context";

const complete = vi.fn();
const searchAndComplete = vi.fn();
let enforcement: "in-request" | "none" = "in-request";

vi.mock("./providers/registry", () => ({
  providerFor: () => ({
    id: "anthropic",
    defaultModel: "claude-sonnet-4-6",
    get searchCapEnforcement() { return enforcement; },
    complete,
    searchAndComplete,
    costCents: () => 0,
    validateKey: async () => ({ ok: true }),
  }),
}));

import { callWithWebSearch, complete as completeCall, SearchUnavailableError } from "./model-call";

const usage = { inputTokens: 10, cachedInputTokens: 0, outputTokens: 5, searches: 2 };

function scope(over: Partial<Parameters<typeof runWithBilling>[0]> = {}) {
  return {
    maxSearches: null, apiKey: "sk-ant-x", provider: "anthropic" as const,
    model: "claude-sonnet-4-6", searches: 0, inputTokens: 0, cachedInputTokens: 0,
    outputTokens: 0, ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  enforcement = "in-request";
  searchAndComplete.mockResolvedValue({ text: "ok", usage });
  complete.mockResolvedValue({ text: "ok", usage: { ...usage, searches: 0 } });
});

describe("the facade routes through the scope's provider", () => {
  test("the scope's key and model reach the adapter", async () => {
    const s = scope({ model: "claude-opus-4-1", apiKey: "sk-ant-tenant" });
    await runWithBilling(s, () => callWithWebSearch({ system: "s", prompt: "p" }));

    expect(searchAndComplete.mock.calls[0][0]).toMatchObject({
      apiKey: "sk-ant-tenant",
      model: "claude-opus-4-1",
    });
  });

  test("the adapter's usage lands in the scope, cached tokens included", async () => {
    const s = scope();
    await runWithBilling(s, () => callWithWebSearch({ system: "s", prompt: "p" }));

    expect(s.searches).toBe(2);
    expect(s.inputTokens).toBe(10);
    expect(s.outputTokens).toBe(5);
  });

  test("the budget's cap becomes the request's cap when the caller names none", async () => {
    await runWithBilling(scope({ maxSearches: 6 }), () =>
      callWithWebSearch({ system: "s", prompt: "p" })
    );
    expect(searchAndComplete.mock.calls[0][0].maxSearches).toBe(6);
  });

  test("an explicit cap from the caller still wins — the role-search path computes its own", async () => {
    await runWithBilling(scope({ maxSearches: 6 }), () =>
      callWithWebSearch({ system: "s", prompt: "p", maxSearches: 2 })
    );
    expect(searchAndComplete.mock.calls[0][0].maxSearches).toBe(2);
  });

  test("outside any scope it still runs, on the platform key — cron dry runs and scripts do this", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-platform";
    await callWithWebSearch({ system: "s", prompt: "p" });
    expect(searchAndComplete.mock.calls[0][0].apiKey).toBe("sk-ant-platform");
  });
});

describe("a metered call on a provider that cannot cap in-request", () => {
  test("is refused before the adapter is reached", async () => {
    enforcement = "none";
    await expect(
      runWithBilling(scope({ maxSearches: 6 }), () => callWithWebSearch({ system: "s", prompt: "p" }))
    ).rejects.toBeInstanceOf(SearchUnavailableError);
    expect(searchAndComplete).not.toHaveBeenCalled();
  });

  test("does not affect an uncapped BYO call", async () => {
    enforcement = "none";
    await runWithBilling(scope({ maxSearches: null }), () =>
      callWithWebSearch({ system: "s", prompt: "p" })
    );
    expect(searchAndComplete).toHaveBeenCalled();
  });

  test("does not affect a non-search call", async () => {
    enforcement = "none";
    await runWithBilling(scope({ maxSearches: 6 }), () => completeCall({ system: "s", prompt: "p" }));
    expect(complete).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run lib/model-call.test.ts`
Expected: FAIL — `lib/model-call.ts` does not exist.

- [ ] **Step 3: Create `lib/model-call.ts`**

```bash
git mv lib/anthropic.ts lib/model-call.ts
```

Then rewrite its body. `parseJson` moves across untouched. `anthropic`, `clientFor`, `MODEL`, `searchCap`, `isWebSearchUseBlock` and `WebSearchUseBlock` do **not** survive — the SDK pieces now live in the adapter.

```ts
import { billingScope, recordUsage } from "./billing-context";
import { providerFor } from "./providers/registry";
import { mustRefuseSearch } from "./providers/types";
import { ANTHROPIC_DEFAULT_MODEL } from "./providers/anthropic-pricing";
import type { Completion, Provider } from "./providers/types";

/**
 * The provider-neutral entry point for every model call in the app.
 *
 * Named for what it does rather than for a vendor, because after the provider
 * registry landed this file contains no Anthropic specifics at all — those are
 * in lib/providers/anthropic.ts.
 *
 * Routing comes from the ambient BillingScope, not from a parameter: scoreFit
 * is reached three levels down inside ingestRoles' Promise.all, and threading a
 * provider through every signature between here and there is precisely what the
 * AsyncLocalStorage exists to avoid.
 */

/**
 * A search was requested under a ceiling the resolved provider cannot enforce
 * inside the request.
 *
 * Thrown rather than silently uncapped: search billing is invisible to token
 * usage, so an unenforceable cap is not a smaller cap, it is no cap. Caught in
 * lib/metered.ts and returned as `capped`, so the user reads a sentence.
 */
export class SearchUnavailableError extends Error {
  constructor(providerId: string) {
    super(
      `Search is not available on ${providerId} for a metered account, because that ` +
        `provider cannot limit how many searches one request runs. Add your own API key ` +
        `to use search, or choose a provider that supports a per-request limit.`
    );
    this.name = "SearchUnavailableError";
  }
}

/** Provider, key and model for this call: the scope's, or the platform's. */
function routing(): { provider: Provider; apiKey: string; model: string; maxSearches: number | null } {
  const s = billingScope();
  // Null is a real state, not an error: db/apply-schema, tests and one-off
  // scripts call these helpers with no budget in play.
  if (s === null) {
    return {
      provider: providerFor("anthropic"),
      apiKey: process.env.ANTHROPIC_API_KEY || "",
      model: ANTHROPIC_DEFAULT_MODEL,
      maxSearches: null,
    };
  }
  return {
    provider: providerFor(s.provider),
    apiKey: s.apiKey,
    model: s.model,
    maxSearches: s.maxSearches,
  };
}

function collect(c: Completion): string {
  recordUsage(c.usage);
  return c.text;
}

/**
 * A call with the provider's native search tool.
 *
 * `maxSearches` sets the per-request ceiling — the only hard limit on how many
 * individually billed searches a call can run. An explicit argument wins (the
 * role-search path computes one from the user's ceiling); otherwise the
 * budget's cap applies.
 */
export async function callWithWebSearch(opts: {
  system: string;
  prompt: string;
  maxTokens?: number;
  maxSearches?: number;
}): Promise<string> {
  const { provider, apiKey, model, maxSearches } = routing();
  if (mustRefuseSearch(provider.searchCapEnforcement, maxSearches)) {
    throw new SearchUnavailableError(provider.id);
  }
  const cap = opts.maxSearches ?? (maxSearches === null ? undefined : maxSearches);
  return collect(
    await provider.searchAndComplete({
      apiKey,
      model,
      system: opts.system,
      prompt: opts.prompt,
      maxTokens: opts.maxTokens ?? 2000,
      ...(cap !== undefined ? { maxSearches: cap } : {}),
    })
  );
}

/**
 * A plain completion with no tools. Used to extract roles from page text that
 * has already been fetched — the fetch tier's cost win comes from not paying
 * for searches when the page content is already in hand.
 */
export async function callStructured(opts: {
  system: string;
  prompt: string;
  maxTokens?: number;
}): Promise<string> {
  return complete({ ...opts, maxTokens: opts.maxTokens ?? 4000 });
}

/** A completion, optionally with a JSON schema the model is constrained to. */
export async function complete(opts: {
  system: string;
  prompt: string;
  maxTokens?: number;
  jsonSchema?: Record<string, unknown>;
}): Promise<string> {
  const { provider, apiKey, model } = routing();
  return collect(
    await provider.complete({
      apiKey,
      model,
      system: opts.system,
      prompt: opts.prompt,
      maxTokens: opts.maxTokens ?? 4000,
      ...(opts.jsonSchema ? { jsonSchema: opts.jsonSchema } : {}),
    })
  );
}

/** …parseJson moves here verbatim, comments included… */
```

- [ ] **Step 4: Update the five import sites**

```bash
grep -rln '@/lib/anthropic' lib app
```

Change `@/lib/anthropic` → `@/lib/model-call` in `lib/crawler.ts`, `app/actions/roles.ts`, `app/actions/discover.ts`, `app/actions/role-search.ts`, `app/actions/parse-role.ts`. In `parse-role.ts`, drop `clientFor` and `MODEL` from the import list — Task 5 removes their last use.

- [ ] **Step 5: Update the two test mocks**

In `app/actions/roles.test.ts:72` and `app/actions/parse-role.test.ts:30`, the mocked module path becomes `@/lib/model-call`, and the mock factory loses `anthropic` and `MODEL`:

```ts
vi.mock("@/lib/model-call", () => ({
  callWithWebSearch: vi.fn(),
  complete: vi.fn(),
  parseJson: (raw: string) => JSON.parse(raw),
}));
```

and the import below it becomes `import { callWithWebSearch } from "@/lib/model-call";`.

- [ ] **Step 6: Add the refusal catch to `lib/metered.ts`**

Import `SearchUnavailableError` from `@/lib/model-call` and add the `catch` shown in Task 3 Step 7 to `runScope`.

- [ ] **Step 7: Run the gate**

Run: `npm run build && npm test`
Expected: PASS. A missed import path is a build error, not a silent stale mock — which is the point of renaming rather than keeping the old filename.

- [ ] **Step 8: Commit**

```bash
git add -A lib/model-call.ts lib/model-call.test.ts lib/crawler.ts lib/metered.ts app/actions components
git commit -m "refactor: lib/anthropic becomes lib/model-call, a facade over the provider registry"
```

---

### Task 5: `scoreFit` moves onto the interface

This is the task that makes step 1 not a no-op. `scoreFit` is the app's highest-volume model call, running once per role inside `ingestRoles`' `Promise.all`, and it is one of the two places still holding the raw SDK.

**Files:**
- Modify: `app/actions/parse-role.ts:235-275`
- Test: `app/actions/parse-role.test.ts`

**Interfaces:**
- Consumes: `complete`, `parseJson` (Task 4).
- Produces: `scoreFit`'s exported signature is **unchanged** — `lib/rescore-scope.ts` derives `ScoringArgs` from it with `Omit<Parameters<typeof scoreFit>[0], "fitInputs">`, so a changed shape would break `scoringArgsFor` at compile time. Keep it exact.

- [ ] **Step 1: Write the failing test**

Add to `app/actions/parse-role.test.ts` (the mock from Task 4 already exposes `complete`):

```ts
import { complete } from "@/lib/model-call";
const model = vi.mocked(complete);

describe("scoreFit runs through the provider registry, not the raw SDK", () => {
  // The real FitPromptRole (lib/fit-prompt.ts:30) — every non-optional field,
  // because scoreFit's parameter type is that interface and a partial will not
  // compile. salary_range is "" when the posting published none, never null.
  const role = {
    company: "Acme",
    role_title: "VP RevOps",
    company_description: "Series B GTM analytics",
    key_skills: "Salesforce, dbt",
    fit_summary: "close",
    department: "Revenue Operations",
    location: "Denver, CO",
    salary_range: "$220K–$260K (base)",
  };
  const fitInputs = { fitBrain: "score this candidate", compFloor: null };

  test("a score comes back through the facade", async () => {
    model.mockResolvedValue(JSON.stringify({ score: 4, rationale: "close fit" }));
    const res = await scoreFit({ ...role, fitInputs });
    expect(res).toMatchObject({ score: 4, rationale: "close fit" });
  });

  test("the model is not named at the call site — routing is the scope's job", async () => {
    model.mockResolvedValue(JSON.stringify({ score: 3, rationale: "" }));
    await scoreFit({ ...role, fitInputs });
    expect(model.mock.calls[0][0]).not.toHaveProperty("model");
  });

  // The empty-string rule: a failure that is not the database substitutes its
  // own sentence, because UNDESCRIBED_DB_ERROR names the database and would be
  // a false sentence here.
  test("a model failure with an empty message still returns a sentence", async () => {
    model.mockRejectedValue(new Error(""));
    const res = await scoreFit({ ...role, fitInputs });
    expect(res.error).not.toBe("");
    expect(res.error).toBeTruthy();
    expect(res.score).toBe(0);
  });
});
```

`scoreFit` must be added to the file's existing import from `./parse-role` (today it imports only `parseJobUrl` and `parseRecruiterText`).

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run app/actions/parse-role.test.ts`
Expected: FAIL — `scoreFitInner` still calls `clientFor().messages.create`, which the mock no longer provides.

- [ ] **Step 3: Rewrite `scoreFitInner`**

```ts
async function scoreFitInner(
  opts: FitPromptRole & { fitInputs: FitInputs | null }
): Promise<{ score: number; rationale: string; error?: string }> {
  try {
    const fitInputs = opts.fitInputs ?? (await loadScoringInputs());
    // Through the facade, which resolves the tenant's provider, key and model
    // from the ambient billing scope and records this call's usage into it.
    // This is the app's highest-volume model call — once per role inside
    // ingestRoles' Promise.all — so it is the one that most needs to route the
    // same way as everything else rather than holding its own client.
    const raw = await complete({
      system:
        "You are a ruthless career coach scoring job fit for a specific candidate. Be honest and harsh — most roles should score 2-3. Only give 4-5 for genuinely strong matches. A 5 is rare. Return ONLY valid JSON.",
      prompt: buildFitPrompt(opts, fitInputs),
      maxTokens: 500,
    });

    const result = parseJson<{ score: number; rationale: string }>(raw);
    return { score: Math.min(5, Math.max(1, Math.round(result.score))), rationale: result.rationale };
  } catch (err) {
    console.error("scoreFit error:", err);
    // Not describeWriteFailure: this failure is the model or the parse, not the
    // database, and a message naming the database would be a false sentence.
    const message = err instanceof Error && err.message ? err.message : "Failed to score fit.";
    return { score: 0, rationale: "", error: message };
  }
}
```

Delete the now-unused imports from `app/actions/parse-role.ts`: `clientFor`, `MODEL`, `report`, and `recordUsage` if nothing else in the file uses them (`grep -n "recordUsage\|report(" app/actions/parse-role.ts` — the facade records usage now).

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run app/actions/parse-role.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the gate and commit**

Run: `npm run build && npm test`
Expected: PASS, including `app/actions/auth-required.test.ts`, which enumerates every exported action and asserts it refuses without a session — `scoreFit`'s `requireActor()` guard is untouched and must stay.

```bash
git add app/actions/parse-role.ts app/actions/parse-role.test.ts
git commit -m "feat: scoreFit runs through the provider registry, not its own SDK client"
```

---

### Task 6: `saveApiKey` validates through the adapter, and stores what it routes

**Files:**
- Modify: `app/actions/api-key.ts`, `components/ApiKeyPanel.tsx`
- Test: none new — this action reaches the database and cannot be unit-tested here; `providerFor(…).validateKey` is already pinned in `lib/providers/anthropic.test.ts`. Verified live in Task 8.

**Interfaces:**
- Consumes: `providerFor` (Task 2), `seal` with `Aad` (Task 1), `CURRENT_AAD_VERSION` (Task 1).
- Produces:
  - `saveApiKey(key: string, opts?: { model?: string }): Promise<{ error?: string }>`
  - `ApiKeyStatus` gains `provider?: string` and `model?: string | null`

- [ ] **Step 1: Rewrite the validation and the insert**

In `app/actions/api-key.ts`, drop `import Anthropic from "@anthropic-ai/sdk"` and `import { MODEL }` entirely.

```ts
import { providerFor } from "@/lib/providers/registry";
import { seal, lastFour, CURRENT_AAD_VERSION } from "@/lib/secret-box";

/**
 * Step 1 ships one provider, so this is a constant rather than an argument.
 * It is stored, bound into the AAD, and read back by lib/metered.ts, so adding
 * a second one later is a form field — not a migration and not a re-seal.
 */
const PROVIDER = "anthropic";

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

  // The adapter owns both checks: the shape of its keys and whether the vendor
  // accepts this one. What comes back is a REASON, never the SDK's text — that
  // embeds request URLs and sometimes the key itself, and this string is
  // rendered to a browser.
  const verdict = await providerFor(PROVIDER).validateKey(trimmed);
  if (!verdict.ok) {
    return {
      error:
        verdict.reason === "format"
          ? "That does not look like an Anthropic API key (they start with sk-ant-)."
          : "Anthropic rejected that key. Check it and try again.",
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
```

Note the ordering change: validation now happens **after** the rate-limit check and includes the format check, so a malformed key still consumes no network call (the adapter returns `format` without one) but does consume the rate-limit window — which is correct, since the window exists to stop this endpoint being used as a key-validation oracle.

Extend `getApiKeyStatus` to select and return `provider` and `model` as well.

- [ ] **Step 2: Add the model field to the panel**

In `components/ApiKeyPanel.tsx`, add a `model` draft alongside the key draft, pass it to `saveApiKey(draft, { model: modelDraft })`, and render the stored provider and model next to the last four. Name the default by importing `ANTHROPIC_DEFAULT_MODEL` from `@/lib/providers/anthropic-pricing` rather than typing the string — that module is pure and client-safe (Task 7 Step 3 checks exactly this), and a hardcoded copy here is the fourth place the model name would have to be kept in step. The copy must state the consequence from Task 1:

```tsx
<p className="mt-2 text-sm text-ink/60">
  Optional. Leave blank for the default, claude-sonnet-4-6. Changing the model
  re-saves the key, so you will need to paste it again — the stored key is bound
  to the model it runs on and is never read back.
</p>
```

- [ ] **Step 3: Run the gate**

Run: `npm run build && npm test`
Expected: PASS. `app/actions/auth-required.test.ts` enumerates exported actions — `saveApiKey` gained an optional second parameter, which does not change its arity requirement there, but confirm that suite is green rather than assuming.

- [ ] **Step 4: Commit**

```bash
git add app/actions/api-key.ts components/ApiKeyPanel.tsx
git commit -m "feat: key validation goes through the adapter, and the stored key carries its routing"
```

---

### Task 7: One price table, including the one users read

`lib/cost-estimate.ts` renders "~$X per By Role run" on `/settings`. It holds its own copy of Sonnet's input price and the per-search cent. After this task there is one table.

Per-tenant price *display* stays out of scope: with one provider it cannot be wrong yet, and threading a resolved price into `components/Settings.tsx` (a client component with no props, fed by `getSettings()`) is a `SettingsView` change that belongs with the OpenAI adapter in step 3. What this task removes is the duplicated constant.

**Files:**
- Modify: `lib/cost-estimate.ts`
- Test: `lib/cost-estimate.test.ts` (existing)

**Interfaces:**
- Consumes: `ANTHROPIC_PRICES`, `ANTHROPIC_DEFAULT_MODEL`, `ANTHROPIC_CENTS_PER_SEARCH` (Task 2).
- Produces: `estimateRunCost` / `formatEstimate` signatures unchanged.

- [ ] **Step 1: Point the constants at the table**

```ts
import {
  ANTHROPIC_CENTS_PER_SEARCH,
  ANTHROPIC_DEFAULT_MODEL,
  anthropicPrice,
} from "@/lib/providers/anthropic-pricing";

// Deliberately approximate — surfaced in the UI as "~$X". Its job is making the
// Denver/Colorado overlap visible, not precise billing. The RATES, though, come
// from the provider's own table rather than a third copy of them: this line is
// rendered to users, and a stale copy here shows a price the meter disagrees with.
const DOLLARS_PER_SEARCH = ANTHROPIC_CENTS_PER_SEARCH / 100;
const TOKENS_PER_SEARCH_RESULT = 5_000; // results entering context, observed order of magnitude
const DOLLARS_PER_INPUT_TOKEN = anthropicPrice(ANTHROPIC_DEFAULT_MODEL).input / 1_000_000;
const FIT_SCORING_DOLLARS = 0.19; // up to 25 scoreFit calls per run
```

- [ ] **Step 2: Confirm nothing moved**

Run: `npx vitest run lib/cost-estimate.test.ts`
Expected: PASS with no test changes — the numbers are identical, which is the point. If any assertion moves, the two copies had already drifted; stop and report which one was wrong before continuing.

- [ ] **Step 3: Confirm the client bundle did not grow an SDK**

Run: `npm run build`
Expected: PASS. `lib/providers/anthropic-pricing.ts` imports only a type from `./types`, so nothing pulls `@anthropic-ai/sdk` into the browser bundle through `components/Settings.tsx`. If the build reports a client-bundle error naming the SDK, the import in `anthropic-pricing.ts` is wrong — it must never reach `./anthropic`.

- [ ] **Step 4: Commit**

```bash
git add lib/cost-estimate.ts
git commit -m "refactor: the price users read comes from the provider's table, not a third copy"
```

---

### Task 8: Migrate, deploy, verify against the deployed commit

**The order matters and is not recoverable if reversed.** `web` autodeploys from GitHub `main` on push. The code from Tasks 3 and 6 selects and inserts `provider`, `model` and `aad_version`; if it reaches production before migration 007 does, every metered call and every key save errors against columns that do not exist.

- [ ] **Step 1: Take a backup**

Run:
```bash
railway run --service backup sh -c 'PGHOST=reseau.proxy.rlwy.net PGPORT=47766 node db/backup.mjs'
```
Expected: a completed dump to R2. Do not proceed without one — this migration alters the table holding every tenant's sealed key.

- [ ] **Step 2: Dry-run the migration against production**

Run:
```bash
railway run --service Postgres sh -c 'DATABASE_URL="$DATABASE_PUBLIC_URL" node db/migrate.mjs --dry'
```
Expected: `007_provider_routing.sql` listed as pending, nothing else, nothing applied.

- [ ] **Step 3: Apply it**

Run:
```bash
railway run --service Postgres sh -c 'DATABASE_URL="$DATABASE_PUBLIC_URL" node db/migrate.mjs'
```
Expected: 007 applied and recorded in the ledger. Every pre-existing row keeps `aad_version = 1` and `provider = 'anthropic'`.

- [ ] **Step 4: Push**

```bash
git push origin main
```

Keeping `origin/main` current is load-bearing here for a second reason: a Railway VARIABLE change rebuilds from the connected GitHub repo, so a stale `origin/main` silently reverts production the next time any variable is edited.

- [ ] **Step 5: Wait for the deployment that carries this change**

Run: `railway deployment list --service web --limit 3 --json`
Expected: break only on a TERMINAL state, and confirm `meta.commitHash` matches `git rev-parse main`. Polling too early reads the PREVIOUS deployment's SUCCESS and reports a change as live that has not built.

- [ ] **Step 6: Exercise the platform path end to end, with no spend**

Run:
```bash
S=$(railway variables --service crawler --kv | grep '^CRON_SECRET=' | cut -d= -f2)
curl -s -H "Authorization: Bearer $S" 'https://jobs.tomkeefe.ai/api/cron/crawl?dry=1'
```
Expected: a 200 with the dry-run body. This proves the cron route still resolves a billing scope through the new provider resolution, on the deployed commit.

- [ ] **Step 7: Exercise the two paths only a human can**

In the browser, signed in as the admin:

1. `/settings` → the API key panel shows the stored provider and the model (or the default), and the "~$X per By Role run" line reads the same as before this work.
2. Save a key with a deliberately wrong value (`sk-ant-nope`) → "Anthropic rejected that key." A second attempt within a minute → the rate-limit sentence.
3. Watchlist → **Check now** on one company → roles come back scored. This is the live check for `scoreFit` through the registry; the fit column filling in is the assertion.

Record the result of each in `docs/superpowers/2026-08-17-provider-registry-live-checks.md`, following the shape of the existing `*-live-checks.md` files. A step that was not run is written as not run, never omitted.

- [ ] **Step 8: Commit the live-check record**

```bash
git add docs/superpowers/2026-08-17-provider-registry-live-checks.md
git commit -m "docs: live checks for the provider registry, against the deployed commit"
git push origin main
```

---

## What this plan deliberately does not do

Recorded so a later reader does not read the gaps as oversights:

- **No OpenAI or Google adapter.** `providerFor` throws for both, and a test pins that. Step 3 in the spec.
- **No provider selector in the UI.** One provider exists; a one-option dropdown is noise. The column, the AAD binding, the scope field and the registry lookup all ship and are tested, so step 3 adds a form field rather than a migration.
- **No per-tenant price rendering on `/settings`.** With one provider it cannot be wrong. It becomes a `SettingsView` change when a second provider lands.
- **No answer to the three open questions** in the spec — OpenAI's per-request search cap, reasoning models against the tuned `maxTokens`, and rate limits against `ingestRoles`' 25-way `Promise.all`. All three are step-3 blockers. The first one should be verified BEFORE the OpenAI adapter is written, not after; nothing in step 1 depends on it.
- **No enumerating test for "every action runs inside a billing scope."** The spec's testing table lists it, pinning the leak fixed in `4cf66f0`. It is not step-1 work — nothing here changes which actions are wrapped — and it cannot be written the way `app/actions/auth-required.test.ts` writes its guard check, because asserting a wrap means actually calling each action against a database. Left open deliberately, not overlooked.
- **`jsonSchema` ships unused.** It is on the interface and implemented in the Anthropic adapter because freezing the signature without it means rewriting every adapter later, and because constrained decoding is what makes weaker models return parseable JSON. No caller passes it yet.
