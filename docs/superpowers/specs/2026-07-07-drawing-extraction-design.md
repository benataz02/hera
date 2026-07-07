# Drawing Extraction — Design Spec (2026-07-07)

## Context

Tenants' customers send 2D technical drawings (PDF/image). Today someone reads the drawing and types parameter values into the configuration wizard by hand. This feature adds a hosted-AI extraction step: upload a drawing, an AI reads it against the tenant's configurator model (`ModelDef`), and returns per-parameter value suggestions the user confirms — turning configuration entry into a review pass.

## State of the art (evaluated 2026-07)

| Category | Examples | Verdict |
|---|---|---|
| Frontier multimodal LLMs + structured output | Gemini, Claude, GPT | **Chosen.** Only category supporting arbitrary per-tenant schemas natively. Weakness: dense dimension callouts, no per-field confidence. |
| Specialized drawing APIs | Werk24 | Fixed ontology (measures, GD&T, title block) with confidence + coordinates; would still need an LLM layer to map onto tenant parameters. Deferred precision upgrade. |
| Vertical quoting platforms | CADDi, Paperless Parts | Complete products, not embeddable extractors. Skip. |
| Hybrid research pipelines | YOLO-OBB + fine-tuned VLM (Donut/Florence-2) | Self-hosted fine-tuning — excluded by constraint. |

## Decisions (settled in brainstorming)

| Axis | Decision |
|---|---|
| Provider | **Gemini API** (`@google/genai`): leads technical-drawing benchmarks, native PDF input, strict JSON-schema output, cheapest vision pricing. Platform-level `GEMINI_API_KEY` env; model id via env, default `gemini-3-flash`. |
| Entry point | **API-first**: one standalone oRPC procedure; the wizard's Configure step is its first consumer (email/portal intake can reuse it later). |
| Prompt authoring | **Generated from `ModelDef`**, never hand-written per tenant. Parameters already carry key/label/type/domain/unit/help. Admins add optional model-level `extraction.context` blurb + optional per-parameter `extractionHint`. |
| Trust model | **Suggest-and-confirm**: each suggestion carries evidence (quote/location from the drawing); out-of-domain values flagged, never applied; nothing enters the configuration without a user click. |
| Persistence | Stateless — no new tables, drawings not stored. `// ponytail: store drawing on project when audit/history need fires` |

## Architecture

```
packages/config-engine   src/extract.ts: buildExtractionRequest(model, resolvedDomains)
                         → { prompt, responseSchema }   (pure, zero I/O)
apps/server              routers/extraction.ts: extraction.extract (userProcedure)
                         → Gemini call + domain validation → suggestions[]
apps/web                 Configure step: upload button → suggestions panel → accept into entries
```

## Components

### 1. `packages/config-engine`
- `src/model.ts`: extend `ModelDefZ` with optional `extraction: { context?: string }` (model level) and `extractionHint?: string` (per parameter). Existing models untouched.
- New `src/extract.ts` (pure, like the rest of the engine):
  - `buildExtractionRequest(model, resolvedDomains)` → `{ prompt: string, responseSchema: JsonSchema }`.
  - Prompt = model context blurb + per-parameter block (label, type, unit, help, extractionHint, domain values when finite).
  - responseSchema (Gemini structured-output format): per parameter `{ value: <typed>|null, evidence: string }`; finite string domains become enums in the schema; numeric/open domains stay free and are validated server-side.
  - `// ponytail: single-call extraction; per-view or Werk24 pre-pass if dimension misreads fire`

### 2. `apps/server` — `routers/extraction.ts`, registered in `router.ts`
- `extraction.extract` (**userProcedure**): input `{ modelId, file: { name, mimeType, dataBase64 } }` — PDF/PNG/JPEG, reject >15MB (client- and server-side).
- Load model, resolve finite lookup domains (reuse the lookup-resolution helpers from the `configs.run` path), `buildExtractionRequest`, call Gemini with inline file + responseSchema.
- Validate every returned value against the parameter's resolved domain / numeric range.
- Output `{ suggestions: { paramKey, value, evidence, valid, reason? }[] }`.

### 3. `apps/web` — Configure step (`configs/$id`)
- "Extract from drawing" button → UI5 `FileUploader` → base64 → `extraction.extract` mutation (TanStack Query) with busy indicator.
- Suggestions panel inline in the step (no new route): per parameter — suggested value, evidence text, Accept / Dismiss; "Accept all valid"; invalid ones shown with reason, no Accept action.
- Accepted values become normal entries → existing live propagation reacts; conflicts surface exactly as manual entry would.

### 4. Model builder
- Parameter edit dialog: one optional "Extraction hint" input. Model settings: one "Extraction context" TextArea. Plain fields on existing dialogs — no new tab.

## Error handling
- Gemini API failure/timeout → typed oRPC error with friendly message (same shape as `assertAgentReady`-style messages), retry action in UI.
- Oversized/unsupported file → validation error before any API call.
- Non-drawing input → model returns nulls; UI shows "nothing extracted".
- Values outside domain → flagged suggestion with reason, never applicable.

## Testing / Verification
- `bun test` in `packages/config-engine`: golden prompt/schema fixtures for a small model; enum-domain vs open-domain schema shapes.
- Server: unit-test domain validation against a mocked Gemini response (valid, out-of-domain, null cases).
- Manual e2e: `bun dev` → demo model, add context + hints in builder → in a configuration's Configure step upload a sample drawing PDF → suggestions render with evidence, out-of-domain flagged, Accept flows into entries and propagation reacts → API-failure path shows friendly error (unset `GEMINI_API_KEY`).

## Out of scope (explicit)
Drawing storage/history, per-tenant API keys or usage metering, Werk24 precision pre-pass, email/portal intake channels, confidence scores in UI. Each has a marked upgrade path.
