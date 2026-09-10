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

  test("an unpriceable stored model cannot bypass the key-saving gate", () => {
    expect(resolveProviderConfig({ provider: "anthropic", model: "claude-opus-4-1" })).toBeNull();
    expect(resolveProviderConfig({ provider: "google", model: "unknown" })).toBeNull();
    expect(resolveProviderConfig({ provider: "openai", model: "gpt-4.1" })).toEqual({ providerId: "openai", model: "gpt-4.1" });
  });

  // Defence behind the CHECK constraint in migration 007. A row this build
  // cannot route is "no usable key" — never a silent fallback to Anthropic,
  // which would bill a key the tenant chose for another vendor.
  test("a provider this build cannot serve resolves to null, not to Anthropic", () => {
    expect(resolveProviderConfig({ provider: "google", model: null })).toEqual({ providerId: "google", model: "gemini-2.5-flash" });
    expect(resolveProviderConfig({ provider: "nonsense", model: null })).toBeNull();
  });
});
