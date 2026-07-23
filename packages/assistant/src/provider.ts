import { createGeminiChat } from "@tanstack/ai-gemini";
import { createAnthropicChat } from "@tanstack/ai-anthropic";
import { createOpenaiChat } from "@tanstack/ai-openai";
import type { Provider } from "./schema.ts";

// API map: verified against @tanstack/ai@0.42.0, @tanstack/ai-gemini@0.20.1,
// @tanstack/ai-anthropic@0.16.3, @tanstack/ai-openai@0.17.1 (read from each package's
// installed dist/esm/*.d.ts under node_modules — not guessed).
//
// - `chat()`, `toolDefinition()`, `combineStrategies`/`maxIterations`/`maxToolCalls`,
//   `maxToolCallsPerTurn`, and `.server()` (on a `toolDefinition()` instance) all exist under
//   those exact names, matching this plan. `chat()` takes `{ adapter, messages, tools,
//   agentLoopStrategy, maxToolCallsPerTurn, ... }` and returns an `AsyncIterable<StreamChunk>`
//   by default (`@tanstack/ai/dist/esm/activities/chat/index.d.ts`).
// - Per-provider adapter construction (this file's concern) is a plain factory function, not a
//   class you `new` up: `createGeminiChat(model, apiKey, config?)`, `createAnthropicChat(model,
//   apiKey, config?)`, `createOpenaiChat(model, apiKey, config?)` — each exported from the
//   package root and each returning a provider-specific `*TextAdapter` instance implementing the
//   `TextAdapter` interface `chat()` expects as `adapter`. (There's also an env-var-sniffing
//   sibling per package, e.g. `geminiText(model, config?)`, but we pass the key explicitly since
//   it comes from the resolved `env` param, not `process.env` implicitly.)
// - Each factory's `model` parameter is typed as a literal union (e.g. `(typeof
//   GEMINI_MODELS)[number]`) pulled from that package's own model-id table, not `string`. Our
//   `CapabilityProfile.model` is a plain `string` validated against our own `PROFILES` allowlist
//   (fail-closed independent of the adapter package's table), so `buildAdapter` casts at the
//   factory call — the cast is a type-level formality, not a runtime trust decision.
export type CapabilityProfile = { model: string; contextTokens: number; maxOutputTokens: number };

// Pinned defaults + every model override we allow. An unknown override is NOT assigned
// guessed limits — it makes the provider unavailable (fail closed).
// NOTE: verify current model ids against provider docs at implementation time.
const PROFILES: Record<Provider, Record<string, Omit<CapabilityProfile, "model">>> = {
  gemini: { "gemini-3-flash": { contextTokens: 1_000_000, maxOutputTokens: 8192 } },
  anthropic: { "claude-sonnet-5": { contextTokens: 200_000, maxOutputTokens: 8192 } },
  openai: { "gpt-5.1": { contextTokens: 400_000, maxOutputTokens: 8192 } },
};
const DEFAULT_MODEL: Record<Provider, string> = {
  gemini: "gemini-3-flash", anthropic: "claude-sonnet-5", openai: "gpt-5.1",
};
const KEY_VAR: Record<Provider, string> = {
  gemini: "GEMINI_API_KEY", anthropic: "ANTHROPIC_API_KEY", openai: "OPENAI_API_KEY",
};
const MODEL_VAR: Record<Provider, string> = {
  gemini: "GEMINI_MODEL", anthropic: "ANTHROPIC_MODEL", openai: "OPENAI_MODEL",
};
const PROVIDERS: Provider[] = ["gemini", "anthropic", "openai"];

function profileOf(provider: Provider, env: Record<string, string | undefined>): CapabilityProfile | null {
  if (!env[KEY_VAR[provider]]) return null;
  const model = env[MODEL_VAR[provider]] ?? DEFAULT_MODEL[provider];
  const p = PROFILES[provider][model];
  return p ? { model, ...p } : null; // override without a profile → unavailable
}

export function listProviders(env: Record<string, string | undefined> = process.env) {
  return PROVIDERS.map((provider) => {
    const p = profileOf(provider, env);
    return { provider, model: p?.model ?? (env[MODEL_VAR[provider]] ?? DEFAULT_MODEL[provider]), available: !!p };
  });
}

export function resolveProvider(provider: Provider, env: Record<string, string | undefined> = process.env) {
  const profile = profileOf(provider, env);
  if (!profile) throw new Error("PROVIDER_UNAVAILABLE");
  const apiKey = env[KEY_VAR[provider]]!;
  return {
    profile,
    // Lazy: adapters are built per turn, keys never cached at module scope.
    makeAdapter: () => buildAdapter(provider, apiKey, profile.model),
  };
}

/** Constructs the provider-specific TanStack AI text adapter for `chat({ adapter, ... })`.
 *  Never called at module load — only from `makeAdapter()` above, per turn. */
function buildAdapter(provider: Provider, apiKey: string, model: string) {
  switch (provider) {
    case "gemini":
      return createGeminiChat(model as Parameters<typeof createGeminiChat>[0], apiKey);
    case "anthropic":
      return createAnthropicChat(model as Parameters<typeof createAnthropicChat>[0], apiKey);
    case "openai":
      return createOpenaiChat(model as Parameters<typeof createOpenaiChat>[0], apiKey);
  }
}
