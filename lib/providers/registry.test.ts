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
