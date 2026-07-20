# Configurator Agent — Consolidated Design (2026-07-20)

Replaces the deleted `2026-07-19-assistant-chat-design.md` and
`2026-07-20-assistant-agent-backend-design.md` (recoverable at `637430d` / `1a24520`) and the
condensed `assistant-decisions` notes. Self-contained: frontend and backend of the configurator
assistant in one spec, updated for what the codebase actually contains today.

## Context

The configuration process page (`ConfigProcessPage`) has three accelerators with separate
surfaces: drawing extraction (header panel), similar-configuration copy + B1 doc history (right
pane), and live domain propagation in the form. This feature unifies them behind a conversational
assistant driven by a **server-side function-calling agent loop**: the user iterates in chat, the
model calls tools (validate values, read drawings, search history, preview, calculate, select
candidates), the server validates every action, and results stream to the browser live.

**Reach ends at `selectCandidates`.** Quote creation (phase 5: `configs.createQuote` → durable
`agent_request` row → agent posts a B1 Quotation idempotently) does not exist anywhere yet — no
server procedure, no agent kind, the Create quote step is a `ToBeDone` placeholder — so the
agent gets no `createQuote` tool and no confirmation gate. The full confirm-gate design is
preserved under *Upgrade paths* for when phase 5 lands.

## Decisions

| Axis | Decision |
|---|---|
| Interaction shape | **Server-side function-calling loop** (max 8 iterations) per chat turn; Gemini function calling, not structured output. |
| Transport | **Full token streaming** over an oRPC event iterator (async-generator handler). This is the repo's **first** SSE endpoint — the old `quote.watch` precedent died with the outbox rework; oRPC supports this natively over the existing Hono RPC handler. |
| Agent reach | `setValues`, `extractFromDrawing`, `previewCandidates`, `calculate` (persists), `selectCandidates`, `searchSimilar`, `getDocHistory`, `suggestFollowUps`. Every write tool's guard equals its UI button's enabled-condition. **No `createQuote`** (phase 5 unbuilt). |
| Value application | **Live**: each successful `setValues` emits a `changes` event; the browser applies values + AI markers immediately while the model keeps talking. Revert stays per-message. |
| Drawing reading | **Dedicated `extractFromDrawing` tool** — focused Gemini sub-call reusing `buildExtractionRequest`. The attachment stays *out* of the main loop's contents. Applying extracted values still goes through `setValues` — one validation path. |
| State | **Stateless server**: transcript + entries travel with every request (entries are client-authoritative between turns); tools mutate a per-turn working copy mirrored to the browser by events. No session state. |
| Placement | **Right splitter pane, not a step**: `CONFIG_PROCESS_STEP_IDS` stays `["configure","candidates","quote"]`. The chat lives where `HistoryPane` lived; the form stays visible while values land; the chat keeps working on the Candidates step. |
| History | **Merged into the pane**: "Similar configurations" and "Document history" as collapsible Panels (collapsed by default) above the chat — current `HistoryPane` content with Copy intact, no LLM involved. The standalone history pane disappears. |
| Form feedback | **Persistent AI marker**: assistant-set fields get an `ObjectStatus state="Information"` chip with `sap-icon://ai` beside the control (same slot as the `defaulted → "auto"` chip), tooltip = evidence. Cleared when the user edits that field or reverts. |
| Follow-ups | **Model-proposed suggestion chips** via the `suggestFollowUps` tool (≤3, short user-voice prompts), rendered under the latest assistant reply only; clicking sends that text. |
| Persistence | **Session-only**: chat and AI markers live in component state, gone on reload. Applied values persist through the normal Calculate/update path. `// ponytail: store transcript on project when the portal-review flow needs it` |
| Extraction entry point | The chat **absorbs extraction on this page**: attaching a PDF/PNG/JPEG adds it as `inlineData`. `ExtractPanel` leaves the page header; the component and `extraction.extract` stay for the portal. |
| Provider | Reuse the extraction Gemini setup verbatim: platform `GEMINI_API_KEY`, `GEMINI_MODEL` (default `gemini-3-flash`). |
| UI kit | `@ui5/webcomponents-ai-react` (installed): `PromptInput` for input. No UI5 chat component exists, so the log is composed from standard components. |

## Architecture

```
packages/config-engine  src/assist.ts (new, pure): buildAssistPrompt(...), assistToolDeclarations(model),
                        formatParameterBlock(...) factored out of extract.ts and shared by both
apps/server             src/orpc/routers/assist.ts (new): assist.chat (userProcedure, async generator)
                        = the loop + tool executor (one switch) over extracted handler-body functions
apps/web                AssistantPane.tsx (new) consumes the event stream: deltas, activity lines,
                        live changes, follow-up chips. ConfigProcessPage swaps it in for HistoryPane;
                        ConfiguratorForm gains the aiMarks chip.
```

Groundwork that already exists: `validateSuggestionSet` (combined-state validation,
`apps/server/src/extraction.ts`), `calculate(calculationEntries)` + `buildCalculationUpdate` on
the process page, `configs.run` delegating to `executeRun`.

### Turn lifecycle (`assist.chat`)

Input:

```
{ projectId, entries,                       // unsaved local overrides = real state
  messages: [{role, text}] (≤20, ≤4000ch),
  file?: ExtractFileZ }                     // consumed only by extractFromDrawing
```

1. Load project + model, `assertAgentReady` if `needsAgent`, `freshLookups`. Working copy
   `working = {...entries}`; `propagate` for the turn-start snapshot.
2. Build system prompt + Gemini contents from the transcript (text only — no inlineData).
3. Loop (≤8 iterations): `generateContentStream` with tool declarations. Text parts → `delta`
   events. `functionCall` parts → yield `tool` event → execute → yield result events → append
   `functionResponse` → iterate. No calls → turn done. Cap reached → one forced no-tools
   iteration to wrap up.
4. Yield `done` with suggestions collected via `suggestFollowUps`.

### Event protocol

| Event | Payload | Client reaction |
|---|---|---|
| `delta` | `text` | append to streaming assistant bubble |
| `tool` | `name, label` | activity line ("Searching similar configurations…") |
| `changes` | `[{key, from, to, evidence, valid, reason?}]` | apply live + AI markers; invalid rows flagged, never applied |
| `candidates` | run summary | invalidate `configs.get`, jump to Candidates tab (calculate persisted) |
| `selection` | saved selection state | invalidate + reflect picks |
| `error` | `message, retryable` | error bubble + Retry; partial text/changes stay |
| `done` | `{suggestions: string[]}` | close bubble, render follow-up chips |

The `selection` event exists because of a state asymmetry: `setValues` mutates only the
client-authoritative working copy (mirrored by `changes`), but `calculate` and `selectCandidates`
persist server state mid-turn — the browser must invalidate its query cache when that happens,
not at `done`.

Mid-turn user edits of the form stay allowed — last write wins; a user edit clears that field's
AI marker. The input row locks during a turn; the form does not.

## Tool roster

Eight tools; the executor is one `switch` in `routers/assist.ts` closed over
`{ model, lookups, working, tenantId, projectId, file }`. Every case calls a plain function
extracted from an existing handler body (the procedure stays a thin wrapper — no behavior change
to existing routes). All run inside `userProcedure`'s tenant-membership context.

| Tool | Args → Returns | Backing / guards |
|---|---|---|
| `setValues` | `{values:[{key,value}]}` → per-value `{valid, reason?}`, changed narrowed domains, remaining conflicts, still-unset params | `validateSuggestionSet` on `working`; valid values mutate it + emit `changes`. The rich return powers self-correction. |
| `extractFromDrawing` | `{}` → per-param `{value, evidence}` (nulls omitted) | `callExtraction` (see refactor). Error result if no attachment. |
| `previewCandidates` | `{overrides?}` → top-K candidates + count | Pure `enumerate` + `computeOutputs` on working + overrides. No persistence — the what-if instrument. |
| `calculate` | `{}` → run summary | Persist working entries via the `update` path, then `executeRun` — exactly the UI's `calculate()`. Guard: rejected if conflicts remain or batches empty (= Calculate button condition). Emits `candidates`. |
| `selectCandidates` | `{selections:[{candidateIdx, batchQty}], mode:"add"\|"replace"}` → selection state | Extracted `select` path (totals recomputed server-side from the run snapshot — client/LLM numbers never persisted). Guard: latest run exists and is not stale (mirrors the Candidates tab condition: project calculated, working entries/batches unchanged since the run). Emits `selection`. |
| `searchSimilar` | `{}` → top-3 `{score, values, display}` | Extracted `similar` internals. |
| `getDocHistory` | `{itemCode?}` → doc rows | Extracted `docHistory` internals via agent; agent failure → `{unavailable:true}` tool result, never a dead turn. |
| `suggestFollowUps` | `{suggestions: string[]}` (≤3) → no-op | Stashed for `done`. Needed because Gemini does not combine `responseSchema` with function calling. Model forgets → empty chips, no error. |

### Extraction refactor (`apps/server/src/orpc/routers/extraction.ts`)

Split `extractSuggestions` into:
- `callExtraction(model, lookups, file) → raw parsed record` — key check, Gemini call with
  `buildExtractionRequest`, JSON parse, error mapping. Shared core.
- `extraction.extract` (portal/standalone) = `callExtraction` + `validateSuggestions(…, {}, raw)`
  — behavior unchanged; existing tests must keep passing.
- The agent tool executor = `callExtraction` + format as tool result.

## System prompt

`buildAssistPrompt(model, propagated, entries, ctx: {customer, status, selections, attachment?})`
in `packages/config-engine/src/assist.ts` — pure, rebuilt fresh every turn (turn-start snapshot;
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

The parameter block reuses `extract.ts` formatting via the shared `formatParameterBlock` — one
source of truth for how parameters are described to the LLM. Evidence discipline feeds the
marker tooltips (UI contract). The no-quote-capability line stops the model from promising an
action it doesn't have.

## Frontend

### Pane layout

```
┌─ Assistant ──────────────────┐
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
- The pane is step-independent: values applied while on Candidates make `entries` dirty — the
  existing `staleRun` banner and tab-disabling already handle that.

### `AssistantPane.tsx`

- Props `{ projectId, model, lookups, entries, onApply, onCandidates, onSelection, onCopy,
  paneOpen, chat? }` — `onCandidates`/`onSelection` are the page's reactions to the
  server-persisting events (invalidate + navigate / invalidate + reset `selOverride`); `chat` is
  the injectable stream-consumer for tests (ExtractPanel precedent).
- Top: the two history Panels — `HistoryPane`'s internals embedded (queries keep `paneOpen`
  gating; Copy routes through the existing `copyValues` fill-empty-only path, which does **not**
  set AI markers — only chat-applied values do).
- Message shape: `{ role, text, changes?, invalid?, suggestions?, file? }` with
  `changes: [{ key, from, to, evidence, reverted }]`.
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

- **Tool-level → `functionResponse`, loop continues**: zod-validated args (bad → "invalid
  arguments: …", model retries); domain guards return their reason; history tools return
  `{unavailable:true}` on agent failure.
- **Pre-stream** (no key / >15MB / agent not ready / project not found): normal `ORPCError`s,
  identical mapping to extraction.
- **Mid-stream** (Gemini or infrastructure failure): yield `{type:"error", retryable}` and
  return — streamed partials stay (applied values passed validation). Retry re-sends the same
  message with current entries; safe because entries are client-authoritative between turns.
- **Iteration cap**: not an error — forced no-tools wrap-up, then `done`.
- **Turn timeout**: 120s watchdog → `error` retryable.
- **Client disconnect**: generator abort stops the loop; committed writes (a persisted run or
  selection) stay; lost `changes` events don't diverge state because the next request carries
  the client's entries, and the query-cache invalidation on reload shows persisted state.

## Limits

`MAX_ITERATIONS = 8`; transcript ≤20 messages × ≤4000 chars; file ≤15MB; 120s turn watchdog;
single platform Gemini key. `// ponytail: per-tenant keys/metering when a tenant asks`

## Testing / Verification

- **config-engine** `assist.test.ts`: prompt has narrowed domains (eliminated absent), current
  values, conflicts, attachment note only with a file; `setValues` declaration enum matches the
  model; never-guess + no-quote-capability instructions present. `extract.test.ts` untouched and
  green after the `formatParameterBlock` factor-out.
- **Server executor** (no Gemini): `setValues` applies/flags/rejects-jointly-conflicting; every
  guard fires (conflicted calculate rejected; stale-run selectCandidates rejected); dead agent →
  `{unavailable:true}`.
- **Server loop** (scripted fake `generateContentStream`, injected): text-only → deltas + done;
  functionCall → tool + changes → second iteration; cap → forced wrap-up; calculate →
  `candidates` event; selectCandidates → `selection` event; mid-loop throw → error event, prior
  events preserved.
- **Web**: stream-consumer reducer tests (delta appends; changes applies + marks; `selection`
  invalidates and reflects picks; error keeps partials + Retry re-sends current entries; done
  renders chips). Revert/marker tests as spec'd.
- **Manual e2e**: attach drawing → "configure this from the drawing and pick the cheapest
  option" → extraction activity line, form fills live with `ai` chips, calculate lands on
  Candidates, selection saved via chat. Mid-turn manual edit clears its marker; kill server
  mid-turn → error bubble, Retry completes; unset `GEMINI_API_KEY` shows the friendly error.

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
- Transcript persistence on the project (portal-review flow will want it).
- Per-tenant AI keys / metering.
- Parallel tool execution within an iteration (sequential is fine at this tool count).
- Multi-file attachments per turn.
