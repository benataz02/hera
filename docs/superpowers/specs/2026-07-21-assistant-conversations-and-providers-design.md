# Assistant: optional package, conversations, multi-provider models — design

Reshapes the configurator assistant (`2026-07-21-configurator-assistant-design.md`) into an **optional
feature package**, and extends it with **bounded conversations** (new chat, load a past one) and a
**user-switchable model** across Anthropic, Google and OpenAI behind hand-rolled adapters.

Tool semantics, `ChatPart`, persistence, admission and the revert/AI-marker model are unchanged.

---

## 1. Why

- **Optional.** The assistant is an add-on, not part of the backbone. Today it is welded into
  `apps/server` and `apps/web`; a deployment that doesn't want it has no way to leave it out.
- **Conversations.** A thread today *is* every `config_chat_turn` for a `(tenantId, projectId)` pair.
  Nothing scopes or ends it, so it grows forever and `providerHistory`'s 30-message cap silently
  amputates the oldest context with no way to start clean.
- **Providers.** Anthropic is welded into the turn loop at five points: `TOOLS` (`Anthropic.Tool[]`),
  the `messages` array type, `decideNext`'s stop-reason strings, `toolRoundMessages`' `tool_result`
  block, and the `content_block_delta` stream branch. Everything downstream (`ChatPart`, the DB rows,
  `assistantState.ts`) is already provider-neutral.

---

## 2. Packaging

### Layout

```
packages/assistant/
  package.json                exports: "./server", "./web"
  src/server/
    index.ts                  createAssistantRouter, availableModels, type AssistantRouter
    router.ts                 the oRPC procedures
    host.ts                   type AssistantHost — the five injected capabilities
    providers/                types.ts models.ts anthropic.ts google.ts openai.ts
    loop.ts prompt.ts setValues.ts admission.ts conversations.ts tools.ts
    *.test.ts
  src/web/
    index.ts                  AssistantPanel, useAssistant
    client.ts                 the package's own oRPC client
    AssistantPanel.tsx useAssistant.ts assistantState.ts assistantState.test.ts
```

Everything under `apps/server/src/chat/`, `apps/server/src/orpc/routers/assistant.ts` and
`apps/web/src/components/assistant/` moves here. Nothing else moves.

### The host interface — capabilities, not utilities

`assistant.ts` currently reaches into four `apps/server` modules for eleven symbols. Injecting those
verbatim would drag the app's internals into the package's API. Instead the host exposes **one
capability per tool**, each absorbing the plumbing behind it:

```ts
export type AssistantHost = {
  base: <the app's userProcedure builder>;                          // auth + tenant resolution
  loadProject(tenantId, projectId): Promise<ProjectContext | null>; // configProject + loadModel + cachedLookups
  history(tenantId, projectId, itemCode?): Promise<DocResult>;      // docHistoryForProject
  documents(tenantId, projectId, itemCode): Promise<DocResult>;     // assertAgentReady + runRequest + docLinesBothPath
                                                                    //   + flattenDocs + sortDocRows
  extract(definition, lookups, drawing): Promise<{ suggestions }>;  // extractSuggestions
};
```

Five members. `documents` and `history` throw `ORPCError` on their existing failure paths (no
customer, agent offline); the package already turns a thrown `ORPCError` into a conversational tool
error, so that behaviour is unchanged. The package defines its own four-line `DrawingZ` rather than
importing `ExtractFileZ` — structurally identical, one fewer host member.

> **Known risk.** `base` is the app's `userProcedure`, an oRPC builder carrying a context type. Typing
> it structurally (parameterised on a `{ tenantId: string }` context) is the one fiddly part of this
> change. If oRPC's builder generics fight back, fall back to the host passing a
> `withTenant(handler)` wrapper instead of the builder, and let the package build its own procedures.

### Mounting — the off switch

```ts
// apps/server/src/orpc/router.ts
export const router = {
  sync, entities, variants, models, configs, portal, portalClients,
  ...(assistantEnabled() ? { assistant: createAssistantRouter(host) } : {}),
};
```

`assistantEnabled()` = `process.env.ASSISTANT_ENABLED !== "off"` **and** at least one provider key is
set. So the default is: keys present → on; no keys → the router simply isn't there. This replaces
today's mount-then-throw-`SERVICE_UNAVAILABLE` behaviour.

The web hides the sparkle toggle when `assistant.models` fails or returns `[]` — one `retry: false`
query covering both "not mounted" (404) and "mounted, no keys" (empty). No feature procedure, no
tenant column, no build flag.

### The web half types itself

`useAssistant` cannot import `apps/web/src/orpc.ts`. The package builds its own client instead —
same origin, same cookies, typed by the router it ships:

```ts
// packages/assistant/src/web/client.ts
import type { AssistantRouter } from "../server/index.ts";   // import type — erased, no runtime reaches the bundle
const link = new RPCLink({ url: `${window.location.origin}/rpc` });
export const client: RouterClient<{ assistant: AssistantRouter }> = createORPCClient(link);
export const orpc = createTanstackQueryUtils(client);
```

Wrapping in `{ assistant: … }` keeps the RPC paths and TanStack query keys identical to the app's
client, so invalidation still works across both. The package owns both sides of the `assistant`
mount key. It relies on the app's `QueryClientProvider`, which already wraps the whole tree.

`apps/web` shrinks to two lines: import `AssistantPanel`/`useAssistant` from `@hera/assistant/web` in
`ConfigProcessPage.tsx`. `apps/server/src/orpc/router.ts` drops its `ChatEvent`/`ChatPart` re-exports.

### Dependencies

`@hera/assistant` deps: `@orpc/server`, `@orpc/client`, `@orpc/tanstack-query`, `zod`, `drizzle-orm`,
`@hera/db`, `@hera/config-engine`, `@anthropic-ai/sdk`, `@google/genai`, `openai` *(new)*.

React, `react-dom`, `@tanstack/react-query`, `@ui5/webcomponents-react` and `@ui5/webcomponents-ai-react`
are **peerDependencies and devDependencies both** — peer so `apps/web` supplies the single copy (two
Reacts break hooks), dev so the package typechecks standalone. Bun's isolated install does not resolve
transitively, so every import in `src/` must appear in one of those lists.

`@anthropic-ai/sdk` moves out of `apps/server`'s manifest entirely. `@google/genai` stays in both:
the package needs it for the Google adapter, `apps/server` still needs it for drawing extraction.

### The tables stay in `@hera/db`

`packages/db/src/schema/chat.ts` does **not** move. Moving it would put `@hera/db` in a dependency
cycle with the package, and split the drizzle-kit migration pipeline in two. Two unused tables in a
deployment with the assistant off cost nothing.

---

## 3. Conversations

### Schema (migration `0005`)

`config_chat_turn` gains two columns. No new table, no title column, no archive flag.

| Column | Type | Notes |
|---|---|---|
| `conversation_id` | `uuid NOT NULL` | client-generated, like `id` |
| `model` | `text` (nullable) | the model that answered; nullable for pre-migration rows |

Plus `index (tenant_id, project_id, conversation_id, created_at)`.

Drizzle generates `ADD COLUMN ... NOT NULL`, which fails on a non-empty table. **Hand-edit the
generated SQL** into the three-step form — existing turns of one project collapse into one legacy
conversation:

```sql
ALTER TABLE config_chat_turn ADD COLUMN conversation_id uuid;
UPDATE config_chat_turn t SET conversation_id = g.cid
  FROM (SELECT tenant_id, project_id, gen_random_uuid() AS cid
        FROM config_chat_turn GROUP BY tenant_id, project_id) g
 WHERE t.tenant_id = g.tenant_id AND t.project_id = g.project_id;
ALTER TABLE config_chat_turn ALTER COLUMN conversation_id SET NOT NULL;
```

`config_chat_message` is unchanged — the turn is the anchor, and both list and load join through it.
The `config_chat_one_running_uq` partial unique index stays **project**-scoped: one panel, one
in-flight turn, regardless of which conversation is open.

### Procedures

| Procedure | Change |
|---|---|
| `assistant.conversations` | **new** — `{ projectId }` → `[{ conversationId, title, startedAt, lastActivityAt }]`, newest activity first |
| `assistant.messages` | `conversationId` added to the input, **required** |
| `assistant.chat` | `conversationId` and `model` added to the input |
| `assistant.models` | **new** — no input → `[{ id, label, provider }]`, only models whose API key is set |

`conversations` is one query over sequence-0 messages, folded in JS by a pure `foldConversations(rows)`
in `conversations.ts` (same shape as `admission.ts` / `setValues.ts`: pure, tested, thin router).
Title = the first user message, truncated in SQL (`left(parts->0->>'text', 80)`) so the payload stays
small — sequence-0 parts are always exactly `[{ type: "text", text }]`, written by one hardcoded insert.

```
// ponytail: folds every turn row for the project; switch to DISTINCT ON + MAX() if a project
// ever accumulates thousands of turns.
```

### Turn history is now conversation-scoped

The `history` select inside `chat` gains `eq(configChatTurn.conversationId, input.conversationId)`.
That single predicate is what actually fixes "persists forever" — the model sees one conversation,
not the project's entire past.

### Client

`useAssistant` owns the conversation state:

- `conversationId: string | null` — `null` until resolved.
- On mount, `conversations` resolves it: the most recent conversation, or a fresh `crypto.randomUUID()`
  when the project has none. `messages` stays `enabled: false` until then.
- `newChat()` — mint a uuid, clear `live`. **Nothing is deleted;** the previous conversation stays in
  the history menu.
- `openConversation(id)` — set the id, clear `live`, let the `messages` query refetch.
- Both abort an in-flight turn first (same call as `stop()`).
- `available: boolean` — false when `models` 404s or returns `[]`; `ConfigProcessPage` hides the
  toggle on it.

A conversation whose uuid was minted but never sent has no rows and simply never appears in the list.

### Panel UI

The header `Bar` carries all three controls; the conversation list is a stock `Menu`.

```
┌────────────────────────────────────┐
│ [Opus 4.8      ▾]      ＋   🕐   ✕ │
├────────────────────────────────────┤
│   How can I help you?              │
│   [Extract…] [What's left?]        │
```

Past conversations render inert exactly as persisted turns do today (no Accept, no Revert) — the
existing `m.live` check already covers it, because a loaded conversation has no live messages.

---

## 4. Providers

### Neutral types (`src/server/providers/types.ts`)

The **transcript is the interface**. The router accumulates provider-agnostic turns; each adapter
re-serializes the whole transcript per request, so adapters hold no state.

```ts
export type ToolUse = { id: string; name: string; input: unknown };

export type Turn =
  | { role: "user"; text: string }
  | { role: "assistant"; text: string; toolUse?: ToolUse }
  | { role: "tool"; id: string; name: string; content: string; isError?: boolean };

export type StopReason = "end" | "tool_use" | "max_tokens" | "refusal" | "other";

export type ProviderEvent =
  | { type: "token"; text: string }
  | { type: "stop"; reason: StopReason; text: string; toolUse?: ToolUse };

export type NeutralTool = { name: string; description: string; parameters: JsonSchema };

export type Provider = {
  stream(req: {
    model: string; system: string; tools: NeutralTool[];
    transcript: Turn[]; signal: AbortSignal;
  }): AsyncIterable<ProviderEvent>;
  errorText(e: unknown): string;
};
```

The adapter yields tokens and exactly one terminal `stop` carrying the assembled text and at most one
tool call. `loop.ts` then depends on nothing but `StopReason` and `ToolUse`.

The `tool` turn carries **both `id` and `name`**: Anthropic and OpenAI match tool results by id,
**Gemini matches by function name**. Dropping either breaks one provider.

An assistant turn that is a bare tool call has `text: ""`. Every adapter must **omit** the empty text
rather than serialize it — Anthropic rejects empty text blocks, and OpenAI wants `content: null`
alongside `tool_calls`. One shared guard, exercised by the mapping tests.

### Registry (`src/server/providers/models.ts`)

One literal array — the single place a model id is added or removed.

```ts
export const MODELS = [
  { id: "claude-opus-4-8",  label: "Claude Opus 4.8", provider: "anthropic", envKey: "ANTHROPIC_API_KEY" },
  { id: "claude-sonnet-5",  label: "Claude Sonnet 5", provider: "anthropic", envKey: "ANTHROPIC_API_KEY" },
  { id: "gemini-3-pro",     label: "Gemini 3 Pro",    provider: "google",    envKey: "GEMINI_API_KEY" },
  { id: "gemini-3-flash",   label: "Gemini 3 Flash",  provider: "google",    envKey: "GEMINI_API_KEY" },
  { id: "gpt-5",            label: "GPT-5",           provider: "openai",    envKey: "OPENAI_API_KEY" },
] as const;
```

`availableModels()` returns the entries whose `envKey` is set — it backs both `assistant.models` and
`assistantEnabled()`. `chat` resolves `input.model` the same way and rejects an unavailable id, so a
client cannot select an unconfigured or unknown model.

This **supersedes `ANTHROPIC_MODEL`** for chat; the picker is the model choice now. `GEMINI_MODEL`
still governs drawing extraction, which is untouched.

The client remembers the last pick in `localStorage["hera.assistant.model"]`, validated against
`assistant.models` on open, falling back to the first available. No user-preference schema.

### Adapters

Each is a pure request mapper + a pure chunk reducer + ~20 lines of stream glue.

| | Anthropic | Google | OpenAI |
|---|---|---|---|
| SDK | `@anthropic-ai/sdk` | `@google/genai` | `openai` **(new dep)** |
| Call | `messages.stream` | `models.generateContentStream` | `chat.completions.create({stream:true})` |
| System | `system` param | `config.systemInstruction` | leading `system` message |
| Max tokens | `max_tokens` | `config.maxOutputTokens` | `max_completion_tokens` |
| Tool result | `tool_result` block, by `tool_use_id` | `functionResponse`, by **name** | `role:"tool"`, by `tool_call_id` |
| Tool args | object | object | JSON **string** — `JSON.stringify` out, `JSON.parse` in |
| No parallel calls | `tool_choice.disable_parallel_tool_use` | *no flag* — adapter takes the first `functionCall` | `parallel_tool_calls: false` |
| Abort | `{ signal }` | `config.abortSignal` | `{ signal }` |

Stop-reason mapping:

| Neutral | Anthropic | Google `finishReason` | OpenAI `finish_reason` |
|---|---|---|---|
| `end` | `end_turn`, `stop_sequence` | `STOP` (no function calls) | `stop` |
| `tool_use` | `tool_use` | `STOP` **with** function calls | `tool_calls` |
| `max_tokens` | `max_tokens` | `MAX_TOKENS` | `length` |
| `refusal` | `refusal` | `SAFETY`, `PROHIBITED_CONTENT`, `BLOCKLIST` | `content_filter` |
| `other` | anything else | anything else | anything else |

`errorText` keeps today's `"<status>: <message>"` convention per SDK error type, so the existing
verbatim-provider-error behaviour survives unchanged for all three.

**No adapter needs multimodal support.** `extract_from_drawing` runs the host's Gemini extraction path
and returns text plus a `suggestions` part; the drawing never reaches the chat provider.

### `set_values` tool schema

A free-form `{ type: "object" }` with no `properties` is Anthropic-only — Gemini's OpenAPI subset
rejects it and OpenAI strict mode refuses it. The map becomes an array of string pairs:

```ts
values: [{ key: "material", value: "aluminium" }, { key: "section", value: "25" }]
```

`applySetValues` gains a coercion step keyed on the parameter's declared type, before its existing
per-key validation:

| `p.type` / `p.ui` | Coercion | Failure |
|---|---|---|
| `number` | `Number(v)` | `NaN` → `"Expected a number"` |
| `boolean` | `v === "true"` | other text → `"Expected true or false"` |
| `multicombo` | `[v]` | — |
| `string` | `v` | — |

Non-string input (an object-shaped call from a model that ignores the schema) still validates through
the existing path, so the change is additive.

### Loop changes (`src/server/loop.ts`)

- `decideNext({ stop, toolUse, round, maxRounds, aborted })` — same `NextAction`, no Anthropic types.
- `toolRoundMessages` → `appendToolRound(transcript, assistantTurn, toolResult)` returning `Turn[]`.
- `providerHistory` in `prompt.ts` returns `Turn[]`; its "first message must be user" shift stays —
  Anthropic and Gemini both require it, OpenAI does not care.

The router's provider block becomes:

```ts
const spec = availableModel(input.model);           // 400 if unknown/unconfigured
const provider = PROVIDERS[spec.provider]();
for (let round = 0; ; ) {
  let stop: Extract<ProviderEvent, { type: "stop" }> | undefined;
  for await (const ev of provider.stream({ model: spec.id, system, tools: TOOLS, transcript, signal: combined })) {
    if (ev.type === "token") yield { type: "token", text: ev.text };
    else stop = ev;
  }
  ...
}
```

---

## 5. Errors

| Case | Behaviour |
|---|---|
| No provider key set / `ASSISTANT_ENABLED=off` | Router not mounted; `assistant.models` 404s; the web hides the toggle. Replaces the old `SERVICE_UNAVAILABLE` message. |
| Unknown / unconfigured `model` | `BAD_REQUEST`; the client re-reads `assistant.models` and falls back |
| Provider API error | unchanged — verbatim `"<status>: <message>"` from that provider's `errorText` |
| Everything else | unchanged (deadline, tool rounds, max tokens, refusal, cancel) |

Switching model mid-conversation is legal and needs no special handling: history reaches every
provider as plain `{ role, text }` turns via `providerHistory`, and `model` is recorded per turn.

---

## 6. Testing

All server tests move with their sources; `bun test packages/assistant` becomes a root
`test:assistant` script alongside `test:server`.

| File | What |
|---|---|
| `src/server/providers/providers.test.ts` | **new** — one table-driven file: transcript → each provider's request body, and each provider's chunks → `ProviderEvent`s, including every stop-reason row above |
| `src/server/conversations.test.ts` | **new** — `foldConversations`: title truncation, ordering by last activity, one-turn conversation |
| `src/server/loop.test.ts` | rewritten against neutral shapes (smaller — no Anthropic fixtures) |
| `src/server/setValues.test.ts` | + coercion cases: numeric string, `NaN`, `"true"`, multicombo wrapping |
| `src/server/admission.test.ts`, `prompt.test.ts` | moved, otherwise unchanged |
| `src/web/assistantState.test.ts` | moved, otherwise unchanged — parts and folding are untouched |

Manual e2e: three keys set → picker lists five models → same question answered by each; new chat →
empty panel, old thread still in the history menu; reload → correct conversation restored; unset two
keys → picker shows only the remaining provider; `ASSISTANT_ENABLED=off` → no sparkle toggle and the
rest of the Configure step behaves normally.

---

## 7. Docs

`docs/assistant-guide.md`: three API keys instead of one, `ASSISTANT_ENABLED`, the model picker,
new-chat/history controls, and `ANTHROPIC_MODEL` marked superseded for chat.

---

## 8. Deliberately skipped

- **Per-tenant** assistant flag — the off switch is per deployment; add a column when a deployment
  actually needs to sell it per customer.
- **Folder-removable** package (`rm -rf packages/assistant` still builds) — needs dynamic import at
  the mount point and costs static typing at the seam. The package boundary makes it a later option,
  not a now requirement.
- Rename, delete or archive a conversation — the list is derived; add a table when it's asked for.
- Cross-conversation search, and summarization of threads past the 30-message cap.
- Server-side per-user model preference — localStorage until it demonstrably isn't enough.
- Parallel tool calls, streamed tool arguments, multimodal chat input, per-tenant API keys.
