import { describe, expect, test } from "vitest";
import { providerFor, ProviderNotImplementedError } from "./registry";

describe("providerFor", () => {
  test("resolves anthropic", () => {
    expect(providerFor("anthropic").id).toBe("anthropic");
  });

  test("routes additional providers without falling back", () => {
    expect(providerFor("openai").id).toBe("openai");
    expect(providerFor("google").id).toBe("google");
    expect(() => providerFor("toString")).toThrow(ProviderNotImplementedError);
  });

  test("an unrecognised string throws too", () => {
    expect(() => providerFor("not-a-provider")).toThrow(ProviderNotImplementedError);
  });
});
