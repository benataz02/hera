# Configurator Assistant — Agent Backend Design (2026-07-20)

Supersedes the *Backend shape*, *Apply mode*, *Agent reach*, and *Extraction entry point* rows of
`2026-07-19-assistant-chat-design.md`. Pane placement, merged history panels, AI markers,
revert UX, session-only persistence, and the UI kit decisions from that spec stand unchanged.

## Context

The one-shot assist turn is replaced by a **function-calling agent loop**: the user iterates in
chat, the model calls tools (validate values, read drawings, search history, calculate, create
the quote), the server validates every action, and results stream to the browser live. The
assistant's reach now extends through the whole process — fill values → calculate → select
candidates → create quote — with one human confirmation gate before the only action that
leaves the system.

## Decisions

| Axis | Decision |
|---|---|
| Interaction shape | **Server-side function-calling loop** (max 8 iterations) per chat turn; Gemini function calling, not structured output. |
| Transport | **Full token streaming** over an oRPC event iterator (async generator, same transport `quote.watch` proves): reply text streams as deltas, tool activity and applied changes stream as typed events. |
| Agent reach | **Full**: `setValues`, `previewCandidates`, `calculate` (persists), `selectCandidates`, `createQuote`. Every write tool's guard equals its UI button's enabled-condition — the LLM never gets a capability the session user doesn't have. |
| Quote safety | **In-chat confirmation gate**: `createQuote` never executes inside the loop; it emits a `confirm` event (customer, selections, totals) and ends the turn. The user's confirm click starts a new turn carrying `approved`; the server executes then, and outbox dedup makes double-submit harmless. |
| Value application | **Live**: each successful `setValues` emits a `changes` event; the browser applies values + AI markers immediately via `applyAssist` while the model keeps talking. Revert stays per-message as spec'd. |
| Drawing reading | **Dedicated `extractFromDrawing` tool** — a focused Gemini sub-call reusing `buildExtractionRequest` (prompt + enum responseSchema + `inlineData`). The attachment stays *out* of the main loop's contents (sent once per extraction, not re-uploaded every iteration). Applying extracted values still goes through `setValues` — one validation path. |
| State | **Stateless server**: transcript + entries travel with every request (entries are client-authoritative between turns); tools mutate a per-turn working copy mirrored to the browser by events. No session state, no paused connections. |
| Provider | Unchanged: platform `GEMINI_API_KEY`, `GEMINI_MODEL` (default `gemini-3-flash`). |

## Architecture

```
packages/config-engine  src/assist.ts: buildAssistPrompt(...), assistToolDeclarations(model),
                        formatParameterBlock(...) (factored out of extract.ts, shared)
apps/server             routers/assist.ts: assist.chat (userProcedure, async generator)
                        = the loop + tool executor over extracted handler-body functions
apps/web                AssistantPane consumes the event stream: deltas, activity lines,
                        live changes, confirm card, follow-up chips
```

### Turn lifecycle (`assist.chat`)

Input:

```
{ projectId, entries,                       // unsaved local overrides = real state
  messages: [{role, text}] (≤20, ≤4000ch),
  file?: ExtractFileZ,                      // consumed only by extractFromDrawing
  approved?: { tool: "createQuote", args } } // present only on a confirmation resume
```

1. Load project + model, `assertAgentReady` if `needsAgent`, `freshLookups`. Working copy
   `working = {...entries}`; `propagate` for the turn-start snapshot.
2. If `approved`: execute the approved tool **first**; its result (success or failure) opens the
   model context ("the user approved; result: …"). The gate is just two stateless turns.
3. Build system prompt + Gemini contents from the transcript (text only — no inlineData).
4. Loop (≤ 8 iterations): `generateContentStream` with tool declarations. Text parts → `delta`
   events. `functionCall` parts → yield `tool` event → execute → yield result events → append
   `functionResponse` → iterate. No calls → turn done. Cap reached → one forced no-tools
   iteration to wrap up.
5. `createQuote` inside the loop: yield `confirm`, return — never executed.
6. Yield `done` with collected suggestions.

### Event protocol

| Event | Payload | Client reaction |
|---|---|---|
| `delta` | `text` | append to streaming assistant bubble |
| `tool` | `name, label` | activity line ("Searching similar configurations…") |
| `changes` | `[{key, from, to, evidence, valid, reason?}]` | apply live + AI markers; invalid rows flagged, never applied |
| `candidates` | run summary | navigate to Candidates tab (calculate persisted) |
| `confirm` | `{tool, args, summary: {customer, selections, totals}}` | render confirmation card; turn over |
| `error` | `message, retryable` | error bubble + Retry; partial text/changes stay |
| `done` | `{suggestions: string[]}` | close bubble, render follow-up chips |

Mid-turn user edits of the form stay allowed — last write wins; the existing rule (user edit
clears the AI marker) covers it. The input row locks during a turn; the form does not.

## Tool roster

Nine tools; the executor is one `switch` in `routers/assist.ts` closed over
`{ model, lookups, working, tenantId, projectId, file }`. Every case calls a plain function
extracted from an existing handler body (the procedure stays as a thin wrapper — no behavior
change to existing routes). All run inside `userProcedure`'s tenant-membership context.

| Tool | Args → Returns | Backing / guards |
|---|---|---|
| `setValues` | `{values:[{key,value}]}` → per-value `{valid, reason?}`, changed narrowed domains, remaining conflicts, still-unset params | `validateSuggestionSet` on `working`; valid values mutate it + emit `changes`. The rich return powers self-correction. |
| `extractFromDrawing` | `{}` → per-param `{value, evidence}` (nulls omitted) | `callExtraction` (see refactor). Error result if no attachment. |
| `previewCandidates` | `{overrides?}` → top-K candidates + count | Pure `enumerate` + `computeOutputs` on working + overrides. No persistence — the what-if instrument. |
| `calculate` | `{}` → run result | Existing run path (persists). Guard: rejected if conflicts remain or batches empty (= Calculate button condition). Emits `candidates`. |
| `selectCandidates` | `{candidateIds, mode:"add"\|"replace"}` → selection state | Same path as the Candidates UI. Guard: project calculated. |
| `createQuote` | `{}` → never returns in-loop | Quote-create handler body (transactional outbox write) as a callable; executed only on `approved`. Guard: calculated + ≥1 selection. |
| `searchSimilar` | `{}` → top-3 `{score, values, projectRef}` | Extracted `similar` internals. |
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
  when the user wants results and no conflicts remain. createQuote will ask the
  user to confirm — never claim a quote exists until the tool has run.
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
marker tooltips (UI contract). "Never claim a quote exists" guards the confirm-gate seam.

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
- **Approved `createQuote` fails**: failure becomes the tool result the resume turn opens with;
  the model explains and offers retry; outbox dedup makes re-confirm harmless.
- **Client disconnect**: generator abort stops the loop; committed writes stay; lost `changes`
  events don't diverge state because the next request carries the client's entries.

## Limits

`MAX_ITERATIONS = 8`; transcript ≤20 messages × ≤4000 chars; file ≤15MB; 120s turn watchdog;
single platform Gemini key. `// ponytail: per-tenant keys/metering when a tenant asks`

## Testing / Verification

- **config-engine** `assist.test.ts`: prompt has narrowed domains (eliminated absent), current
  values, conflicts, attachment note only with a file; `setValues` declaration enum matches the
  model; confirm-gate + never-guess instructions present. `extract.test.ts` untouched and green
  after the `formatParameterBlock` factor-out.
- **Server executor** (no Gemini): `setValues` applies/flags/rejects-jointly-conflicting; every
  guard fires; dead agent → `{unavailable:true}`.
- **Server loop** (scripted fake `generateContentStream`, injected): text-only → deltas + done;
  functionCall → tool + changes → second iteration; cap → forced wrap-up; `createQuote` →
  confirm + return, not executed; `approved` → executed first; mid-loop throw → error event,
  prior events preserved.
- **Web**: stream-consumer reducer tests (delta appends; changes applies + marks; error keeps
  partials + Retry re-sends current entries; confirm renders card; done renders chips).
  Revert/marker tests carry over unchanged.
- **Manual e2e**: attach drawing → "configure this from the drawing and quote the cheapest
  option" → extraction activity line, form fills live with `ai` chips, calculate lands on
  Candidates, confirm card, Create quote → B1 sync via normal outbox. Mid-turn manual edit
  clears its marker; kill server mid-turn → error bubble, Retry completes.

## Out of scope (named upgrade paths)

- Transcript persistence on the project (portal-review flow will want it).
- Per-tenant AI keys / metering.
- Parallel tool execution within an iteration (sequential is fine at this tool count).
- Multi-file attachments per turn.
