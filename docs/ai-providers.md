# Supported AI connections

The app accepts keys for registered providers, not arbitrary AI endpoints. Users choose a provider and a priced model before key verification. Provider and model are bound to the encrypted key; changing either requires pasting and verifying the matching key again.

| Provider | Model | Support |
| --- | --- | --- |
| Anthropic | Claude Sonnet 4.6 | Existing complete and search flows |
| OpenAI | GPT-4.1 | Complete, structured output, and capped web search through Responses |
| Google Gemini | Gemini 2.5 Flash | Complete, structured output, and uncapped grounded search; By Role unavailable |

By Role always requests an enforced search cap. Gemini does not expose the needed cap, so that operation refuses before calling the provider. Administrator accounts also have ambient search limits, which means other Gemini searches refuse for them. Ordinary BYO users may use uncapped Gemini searches. Never silently discard a caller or account cap; when both exist, use the smaller cap.

Only documented, priced models are accepted. OpenAI uses web_search_preview and max_tool_calls; Google uses google_search. Google grounding costs count grounded prompts separately from individual search queries. Estimated costs use standard paid-tier prices and may differ from vendor invoices or free allowances.

Key verification makes a small paid or quota-consuming request. Chat subscriptions do not supply API credits. Secrets are sent only to the selected provider in headers and stored encrypted; provider HTTP errors are sanitized before display.

Verification: adapter tests simulate HTTP responses and cover routing, usage, structured output, refusals, timeouts/errors, and caps. UI checks use simulated key actions. New provider integrations still require real-key smoke tests for profile generation, role search, scoring, and resume generation before production verification can be claimed.
