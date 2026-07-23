# Configurator Assistant

## Context

The configuration process page (`ConfigProcessPage`) has three accelerators with separate
surfaces: drawing extraction (header panel), similar-configuration copy + B1 doc history (right
pane), and live domain propagation in the form. This feature unifies them behind a conversational
assistant driven by a **server-side function-calling agent loop**: the user iterates in chat, the
model calls tools (validate values, read drawings, search history, preview, calculate, select
candidates), the server validates every action, and results stream to the browser live.

The assistant is a **separate feature package** (`packages/assistant`) with its own DB tables:
conversations persist per project (list, load, start new, delete), and the user picks the LLM
provider per conversation — Gemini, Anthropic, or OpenAI — through TanStack AI adapters.

**Reach ends at `selectCandidates`.** Quote creation (phase 5: `configs.createQuote` → durable
`agent_request` row → agent posts a B1 Quotation idempotently) does not exist anywhere yet — no
server procedure, no agent kind, the Create quote step is a `ToBeDone` placeholder — so the
agent gets no `createQuote` tool and no confirmation gate. The full confirm-gate design is
preserved under *Upgrade paths* for when phase 5 lands.

## Decisions

| Axis | Decision |
|---|---|
| Interaction shape | **Server-side function-calling loop** (max 8 iterations) per chat turn, run by TanStack AI's `chat()` with zod `toolDefinition()` tools. |
| Transport | **Full token streaming** over an oRPC event iterator (async-generator handler). This is the repo's **first** SSE endpoint — the old `quote.watch` precedent died with the outbox rework; oRPC supports this natively over the existing Hono RPC handler. The server translates TanStack AI stream chunks into our event protocol. |
| Placement | **`packages/assistant`** owns the loop, provider registry, tool declarations, prompt builder, conversation schema, and an oRPC router factory. `apps/server` mounts the router and injects the db instance + tool executors (they need server context: lookups, validation, runs, extraction). UI stays in `apps/web`. |
| Provider | **User-switchable per conversation**: Gemini / Anthropic / OpenAI via `@tanstack/ai` + `@tanstack/ai-gemini` / `-anthropic` / `-openai` adapters. Platform env keys (`GEMINI_API_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`) + per-provider `*_MODEL` overrides; the picker lists only providers whose key is set. All `@tanstack/ai*` packages are 0.x — pin versions; the package boundary contains API churn. |
| Persistence | **DB-backed conversations, per project**: `assistant_conversation` + `assistant_message` tables owned by the package (migrations still generated from `packages/db`). "New chat" starts a fresh conversation; past ones are listable, loadable, and deletable. AI markers and revert stay **live-session only**. |
| State | Transcript is **server-authoritative** (loaded from DB by `conversationId`) and stored in **TanStack AI's normalized message format including tool-call/tool-result parts** — the model sees its own earlier tool activity, and each adapter converts to the provider's native wire shapes per request (full fidelity with the selected provider, no provider lock-in). `entries` remain **client-authoritative** between turns and travel with every request; tools mutate a per-turn working copy mirrored to the browser by events. |
| Agent reach | `setValues`, `extractFromDrawing`, `previewCandidates`, `calculate` (persists), `selectCandidates`, `searchSimilar`, `getDocHistory`, `suggestFollowUps`. Every write tool's guard equals its UI button's enabled-condition. **No `createQuote`** (phase 5 unbuilt). |
| Value application | **Live**: each successful `setValues` emits a `changes` event; the browser applies values + AI markers immediately while the model keeps talking. Revert stays per-message. |
| Drawing reading | **Dedicated `extractFromDrawing` tool** — delegates to the existing Gemini extraction path (`callExtraction` + `buildExtractionRequest`) **regardless of the chat provider**; the attachment stays *out* of the main loop's contents. No `GEMINI_API_KEY` → the tool returns an error result the model relays. Applying extracted values still goes through `setValues` — one validation path. |
| Pane placement | **Right splitter pane, not a step**: `CONFIG_PROCESS_STEP_IDS` stays `["configure","candidates","quote"]`. The chat lives where `HistoryPane` lived; the form stays visible while values land; the chat keeps working on the Candidates step. |
| History | **Merged into the pane**: "Similar configurations" and "Document history" as collapsible Panels (collapsed by default) above the chat — current `HistoryPane` content with Copy intact, no LLM involved. The standalone history pane disappears. |
| Form feedback | **Persistent AI marker**: assistant-set fields get an `ObjectStatus state="Information"` chip with `sap-icon://ai` beside the control (same slot as the `defaulted → "auto"` chip), tooltip = evidence. Cleared when the user edits that field or reverts. |
| Follow-ups | **Model-proposed suggestion chips** via the `suggestFollowUps` tool (≤3, short user-voice prompts), rendered under the latest assistant reply only; clicking sends that text. |
| UI kit | `@ui5/webcomponents-ai-react` (installed): `PromptInput` for input. No UI5 chat component exists, so the log is composed from standard components. The frontend keeps our domain event protocol — no `@tanstack/ai-react` (its chat client doesn't model `changes`/`candidates`/`selection`). |

## Architecture

```
packages/assistant      src/schema.ts    assistant_conversation + assistant_message (Drizzle pgTable)
                        src/provider.ts  provider registry from env; listAvailable()
                        src/tools.ts     toolDefinition() declarations (zod inputs); execution injected
                        src/prompt.ts    buildAssistPrompt(...) — imports formatParameterBlock
                        src/router.ts    createAssistantRouter(base, deps):
                                         assist.{providers,list,get,delete,chat}
packages/config-engine  exports formatParameterBlock(...) factored out of extract.ts — one source
                        of truth for how parameters are described to any LLM
packages/db             drizzle.config.ts `schema` becomes an array that also includes
                        ../assistant/src/schema.ts — one migration pipeline, no runtime dep
apps/server             mounts createAssistantRouter(userProcedure, { db, executors }) — the
                        executors close over server context (lookups, validateSuggestionSet,
                        executeRun, select path, similarity, doc history, callExtraction)
apps/web                AssistantPane.tsx (new) consumes the event stream: deltas, activity lines,
                        live changes, follow-up chips, conversation switcher. ConfigProcessPage
                        swaps it in for HistoryPane; ConfiguratorForm gains the aiMarks chip.
```

Groundwork that already exists: `validateSuggestionSet` (combined-state validation,
`apps/server/src/extraction.ts`), `calculate(calculationEntries)` + `buildCalculationUpdate` on
the process page, `configs.run` delegating to `executeRun`.

### Conversations

- `assistant_conversation`: `id, tenantId, projectId, provider, model, title` (first user
  message, truncated), `createdAt, updatedAt`.
- `assistant_message`: `id, conversationId, role, content` (jsonb with two keys — `ui`: what the
  pane renders, `{text, changes?, invalid?, suggestions?, fileName?}`; `model`: the TanStack AI
  normalized message incl. tool-call/tool-result parts, replayed to the LLM on later turns),
  `createdAt`. Storing both beats re-deriving one from the other on every load.
- Procedures (all through `userProcedure`'s tenant-membership context, conversation rows
  additionally checked against the tenant):
  - `assist.providers` → `[{provider, model, available}]` from which env keys are set.
  - `assist.list({projectId})` → conversation summaries, newest first.
  - `assist.get({conversationId})` → messages for rendering a loaded conversation.
  - `assist.delete({conversationId})` → hard delete (cascade messages).
  - `assist.chat` (below) — `conversationId` absent ⇒ creates the conversation on first turn
    (provider from the request, title from the message).
- Persistence timing: the user message is written at turn start; the assistant message is
  written in a `finally` with whatever accumulated (partial text/changes survive disconnects
  and mid-stream errors).
- Provider is stored on the conversation and switchable mid-conversation — safe because
  messages persist in TanStack AI's provider-neutral format; the adapter regenerates the
  native shapes (Anthropic `tool_use` blocks, Gemini `functionCall` parts, OpenAI `tool_calls`)
  from it on every request. Provider-only artifacts (e.g. thinking blocks) are not persisted.

### Turn lifecycle (`assist.chat`)

Input:

```
{ projectId, conversationId?,               // absent → create
  provider?,                                // used on create / switch; must be available
  entries,                                  // unsaved local overrides = real state
  message (≤4000ch),
  file?: ExtractFileZ }                     // consumed only by extractFromDrawing
```

1. Load project + model, `assertAgentReady` if `needsAgent`, `freshLookups`. Load (or create)
   the conversation; persist the user message; load the last 20 messages as the transcript.
   Working copy `working = {...entries}`; `propagate` for the turn-start snapshot.
2. Build system prompt + the transcript's normalized messages (text and tool-call/result
   parts; never file bytes — those stay out of the loop context).
3. Run TanStack AI `chat()` with the adapter for the conversation's provider and the tool set
   (≤8 iterations, then one forced no-tools wrap-up). Stream chunks translate to events:
   text → `delta`; tool start → `tool`; tool executions run the injected executors and emit
   their domain events (`changes`, `candidates`, `selection`).
4. Yield `done` with suggestions collected via `suggestFollowUps`; persist the assistant
   message (`ui` render shape + `model` normalized parts). Replayed tool results from old
   turns can carry stale domain snapshots — harmless because the system prompt's turn-start
   snapshot is rebuilt fresh every turn and instructed as authoritative.

### Event protocol

| Event | Payload | Client reaction |
|---|---|---|
| `delta` | `text` | append to streaming assistant bubble |
| `tool` | `name, label` | activity line ("Searching similar configurations…") |
| `changes` | `[{key, from, to, evidence, valid, reason?}]` | apply live + AI markers; invalid rows flagged, never applied |
| `candidates` | run summary | invalidate `configs.get`, jump to Candidates tab (calculate persisted) |
| `selection` | saved selection state | invalidate + reflect picks |
| `conversation` | `{id, title, provider}` | first turn of a new conversation: adopt the id |
| `error` | `message, retryable` | error bubble + Retry; partial text/changes stay |
| `done` | `{suggestions: string[]}` | close bubble, render follow-up chips |

The `selection` event exists because of a state asymmetry: `setValues` mutates only the
client-authoritative working copy (mirrored by `changes`), but `calculate` and `selectCandidates`
persist server state mid-turn — the browser must invalidate its query cache when that happens,
not at `done`.

Mid-turn user edits of the form stay allowed — last write wins; a user edit clears that field's
AI marker. The input row locks during a turn; the form does not.

## Tool roster

Eight tools declared once in `packages/assistant/src/tools.ts` with zod input schemas via
`toolDefinition()`; execution is injected by `apps/server` as plain functions extracted from
existing handler bodies (the procedures stay thin wrappers — no behavior change to existing
routes). All run inside `userProcedure`'s tenant-membership context, closed over
`{ model, lookups, working, tenantId, projectId, file }`.

| Tool | Args → Returns | Backing / guards |
|---|---|---|
| `setValues` | `{values:[{key,value}]}` → per-value `{valid, reason?}`, changed narrowed domains, remaining conflicts, still-unset params | `validateSuggestionSet` on `working`; valid values mutate it + emit `changes`. The rich return powers self-correction. |
| `extractFromDrawing` | `{}` → per-param `{value, evidence}` (nulls omitted) | `callExtraction` (see refactor) — always Gemini. Error result if no attachment or no `GEMINI_API_KEY`. |
| `previewCandidates` | `{overrides?}` → top-K candidates + count | Pure `enumerate` + `computeOutputs` on working + overrides. No persistence — the what-if instrument. |
| `calculate` | `{}` → run summary | Persist working entries via the `update` path, then `executeRun` — exactly the UI's `calculate()`. Guard: rejected if conflicts remain or batches empty (= Calculate button condition). Emits `candidates`. |
| `selectCandidates` | `{selections:[{candidateIdx, batchQty}], mode:"add"\|"replace"}` → selection state | Extracted `select` path (totals recomputed server-side from the run snapshot — client/LLM numbers never persisted). Guard: latest run exists and is not stale (mirrors the Candidates tab condition: project calculated, working entries/batches unchanged since the run). Emits `selection`. |
| `searchSimilar` | `{}` → top-3 `{score, values, display}` | Extracted `similar` internals. |
| `getDocHistory` | `{itemCode?}` → doc rows | Extracted `docHistory` internals via agent; agent failure → `{unavailable:true}` tool result, never a dead turn. |
| `suggestFollowUps` | `{suggestions: string[]}` (≤3) → no-op | Stashed for `done`. A tool (not structured output) so it works identically on all three providers. Model forgets → empty chips, no error. |

### Extraction refactor (`apps/server/src/orpc/routers/extraction.ts`)

Split `extractSuggestions` into:
- `callExtraction(model, lookups, file) → raw parsed record` — key check, Gemini call with
  `buildExtractionRequest`, JSON parse, error mapping. Shared core.
- `extraction.extract` (portal/standalone) = `callExtraction` + `validateSuggestions(…, {}, raw)`
  — behavior unchanged; existing tests must keep passing.
- The assistant's tool executor = `callExtraction` + format as tool result.

## System prompt

`buildAssistPrompt(model, propagated, entries, ctx: {customer, status, selections, attachment?})`
in `packages/assistant/src/prompt.ts` — pure, rebuilt fresh every turn (turn-start snapshot;
`setValues` returns keep the model current mid-turn). Section order: role → domain context →
parameters → current state → rules (stable first, rules last).

```
You are the configuration assistant for "{model.name}". You work beside a sales
user who sees the product configuration form at all times; values you set appear
in it immediately, marked as AI-set, and the user can revert any of them.

{model.extraction.context}

## Parameters
- {key}: {label} ({type}{, unit}) — {help}
  Current: {entries[key] ?? "not set"}{ (defaulted)}
  Allowed: {narrowed domain / range}          ← eliminated options excluded
  {Hint: extractionHint}

## Current state
Customer: {cardCode — name}
Project status: {draft | calculated}; {n} candidates, {m} selected
Open conflicts: {messages | "none"}
{Attachment: "{name}" ({mimeType}) — use extractFromDrawing to read it.}

## How to work
- Values go through setValues only. Its result tells you what was rejected and
  why, and how the allowed values narrowed — fix rejections yourself when the
  user's intent is clear; ask only when it genuinely is not.
- Never invent a value. Every value must come from the user's words, the drawing
  (via extractFromDrawing), or a past configuration (searchSimilar /
  getDocHistory) — and its evidence string must say which.
- Explore what-ifs with previewCandidates; it changes nothing. Run calculate only
  when the user wants results and no conflicts remain. selectCandidates saves the
  user's picks on the current run.
- You cannot create quotations — the user does that from the Create quote step
  after selecting candidates. Never claim a quote exists or will be created.
- Prefer acting over describing: if the user asks for something a tool does, call
  the tool. Don't narrate a plan without executing it, and don't re-state the
  form — the user is looking at it.
- Reply in the user's language. Be brief; short sentences over lists when a few
  values are involved.
- Before your final reply of a turn, call suggestFollowUps with up to 3 short
  next-step prompts phrased in the user's voice ("Fill the remaining 3
  parameters", "Calculate candidates" — the latter only when no conflicts
  remain). Skip suggestions that don't apply.
```

The parameter block reuses `extract.ts` formatting via the shared `formatParameterBlock`
(exported from `packages/config-engine`) — one source of truth for how parameters are described
to the LLM. Evidence discipline feeds the marker tooltips (UI contract). The
no-quote-capability line stops the model from promising an action it doesn't have.

## Frontend

### Pane layout

```
┌─ Assistant ──────────────────┐
│ [model ▾]      [🗂 chats] [+] │  ← provider picker, conversation list, new chat
│ ▸ Similar configurations (3) │  ← collapsible Panels, collapsed by default,
│ ▸ Document history           │    HistoryPane content + Copy buttons (no LLM)
│ ─────────────────────────────│
│  (scrollable chat log)       │
│  (follow-up chips)           │
│  [attach] [PromptInput    ➤] │
└──────────────────────────────┘
```

- The title-bar `History` ToggleButton becomes **Assistant** (icon `ai`); same open/close
  animation, same default-open heuristic (`model.definition.history` present).
- Header row: provider `Select` (only available providers; value = conversation's provider,
  changeable anytime), conversation list popover (`assist.list`: title + relative time +
  per-item delete), **New chat** button (drops `conversationId`; next send creates one).
- The pane is step-independent: values applied while on Candidates make `entries` dirty — the
  existing `staleRun` banner and tab-disabling already handle that.

### `AssistantPane.tsx`

- Props `{ projectId, model, lookups, entries, onApply, onCandidates, onSelection, onCopy,
  paneOpen, chat? }` — `onCandidates`/`onSelection` are the page's reactions to the
  server-persisting events (invalidate + navigate / invalidate + reset `selOverride`); `chat` is
  the injectable stream-consumer for tests (ExtractPanel precedent).
- Conversation state: `conversationId` in component state; `assist.get` hydrates the log when
  one is loaded from the list. Loaded (pre-session) messages render read-only: change lines
  show as history without revert buttons, and set no AI markers — revert and markers apply only
  to messages streamed in the live session (a persisted `from` is stale against today's
  entries).
- Top: the two history Panels — `HistoryPane`'s internals embedded (queries keep `paneOpen`
  gating; Copy routes through the existing `copyValues` fill-empty-only path, which does **not**
  set AI markers — only chat-applied values do).
- Message shape: `{ role, text, changes?, invalid?, suggestions?, file? }` with
  `changes: [{ key, from, to, evidence, reverted }]` — the same shape persisted in
  `assistant_message.content`.
- Assistant message renders: streaming reply text → activity lines (from `tool` events) → one
  line per applied change (`Label: old → new` as `ObjectStatus Information`, evidence in small
  muted text beneath) with per-line **↩ revert** → invalid values as `ObjectStatus Negative` +
  reason (never applied) → **Revert all** (shown when ≥2 changes). Reverted lines render
  struck-through.
- Suggestion chips under the latest assistant message only; clicking sends that text. User
  bubbles right-aligned; attachment shown as removable `Tag`.
- Empty state: three starter chips — "What's left to fill?", "Fill this from a drawing",
  "Copy my most similar past config".
- Input row: `PromptInput` (Enter/AI button → send) + attach `Button` in `FileUploader
  hideInput`. Streaming turn: input disabled; the live bubble is the busy indicator.
- Revert per value: restore `from` (delete the entry if `from` was undefined), flag the line
  `reverted`, clear its AI marker. Revert all = revert every non-reverted line of that message.
  Last-write-wins snapshot restore. `// ponytail: snapshot restore, no op-log; fine for visible session state`
- File validation client-side before sending — `toBase64` + MIME map exported from
  `ExtractPanel.tsx` and reused.

### `ConfigProcessPage.tsx` + `ConfiguratorForm.tsx` integration

- Right `SplitterElement` hosts `AssistantPane` instead of `HistoryPane`; remove `<ExtractPanel>`
  from `pageHeader`.
- **AI markers**: new state `aiMarks: Map<paramKey, evidence>`. `changes` events set marks;
  the form's `onChange` wrapper diffs old vs new entries and clears the marker of any key the
  *user* changed; revert clears marks too. `ConfiguratorForm` takes an optional `aiMarks` prop
  and renders the chip beside the control in the `defaulted → "auto"` slot.
- `candidates` event: invalidate `configs.get`, `setStep(POST_RUN_STEP)` — same as the Calculate
  button's success path. `selection` event: invalidate + reset local `selOverride`.
- Mid-turn manual edits allowed; the streaming turn locks only the chat input.

## Error handling

Rule: **errors the model can act on go into the loop; errors it can't end the turn.**

- **Tool-level → tool result, loop continues**: zod-validated args (bad → "invalid
  arguments: …", model retries); domain guards return their reason; history tools return
  `{unavailable:true}` on agent failure; `extractFromDrawing` returns an error result when the
  Gemini key is missing.
- **Pre-stream** (requested provider's key not set / >15MB / agent not ready / project or
  conversation not found): normal `ORPCError`s, identical mapping to extraction.
- **Mid-stream** (provider or infrastructure failure): yield `{type:"error", retryable}` and
  return — streamed partials stay (applied values passed validation) and the partial assistant
  message is persisted by the `finally`. Retry re-sends the same message with current entries;
  safe because entries are client-authoritative between turns.
- **Iteration cap**: not an error — forced no-tools wrap-up, then `done`.
- **Turn timeout**: 120s watchdog → `error` retryable.
- **Client disconnect**: generator abort stops the loop; committed writes (a persisted run or
  selection, the partial assistant message) stay; lost `changes` events don't diverge state
  because the next request carries the client's entries, and the query-cache invalidation on
  reload shows persisted state.

## Limits

`MAX_ITERATIONS = 8`; transcript = last 20 messages loaded per turn; message ≤4000 chars; file
≤15MB; 120s turn watchdog; platform env keys (`GEMINI_API_KEY`, `ANTHROPIC_API_KEY`,
`OPENAI_API_KEY` + optional `*_MODEL` overrides with pinned defaults). `@tanstack/ai*` pinned
(0.x). `// ponytail: per-tenant keys/metering when a tenant asks`

## Testing / Verification

- **assistant** `prompt.test.ts`: prompt has narrowed domains (eliminated absent), current
  values, conflicts, attachment note only with a file; `setValues` declaration enum matches the
  model; never-guess + no-quote-capability instructions present. `provider.test.ts`:
  `listAvailable` reflects env keys. `extract.test.ts` (config-engine) untouched and green
  after the `formatParameterBlock` factor-out.
- **Server executor** (no LLM): `setValues` applies/flags/rejects-jointly-conflicting; every
  guard fires (conflicted calculate rejected; stale-run selectCandidates rejected); dead agent →
  `{unavailable:true}`.
- **Server loop** (scripted fake TanStack AI adapter, injected): text-only → deltas + done;
  tool call → tool + changes → second iteration; cap → forced wrap-up; calculate →
  `candidates` event; selectCandidates → `selection` event; mid-loop throw → error event, prior
  events preserved **and** partial assistant message persisted.
- **Conversations**: CRUD procedures tenant-scoped (foreign tenant's conversation → not found);
  chat with no `conversationId` creates one and emits `conversation`; transcript truncation at
  20; delete cascades messages; persisted `model` parts round-trip — a turn with tool calls is
  replayed to the next turn's adapter with those tool-call/result parts intact.
- **Web**: stream-consumer reducer tests (delta appends; changes applies + marks; `selection`
  invalidates and reflects picks; error keeps partials + Retry re-sends current entries; done
  renders chips). Revert/marker tests as spec'd. Conversation switch/load: loaded messages
  read-only (no revert, no markers); New chat clears the log and next send creates.
- **Manual e2e**: attach drawing → "configure this from the drawing and pick the cheapest
  option" → extraction activity line, form fills live with `ai` chips, calculate lands on
  Candidates, selection saved via chat. Switch provider mid-conversation and continue. Reload →
  conversation loads read-only; New chat → fresh; delete removes from list. Mid-turn manual
  edit clears its marker; kill server mid-turn → error bubble, Retry completes; unset all
  provider keys shows the friendly error.

## Upgrade paths (out of scope)

- **`createQuote` + confirmation gate** (blocked on phase 5 — quote creation does not exist:
  no `configs.createQuote`, no durable agent `quote` kind, Quote step is `ToBeDone`; the schema
  already reserves `configRun.b1DocEntry`/`quotedAt`). When it lands, the preserved design is:
  a `createQuote` tool that **never executes inside the loop** — it yields a `confirm` event
  (customer, selections, totals) and ends the turn; the user's confirm click starts a new turn
  carrying `approved: { tool: "createQuote", args }`; the server executes the approved tool
  *first* and its result (success or failure) opens the model context; dedup on the durable
  request row makes double-submit harmless. Guard: calculated + ≥1 selection. Prompt line
  "never claim a quote exists until the tool has run" replaces the current no-capability line.
- Drawing extraction through the active provider's vision (today: always Gemini).
- Per-tenant AI keys / metering.
- Parallel tool execution within an iteration (sequential is fine at this tool count).
- Multi-file attachments per turn.
