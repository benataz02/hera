# Configurator AI Assistant Chat — Design Spec (2026-07-19)

## Context

The configuration process page (`ConfigProcessPage`) already has three accelerators, each with its
own UI surface: drawing extraction (header panel), similar-configuration copy and B1 doc history
(right-hand pane), and live domain propagation in the form. This feature unifies them behind a
conversational assistant: the right-hand splitter pane becomes a single **Assistant pane** that
chats (fills parameters on request, reads attached drawings, cites past configurations, triggers
Calculate) *and* presents the history data locally — a dialogue beside a form that stays visible
the whole time. The process remains three steps (Configure → Candidates → Create quote): the
assistant is a pane, not a process section.

## Decisions (settled in brainstorming)

| Axis | Decision |
|---|---|
| Placement | **Right splitter pane, not a step**: `STEP_IDS` stays `["configure","candidates","quote"]`. The chat lives where `HistoryPane` lived, so the form is visible while values land, and the chat keeps working on the Candidates step. |
| History | **Merged into the pane**: "Similar configurations" and "Document history" render as collapsible Panels (collapsed by default) above the chat — current `HistoryPane` content with Copy buttons intact, no LLM involved in rendering them. The standalone history pane disappears. |
| Apply mode | **Agent-style auto-apply**: valid values go straight into local `entries`; each assistant message shows a change log (`param: old → new` + evidence) with per-value Revert and message-level Revert all. Invalid values are shown with reasons, never applied. |
| Form feedback | **Persistent AI marker**: fields set by the assistant get an `ObjectStatus state="Information"` chip with `sap-icon://ai` beside the control (same slot/pattern as the existing `defaulted → "auto"` chip), tooltip = evidence. Cleared when the user edits that field or reverts. No UI5 component exists for this (`@ui5/webcomponents-ai@2.24` is generative-text UX only: Button, Input, TextArea, PromptInput, ToolbarLabel, Versioning, WritingAssistant). |
| Follow-ups | **Model-proposed suggestion chips**: responseSchema gains `suggestions: string[]` (max 3, short user-voice prompts). Rendered under the latest assistant reply only; clicking sends that text as a user message. |
| Agent reach | **Values + Calculate**: the assistant may fill values and, on explicit user intent, return `action: "calculate"`; the client then runs the existing `calculate()`. It never saves selections or creates quotes. |
| Persistence | **Session-only**: chat and AI markers live in component state, gone on reload (matches extraction's stateless posture). Applied values persist through the normal Calculate/update path. `// ponytail: store transcript on project when the portal-review flow needs it` |
| Backend shape | **One-shot assist turn**: one oRPC procedure per chat message; server pre-computes narrowed domains (`propagate`), history context, then a single Gemini structured-output call. No tool loop, no streaming. `// ponytail: single-call assist; Gemini function-calling loop over SSE if multi-step reasoning fires` |
| Extraction entry point | The chat **absorbs extraction on this page**: attaching a PDF/PNG/JPEG to a message adds it as `inlineData`. `ExtractPanel` leaves the page header; the component and `extraction.extract` stay for the portal. |
| Provider | Reuse the extraction Gemini setup verbatim: platform `GEMINI_API_KEY`, model id via `GEMINI_MODEL` (default `gemini-3-flash`), structured output. |
| UI kit | `@ui5/webcomponents-ai-react` (already installed): `PromptInput` for input (built-in AI submit button). No chat component exists in UI5, so the log is composed from standard components. |

## Architecture

```
packages/config-engine   src/assist.ts: buildAssistRequest(model, narrowedDomains, entries,
                         conflicts, historyContext, messages) → { prompt, responseSchema } (pure)
apps/server              routers/configs.ts: configs.assist (userProcedure)
                         → propagate + history context + 1× Gemini
                         → { reply, values[], action, suggestions[] }
apps/web                 AssistantPane.tsx in the right SplitterElement (replaces HistoryPane
                         placement): history Panels + chat log + PromptInput
                         → auto-apply via setEntries + aiMarks, action=calculate → calculate(next)
```

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
  animation, same default-open heuristic (`model.definition.history` present), toggle always
  available.
- The pane is step-independent: values applied while on Candidates make `entries` dirty — the
  existing `staleRun` banner and tab-disabling already handle that.

## Components

### 1. `packages/config-engine` — new `src/assist.ts` (pure, sibling of `extract.ts`)
- `buildAssistRequest(model, domains, entries, conflicts, history, messages)` → `{ prompt, responseSchema }`.
- Prompt: assistant preamble ("you configure product X for a sales user") + model `extraction.context`
  + per-parameter block (label/type/unit/help, **narrowed** allowed values from `propagate`) + current
  entries + current conflict messages + history summaries (top-3 similar with values/scores, recent doc
  rows) + the conversation transcript. Instructs: never guess, cite evidence, only emit
  `action: "calculate"` when there are no conflicts and the user asked for results; propose up to 3
  `suggestions` as short next-step prompts in the user's voice ("Fill the remaining N parameters",
  "Calculate candidates" — the latter only when no conflicts remain).
- responseSchema (Gemini structured-output subset):
  `{ reply: string, values: [{ key, value: string|number|boolean|null, evidence: string }], action: "none"|"calculate", suggestions: string[] }`.
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
  Gemini call (file as `inlineData` when present) → parse → validate the proposal as one state
  transition using the full lookups and current entries (algorithm below)
  → return `{ reply, values: [{paramKey, value, evidence, valid, reason?}], action, suggestions }`.
  Downgrade `action: "calculate"` to `"none"` unless the combined final state is fully valid and
  conflict-free.
- The `similar`/`docHistory` handler bodies get extracted into plain functions so `assist` can call
  them; the existing procedures become thin wrappers (no behavior change). The web pane's history
  Panels keep calling the wrappers directly — the server computes its own history context for the
  LLM and never sees markers, reverts, or panel state.
- Errors mapped exactly like extraction: `SERVICE_UNAVAILABLE` (no key), `BAD_REQUEST` (>15MB),
  `BAD_GATEWAY` (Gemini failure / unreadable output) with "retry or enter values manually" text.

### 3. `apps/web` — new `AssistantPane.tsx`
- Props `{ projectId, model, lookups, entries, onApply, onCopy, onCalculate, calculateDisabled,
  paneOpen, assist? }` — `onCalculate(nextEntries: Entries)` requires the exact entries to persist
  before running; `assist` is the injectable mutation fn for tests (ExtractPanel precedent).
- Top: the two history Panels — `HistoryPane`'s internals embedded (its queries keep their
  `paneOpen` gating; Copy still routes through the existing `copyValues` fill-empty-only path,
  which does **not** set AI markers — only chat-applied values do).
- Message shape: `{ role, text, changes?, invalid?, action?, suggestions?, file? }` with
  `changes: [{ key, from, to, evidence, reverted }]`.
- Assistant message renders top-to-bottom: reply text → one line per applied change
  (`Label: old → new` as `ObjectStatus Information`, evidence in small muted text beneath) with a
  per-line **↩ revert** icon button → invalid values as `ObjectStatus Negative` + reason (never
  applied) → a calculate chip when the action was honored → **Revert all** (transparent button,
  shown when ≥2 changes). Reverted lines render struck-through.
- **Suggestion chips render under the latest assistant message only**; clicking one sends that
  text as a user message. User bubbles right-aligned; attachment shown as removable `Tag`.
- Empty state: three starter chips — "What's left to fill?", "Fill this from a drawing",
  "Copy my most similar past config" (they just prefill/send that prompt) — below the collapsed
  history Panels.
- Input row: `PromptInput` (Enter or AI button → send) + attach `Button` in `FileUploader hideInput`.
  Pending: input disabled + `BusyIndicator` "Thinking…".
- Apply: pure helper `applyAssist(entries, values)` → `{ next, changes }`; `onApply(next, changes)`;
  if `action === "calculate"` and `!calculateDisabled`, call `onCalculate(next)`. **`next` must be
  passed through** — `setEntries` inside `onApply` hasn't re-rendered yet, so a zero-arg
  `onCalculate()` would read the pre-apply entries and calculate against stale state.
- Revert per value: restore `from` (delete the entry if `from` was undefined), flag the line
  `reverted`, clear its AI marker. Revert all = revert every non-reverted line of that message.
  Last-write-wins: revert restores the snapshot even if something changed the value since — the
  form is right there to fix it. `// ponytail: snapshot restore, no op-log; fine for visible session state`
- File validation client-side before sending (type/size) — `toBase64` + MIME map exported from
  `ExtractPanel.tsx` and reused.

### 4. `apps/web` — `ConfigProcessPage.tsx` + `ConfiguratorForm.tsx` integration
- Keep `STEP_IDS = ["configure", "candidates", "quote"]`. The right `SplitterElement` hosts
  `AssistantPane` instead of `HistoryPane`; the `History` ToggleButton becomes `Assistant`
  (icon `ai`). Draft projects start at Configure, calculated projects and successful runs land at
  Candidates, Create quote stays last — unchanged.
- Remove `<ExtractPanel>` from `pageHeader` (import too); header keeps status/error strips only.
- **AI markers**: new state `aiMarks: Map<paramKey, evidence>`. Chat apply sets marks for its
  changed keys; the form's `onChange` is wrapped to diff old vs new entries and clear the marker
  of any key the *user* changed; revert clears marks too. `ConfiguratorForm` takes an optional
  `aiMarks` prop and renders the chip beside the control in the same slot as the `defaulted →
  "auto"` chip (`ObjectStatus state="Information"`, icon `ai`, tooltip = evidence).
- Wire chat: `onApply={(next, changes) => { setEntries(next); markAi(changes); }}`;
  `calculate` gains an entries parameter — `calculate(next = entries)` uses `next` for the
  dirty-check and the `update` payload — and the chat gets `onCalculate={(next) => calculate(next)}`
  so the freshly applied values are what gets calculated, not the pre-apply render's state.
  `calculateDisabled` = the Calculate button's exact condition (step-independent:
  `conflicted || lookups.isPending || batches.length === 0 || calcBusy`).
- On `run` success the existing handler jumps to the Candidates tab — the chat stays visible in
  the pane, so the calculate flow no longer navigates away from the conversation.

## Proposal validation

Validation treats an assistant turn as one proposed state transition:

1. Run `propagate(model, lookups, entries)` for the pre-turn state. Perform key, type and range
   checks, and for option parameters accept a value only when the propagated option exists **and has
   no `eliminatedBy` marker**.
2. Apply every preliminarily valid proposed value together to a copy of `entries`, then rerun
   `propagate` once against that combined state.
3. If final propagation has any conflict, reject/flag the proposal set together; none of its
   otherwise-valid values are applied. Invalid individual values also make the turn ineligible for
   Calculate.
4. Preserve `action: "calculate"` only when every proposed value passed and the combined final
   propagation is conflict-free. The client additionally keeps its normal Calculate-button guard.

This prevents both eliminated values and pairs that are individually supported before the turn but
conflict when selected together.

## Error handling
- Endpoint errors render as an error bubble in the chat with Retry (re-sends the same payload);
  the user's message stays in the log.
- File type/size problems are caught before any request, shown inline at the attach control.
- Unknown keys / out-of-domain, eliminated, or jointly conflicting values are filtered or flagged
  server-side by the combined-state validation above and are never applied.
- `action: "calculate"` is removed server-side for an invalid final state and is also ignored
  client-side whenever the Calculate button would be disabled; the reply text still renders.
- History Panels keep their own query error states (unchanged from `HistoryPane`); a history
  outage never blocks the chat.

## Testing / Verification
- `config-engine`: `assist.test.ts` — prompt contains narrowed domains, conflicts, history and
  transcript; schema shape includes `suggestions`; calculate-guard instruction present.
- Web: unit tests for `applyAssist` (applies valid, skips invalid, change snapshots support
  per-value revert and revert-all) and the marker-diff helper (user edit clears only the edited
  key); component test for `AssistantPane` with injected `assist` (send → applied lines →
  per-value revert restores that entry; suggestion chip click sends its text; error → retry).
- Config-process navigation tests: draft load → Configure, calculated load → Candidates, successful
  run → Candidates; calculation-input test proves explicit assistant values are persisted for the
  run snapshot.
- Server validation tests: eliminated value is rejected; two pre-turn-valid values that conflict
  after combined application are rejected together and cannot emit Calculate.
- Manual e2e: `bun dev` → demo model → open Assistant pane: ask "what's left?", attach a drawing,
  ask for candidates → values apply with evidence and `ai` chips appear on the form fields,
  manual edit clears a chip, Calculate fires and lands on Candidates with the chat still visible;
  unset `GEMINI_API_KEY` path shows friendly error.

## Out of scope (named upgrade paths)
- Streaming / tool-calling loop (`// ponytail` above), transcript persistence, per-tenant AI keys,
  candidate pre-selection, portal chat.
