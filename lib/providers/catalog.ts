// Browser-safe provider choices. Never import the SDK-bearing registry here.
import { ANTHROPIC_DEFAULT_MODEL, ANTHROPIC_PRICES } from "./anthropic-pricing";
import { OPENAI_DEFAULT_MODEL, OPENAI_PRICED_MODELS } from "./openai-pricing";
import { GOOGLE_DEFAULT_MODEL, GOOGLE_PRICED_MODELS } from "./google-pricing";
import type { ProviderId } from "./types";

export const PROVIDER_CHOICES = [
  { id: "anthropic", label: "Anthropic (Claude)", defaultModel: ANTHROPIC_DEFAULT_MODEL, models: Object.keys(ANTHROPIC_PRICES), keyUrl: "https://console.anthropic.com/settings/keys", keySite: "Anthropic Console", placeholder: "sk-ant-…" },
  { id: "openai", label: "OpenAI", defaultModel: OPENAI_DEFAULT_MODEL, models: OPENAI_PRICED_MODELS, keyUrl: "https://platform.openai.com/api-keys", keySite: "OpenAI Platform", placeholder: "sk-…" },
  { id: "google", label: "Google Gemini", defaultModel: GOOGLE_DEFAULT_MODEL, models: GOOGLE_PRICED_MODELS, keyUrl: "https://aistudio.google.com/apikey", keySite: "Google AI Studio", placeholder: "AIza…" },
] as const;

export function providerChoice(id: string | undefined) {
  return PROVIDER_CHOICES.find(choice => choice.id === id);
}

export function providerLabel(id: string | undefined): string {
  return providerChoice(id)?.label ?? "your AI provider";
}

export function isSupportedProvider(id: string): id is ProviderId {
  return PROVIDER_CHOICES.some(choice => choice.id === id);
}
