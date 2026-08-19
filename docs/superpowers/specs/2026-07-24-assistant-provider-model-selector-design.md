# Assistant Provider-Model Selector Design

## Goal

Replace the provider-only selector with one provider-model selector populated from the models available to each configured API key.

## Design

- `packages/assistant/src/provider.ts` fetches model IDs from the configured Gemini, Anthropic, and OpenAI model-list endpoints.
- Each live result is intersected with the installed TanStack adapter's exported chat-model array. This excludes unsupported and non-chat IDs without maintaining a second model list.
- Discovery uses `fetch` directly and adds no dependency or server-side cache. The existing TanStack Query call provides client-side caching; server caching can be added only if provider traffic becomes measurable.
- The providers procedure returns flattened `{ provider, model }` choices. A failed or unconfigured provider contributes no choices while successful providers still appear.
- The web window stores one selected `{ provider, model }` pair and renders it as a single `Provider — model` option.
- Chat input carries both fields. A new turn validates the pair, builds the matching TanStack adapter, and persists both values. Retries reuse the turn's pinned pair. Existing conversations restore their pair and may switch pairs between turns, matching the current provider-switching behavior.
- Environment model variables remain preferred defaults when their model appears in discovery; otherwise the first discovered choice is selected.

## Safety and Errors

- API keys remain server-only.
- The server accepts only models exported by the installed TanStack adapter, even if a client submits a model directly.
- Provider discovery errors are reduced to provider unavailability and do not expose response bodies or credentials.
- OpenAI's model endpoint exposes IDs but not capability metadata; the TanStack chat-model intersection is the compatibility boundary.

## Verification

- Provider tests cover live-result intersection, partial discovery failure, and submitted-pair validation.
- Loop tests cover model pinning and retry identity.
- Web tests cover combined selection and the selected model sent in chat input where the existing test setup supports the component.
- Run assistant tests and TypeScript checks for the assistant, server, and web packages.
