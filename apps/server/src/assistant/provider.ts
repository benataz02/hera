import { createGeminiChat, GEMINI_MODELS } from "@tanstack/ai-gemini";
import { ANTHROPIC_MODELS, createAnthropicChat } from "@tanstack/ai-anthropic";
import { createOpenaiChat, OPENAI_CHAT_MODELS } from "@tanstack/ai-openai";
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
// - Each factory's `model` parameter is typed as a literal union from that package's model table.
//   Runtime input is checked against those same exported arrays before the factory-call cast.
export type CapabilityProfile = { model: string; contextTokens: number; maxOutputTokens: number };

const PROVIDER_ERROR_FALLBACK = "The AI provider could not complete the request. Please try again.";

function publicApiMessage(value: unknown, nested = false, depth = 0): string | undefined {
  if (depth > 10) return undefined;
  if (typeof value === "string") {
    const text = value.trim();
    if (!text) return undefined;
    try {
      return publicApiMessage(JSON.parse(text), true, depth + 1);
    } catch {
      const jsonStart = text.indexOf("{");
      if (jsonStart > 0) {
        try {
          return publicApiMessage(JSON.parse(text.slice(jsonStart)), true, depth + 1);
        } catch { /* not a status-prefixed JSON response */ }
      }
      return nested ? text.slice(0, 2000) : undefined;
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  return publicApiMessage(record.error, true, depth + 1)
    ?? publicApiMessage(record.message, true, depth + 1);
}

/** A provider-boundary error whose message is safe to send to the browser. Raw provider
 * exceptions are never exposed unless they contain a structured public API error message. */
export class ProviderApiError extends Error {
  readonly code = "PROVIDER_UNAVAILABLE";
  readonly retryable = true;

  constructor(message: string) {
    super(message);
    this.name = "ProviderApiError";
  }
}

export function toProviderApiError(error: unknown): ProviderApiError {
  const source = error instanceof Error ? error.message : error;
  return new ProviderApiError(publicApiMessage(source) ?? PROVIDER_ERROR_FALLBACK);
}

// Exact metadata retained for the models that already had it. Other recognized models use the
// assistant's own conservative 32k-input/2k-output operating budgets.
const PROFILES: Record<Provider, Record<string, Omit<CapabilityProfile, "model">>> = {
  gemini: {
    "gemini-3-flash": { contextTokens: 1_000_000, maxOutputTokens: 8192 },
    "gemini-3.5-flash": { contextTokens: 1_048_576, maxOutputTokens: 65_536 },
  },
  anthropic: { "claude-sonnet-5": { contextTokens: 200_000, maxOutputTokens: 8192 } },
  openai: { "gpt-5.1": { contextTokens: 400_000, maxOutputTokens: 8192 } },
};
const DEFAULT_MODEL: Record<Provider, string> = {
  gemini: GEMINI_MODELS[0], anthropic: ANTHROPIC_MODELS[0], openai: OPENAI_CHAT_MODELS[0],
};
const KEY_VAR: Record<Provider, string> = {
  gemini: "GEMINI_API_KEY", anthropic: "ANTHROPIC_API_KEY", openai: "OPENAI_API_KEY",
};
const MODEL_VAR: Record<Provider, string> = {
  gemini: "GEMINI_MODEL", anthropic: "ANTHROPIC_MODEL", openai: "OPENAI_MODEL",
};
const PROVIDERS: Provider[] = ["gemini", "anthropic", "openai"];
const MODELS: Record<Provider, readonly string[]> = {
  gemini: GEMINI_MODELS, anthropic: ANTHROPIC_MODELS, openai: OPENAI_CHAT_MODELS,
};

function profileOf(
  provider: Provider,
  env: Record<string, string | undefined>,
  selectedModel?: string,
): CapabilityProfile | null {
  if (!env[KEY_VAR[provider]]) return null;
  const model = selectedModel ?? env[MODEL_VAR[provider]] ?? DEFAULT_MODEL[provider];
  if (!MODELS[provider].includes(model)) return null;
  const p = PROFILES[provider][model] ?? { contextTokens: 32_000, maxOutputTokens: 2_048 };
  return { model, ...p };
}

export function listProviders(env: Record<string, string | undefined> = process.env) {
  return PROVIDERS.map((provider) => {
    const p = profileOf(provider, env);
    return { provider, model: p?.model ?? (env[MODEL_VAR[provider]] ?? DEFAULT_MODEL[provider]), available: !!p };
  });
}

async function liveModelIds(provider: Provider, apiKey: string, request: typeof fetch): Promise<Set<string>> {
  const [url, init]: [string, RequestInit | undefined] = provider === "gemini"
    ? [`https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000&key=${encodeURIComponent(apiKey)}`, undefined]
    : provider === "anthropic"
      ? ["https://api.anthropic.com/v1/models?limit=1000", {
          headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
        }]
      : ["https://api.openai.com/v1/models", {
          headers: { authorization: `Bearer ${apiKey}` },
        }];
  const response = await request(url, init);
  if (!response.ok) throw new Error("MODEL_DISCOVERY_FAILED");
  const body = await response.json() as {
    data?: { id?: unknown }[];
    models?: { name?: unknown }[];
  };
  const ids = provider === "gemini"
    ? (body.models ?? []).map((m) => typeof m.name === "string" ? m.name.replace(/^models\//, "") : "")
    : (body.data ?? []).map((m) => typeof m.id === "string" ? m.id : "");
  return new Set(ids.filter(Boolean));
}

/** Models both available to the configured key and supported by the installed text adapter. */
export async function listProviderModels(
  env: Record<string, string | undefined> = process.env,
  request: typeof fetch = fetch,
) {
  const groups = await Promise.all(PROVIDERS.map(async (provider) => {
    const apiKey = env[KEY_VAR[provider]];
    if (!apiKey) return [];
    try {
      // ponytail: one max-sized page is enough for these provider catalogs; paginate if one grows past it.
      const live = await liveModelIds(provider, apiKey, request);
      const models = MODELS[provider].filter((model) => live.has(model));
      const preferred = env[MODEL_VAR[provider]];
      if (preferred && models.includes(preferred))
        models.splice(0, models.length, preferred, ...models.filter((model) => model !== preferred));
      return models.map((model) => ({ provider, model }));
    } catch {
      return [];
    }
  }));
  return groups.flat();
}

export function resolveProvider(
  provider: Provider,
  env: Record<string, string | undefined> = process.env,
  model?: string,
) {
  const profile = profileOf(provider, env, model);
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
