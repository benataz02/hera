# Configurator AI Assistant Chat — Design Spec (2026-07-19)

## Context

The configuration process page (`ConfigProcessPage`) already has three accelerators, each with its
own UI surface: drawing extraction (header panel), similar-configuration copy and B1 doc history
(right-hand pane), and live domain propagation in the form. This feature unifies them behind a
conversational assistant — a chat tab that fills parameters on request, reads attached drawings,
cites past configurations, and can trigger Calculate — turning configuration into a dialogue
instead of form-filling. The page was pre-wired for it: the footer comment "Assistant shares the
Configure footer" and `step <= 1` math assume a 4-step layout that this feature completes.

## Decisions (settled in brainstorming)

| Axis | Decision |
|---|---|
| Apply mode | **Agent-style auto-apply**: valid values go straight into local `entries`; each assistant message shows a change log (`param: old → new` + evidence) with one-click Revert. Invalid values are shown with reasons, never applied. |
| Agent reach | **Values + Calculate**: the assistant may fill values and, on explicit user intent, return `action: "calculate"`; the client then runs the existing `calculate()`. It never saves selections or creates quotes. |
| Persistence | **Session-only**: chat lives in component state, gone on reload (matches extraction's stateless posture). Applied values persist through the normal Calculate/update path. `// ponytail: store transcript on project when the portal-review flow needs it` |
| Backend shape | **One-shot assist turn**: one oRPC procedure per chat message; server pre-computes narrowed domains (`propagate`), history context, then a single Gemini structured-output call. No tool loop, no streaming. `// ponytail: single-call assist; Gemini function-calling loop over SSE if multi-step reasoning fires` |
| Extraction entry point | The chat **absorbs extraction on this page**: attaching a PDF/PNG/JPEG to a message adds it as `inlineData`. `ExtractPanel` leaves the page header; the component and `extraction.extract` stay for the portal. |
| Provider | Reuse the extraction Gemini setup verbatim: platform `GEMINI_API_KEY`, model id via `GEMINI_MODEL` (default `gemini-3-flash`), structured output. |
| UI kit | `@ui5/webcomponents-ai-react` (already installed): `PromptInput` for input (built-in AI submit button). No chat component exists in UI5, so the log is composed from standard components. |

## Architecture

```
packages/config-engine   src/assist.ts: buildAssistRequest(model, narrowedDomains, entries,
                         conflicts, historyContext, messages) → { prompt, responseSchema } (pure)
apps/server              routers/configs.ts: configs.assist (userProcedure)
                         → propagate + history context + 1× Gemini → { reply, values[], action }
apps/web                 AssistantChat.tsx inside a new first ObjectPageSection "assistant"
                         → auto-apply via setEntries, action=calculate → existing calculate()
```

## Components

### 1. `packages/config-engine` — new `src/assist.ts` (pure, sibling of `extract.ts`)
- `buildAssistRequest(model, domains, entries, conflicts, history, messages)` → `{ prompt, responseSchema }`.
- Prompt: assistant preamble ("you configure product X for a sales user") + model `extraction.context`
  + per-parameter block (label/type/unit/help, **narrowed** allowed values from `propagate`) + current
  entries + current conflict messages + history summaries (top-3 similar with values/scores, recent doc
  rows) + the conversation transcript. Instructs: never guess, cite evidence, only emit
  `action: "calculate"` when there are no conflicts and the user asked for results.
- responseSchema (Gemini structured-output subset):
  `{ reply: string, values: [{ key, value: string|number|boolean|null, evidence: string }], action: "none"|"calculate" }`.
- Takes a `hasDrawing: boolean`; when true the prompt includes the extraction-style instruction
  ("read the attached drawing, extract parameter values with evidence") — same wording source as
  `buildExtractionRequest`. The function stays pure; the server attaches the actual `inlineData`.

### 2. `apps/server` — `configs.assist` in `routers/configs.ts`
- **userProcedure**, input `{ projectId: uuid, messages: [{role: "user"|"assistant", text}] (max 20
  messages, text max 4000 chars), entries: EntriesZ, file?: ExtractFileZ }`. Entries come from the
  client because unsaved local overrides are the real state.
- Flow: load project (customer cardCode) + model → `assertAgentReady` if `needsAgent` →
  `freshLookups` → `propagate(model.definition, lookups, entries)` for narrowed domains + conflicts
  → best-effort history context in `try/catch` (similar top-3 from DB; doc history live via agent,
  skipped on failure — a history outage must never kill a chat turn) → `buildAssistRequest` →
  Gemini call (file as `inlineData` when present) → parse → the existing `validateSuggestions`
  logic fed the **narrowed** domains (adapting the raw shape as needed)
  → return `{ reply, values: [{paramKey, value, evidence, valid, reason?}], action }`.
- The `similar`/`docHistory` handler bodies get extracted into plain functions so `assist` can call
  them; the existing procedures become thin wrappers (no behavior change).
- Errors mapped exactly like extraction: `SERVICE_UNAVAILABLE` (no key), `BAD_REQUEST` (>15MB),
  `BAD_GATEWAY` (Gemini failure / unreadable output) with "retry or enter values manually" text.

### 3. `apps/web` — new `AssistantChat.tsx`
- Props `{ projectId, model, entries, onApply, onCalculate, calculateDisabled, assist? }` —
  `assist` is the injectable mutation fn for tests (ExtractPanel precedent).
- Local state: `messages` (`{role, text, changes?, invalid?, action?, reverted?}`), draft input,
  pending attachment.
- Log: scrollable flex column. User bubbles right-aligned; assistant messages show reply text,
  then per applied value `ObjectStatus` lines `Label: old → new` with evidence underneath, one
  **Revert** button per message (restores the message's `from` snapshot; last-write-wins is
  acceptable for visible session state), invalid values as `ObjectStatus Negative` + reason,
  honored calculate as a chip.
- Empty state: three starter buttons — "What's left to fill?", "Fill this from a drawing",
  "Copy my most similar past config" (they just prefill/send that prompt).
- Input row: `PromptInput` (Enter or AI button → send) + attach `Button` in `FileUploader hideInput`;
  attachment shown as removable `Tag`. Pending: input disabled + `BusyIndicator` "Thinking…".
- Apply: pure helper `applyAssist(entries, values)` → `{ next, changes }`; `onApply(next)`; if
  `action === "calculate"` and `!calculateDisabled`, call `onCalculate()`.
- File validation client-side before sending (type/size) — `toBase64` + MIME map exported from
  `ExtractPanel.tsx` and reused.

### 4. `apps/web` — `ConfigProcessPage.tsx` integration
- `STEP_IDS = ["assistant", "configure", "candidates", "quote"]`; new first
  `<ObjectPageSection id="assistant" titleText="Assistant">` hosting the chat. The existing
  draft→step 1 default now lands on Configure (correct), and `footerArea={step <= 1 …}` already
  gives the Assistant tab the Configure footer.
- Remove `<ExtractPanel>` from `pageHeader` (import too); header keeps status/error strips only.
- Wire chat: `onApply=setEntries` (merge semantics live in `applyAssist`), `onCalculate=calculate`,
  `calculateDisabled` = the Calculate button's exact condition.

## Error handling
- Endpoint errors render as an error bubble in the chat with Retry (re-sends the same payload);
  the user's message stays in the log.
- File type/size problems are caught before any request, shown inline at the attach control.
- Unknown keys / out-of-domain values filtered or flagged server-side by `validateSuggestions`
  against narrowed domains — a value that conflicts with current picks arrives `valid: false` and
  is never applied.
- `action: "calculate"` is ignored client-side whenever the Calculate button would be disabled;
  the reply text still renders.

## Testing / Verification
- `config-engine`: `assist.test.ts` — prompt contains narrowed domains, conflicts, history and
  transcript; schema shape; calculate-guard instruction present.
- Web: unit test for `applyAssist` (applies valid, skips invalid, change snapshots support revert);
  component test for `AssistantChat` with injected `assist` (send → applied chips → revert
  restores entries; error → retry).
- Manual e2e: `bun dev` → demo model → Assistant tab: ask "what's left?", attach a drawing,
  ask for candidates → values apply with evidence, Calculate fires, lands on Candidates;
  unset `GEMINI_API_KEY` path shows friendly error.

## Out of scope (named upgrade paths)
- Streaming / tool-calling loop (`// ponytail` above), transcript persistence, per-tenant AI keys,
  candidate pre-selection, portal chat.
