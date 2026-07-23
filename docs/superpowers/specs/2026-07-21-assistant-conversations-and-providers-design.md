# Assistant: conversations + multi-provider models — design

Extends the configurator assistant (`2026-07-21-configurator-assistant-design.md`) with two things it
lacks: **bounded conversations** (new chat, load a past one) and a **user-switchable model** across
Anthropic, Google and OpenAI behind hand-rolled adapters.

The feature stays where it lives today — `apps/server/src/chat/`, `apps/server/src/orpc/routers/assistant.ts`,
`apps/web/src/components/assistant/`, `packages/db/src/schema/chat.ts`. No new package. Tool semantics,
`ChatPart`, persistence, admission and the revert/AI-marker model are unchanged.

---

## 1. Why

- **Conversations.** A thread today *is* every `config_chat_turn` for a `(tenantId, projectId)` pair.
  Nothing scopes or ends it, so it grows forever and `providerHistory`'s 30-message cap silently
  amputates the oldest context with no way to start clean.
- **Providers.** Anthropic is welded into the turn loop at five points: `TOOLS` (`Anthropic.Tool[]`),
  the `messages` array type, `decideNext`'s stop-reason strings, `toolRoundMessages`' `tool_result`
  block, and the `content_block_delta` stream branch. Everything downstream (`ChatPart`, the DB rows,
  `assistantState.ts`) is already provider-neutral.

---

## 2. Conversations

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
in `apps/server/src/chat/conversations.ts` (same shape as `admission.ts` / `setValues.ts`: pure,
tested, thin router). Title = the first user message, truncated in SQL (`left(parts->0->>'text', 80)`)
so the payload stays small — sequence-0 parts are always exactly `[{ type: "text", text }]`, written by
one hardcoded insert.

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
- `available: boolean` — false when `models` returns `[]`; `ConfigProcessPage` hides the sparkle
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

## 3. Providers

### Neutral types (`apps/server/src/chat/providers/types.ts`)

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

### Registry (`apps/server/src/chat/providers/models.ts`)

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

`availableModels()` returns the entries whose `envKey` is set — it backs `assistant.models` and the
web's `available` flag. `chat` resolves `input.model` the same way and rejects an unavailable id, so a
client cannot select an unconfigured or unknown model.

`ANTHROPIC_MODEL` is **removed** — the picker is the model choice for chat now; the registry is the
only place model ids live. `GEMINI_MODEL` still governs drawing extraction, which is untouched.

The client remembers the last pick in `localStorage["hera.assistant.model"]`, validated against
`assistant.models` on open, falling back to the first available. No user-preference schema.

### Adapters

Each is a pure request mapper + a pure chunk reducer + ~20 lines of stream glue, under
`apps/server/src/chat/providers/`.

| | Anthropic | Google | OpenAI |
|---|---|---|---|
| SDK | `@anthropic-ai/sdk` *(installed)* | `@google/genai` *(installed)* | `openai` **(new dep)** |
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

**No adapter needs multimodal support.** `extract_from_drawing` runs Gemini's extraction path
server-side and returns text plus a `suggestions` part; the drawing never reaches the chat provider.

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

### Loop changes (`apps/server/src/chat/loop.ts`)

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

The `ANTHROPIC_API_KEY` guard becomes a no-configured-models guard naming all three env vars.

---

## 4. Errors

| Case | Behaviour |
|---|---|
| No provider key set at all | `assistant.models` returns `[]`; the web hides the toggle. `chat` also throws `SERVICE_UNAVAILABLE` defensively, naming all three env vars. |
| Unknown / unconfigured `model` | `BAD_REQUEST`; the client re-reads `assistant.models` and falls back |
| Provider API error | unchanged — verbatim `"<status>: <message>"` from that provider's `errorText` |
| Everything else | unchanged (deadline, tool rounds, max tokens, refusal, cancel) |

Switching model mid-conversation is legal and needs no special handling: history reaches every
provider as plain `{ role, text }` turns via `providerHistory`, and `model` is recorded per turn.

---

## 5. Testing

| File | What |
|---|---|
| `chat/providers/providers.test.ts` | **new** — one table-driven file: transcript → each provider's request body, and each provider's chunks → `ProviderEvent`s, including every stop-reason row above |
| `chat/conversations.test.ts` | **new** — `foldConversations`: title truncation, ordering by last activity, one-turn conversation |
| `chat/loop.test.ts` | rewritten against neutral shapes (smaller — no Anthropic fixtures) |
| `chat/setValues.test.ts` | + coercion cases: numeric string, `NaN`, `"true"`, multicombo wrapping |
| `assistantState.test.ts` | unchanged — parts and folding are untouched |

Manual e2e: three keys set → picker lists five models → same question answered by each; new chat →
empty panel, old thread still in the history menu; reload → correct conversation restored; unset all
keys → no sparkle toggle and the rest of the Configure step behaves normally.

---

## 6. Docs

`docs/assistant-guide.md`: three API keys instead of one, the model picker, new-chat/history controls,
and `ANTHROPIC_MODEL` removed (superseded by the registry + picker).

---

## 7. Deliberately skipped

- **Extracting the assistant into its own package** — considered and dropped; it stays in-app for now.
- Rename, delete or archive a conversation — the list is derived; add a table when it's asked for.
- Cross-conversation search, and summarization of threads past the 30-message cap.
- Server-side per-user model preference — localStorage until it demonstrably isn't enough.
- Parallel tool calls, streamed tool arguments, multimodal chat input, per-tenant API keys.
