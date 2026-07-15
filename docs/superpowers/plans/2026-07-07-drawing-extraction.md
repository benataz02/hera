# Drawing Extraction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upload a 2D technical drawing (PDF/image) in the wizard's Configure step, have Gemini read it against the tenant's `ModelDef`, and return per-parameter suggestions the user explicitly accepts into their entries.

**Architecture:** A pure `buildExtractionRequest(model, domains)` in `packages/config-engine` generates the prompt + Gemini structured-output schema from the model definition. A new `extraction.extract` oRPC `userProcedure` in `apps/server` resolves lookups (reusing the `configs` helpers), calls Gemini with the inline file, and gates every returned value through a pure `validateSuggestions`. The web Configure step gets an upload panel whose accepted suggestions become normal entries, so existing propagation reacts unchanged.

**Tech Stack:** Bun workspaces, Zod v4, oRPC, Drizzle, `@google/genai` (new dep, apps/server only), TanStack Query, UI5 Web Components React.

## Global Constraints

- Provider: Gemini via `@google/genai`; API key from platform-level `GEMINI_API_KEY` env; model id from `GEMINI_MODEL` env, default `gemini-3-flash`.
- Accepted files: PDF/PNG/JPEG only; reject > 15MB **client- and server-side**.
- Suggest-and-confirm: nothing enters the configuration without a user click; out-of-domain values flagged, never applicable.
- Stateless: no new tables, drawings not stored (`// ponytail: store drawing on project when audit/history need fires`).
- Prompt is generated from `ModelDef`, never hand-written per tenant.
- `buildExtractionRequest` is pure (zero I/O), like the rest of config-engine.
- Existing saved models must keep parsing (all new schema fields optional).
- Out of scope: drawing storage/history, per-tenant API keys/metering, Werk24 pre-pass, email/portal intake, confidence scores in UI.

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `packages/config-engine/src/model.ts` | Modify | Optional `extraction.context` (model) + `extractionHint` (param) fields |
| `packages/config-engine/src/extract.ts` | Create | `buildExtractionRequest` → `{ prompt, responseSchema }` |
| `packages/config-engine/src/index.ts` | Modify | Export `buildExtractionRequest` + types |
| `packages/config-engine/test/model.test.ts` | Modify | New fields round-trip through `ModelDefZ.parse` |
| `packages/config-engine/test/extract.test.ts` | Create | Golden prompt/schema tests over the fixture model |
| `apps/server/src/extraction.ts` | Create | Pure `validateSuggestions` (type/domain/range gate) |
| `apps/server/test/extraction.test.ts` | Create | Unit tests for `validateSuggestions` |
| `apps/server/src/orpc/routers/extraction.ts` | Create | `extraction.extract` userProcedure (Gemini call) |
| `apps/server/src/orpc/routers/configs.ts` | Modify | `export` for `loadModel`, `freshLookups`, `needsAgent` |
| `apps/server/src/orpc/router.ts` | Modify | Register `extraction` router |
| `apps/server/package.json` | Modify | Add `@google/genai` |
| `apps/web/src/components/configurator/ExtractPanel.tsx` | Create | Upload button + suggestions panel |
| `apps/web/src/components/configurator/StepConfigure.tsx` | Modify | Render `ExtractPanel` above the form |
| `apps/web/src/components/configurator/ConfigProcessPage.tsx` | Modify | Pass `modelId` to `StepConfigure` |
| `apps/web/src/components/configurator/ParamsTab.tsx` | Modify | "Extraction hint" input in the param dialog |
| `apps/web/src/components/configurator/SettingsTab.tsx` | Modify | "Extraction context" TextArea in model settings |

---

### Task 1: config-engine — extraction fields on `ModelDef`

**Files:**
- Modify: `packages/config-engine/src/model.ts`
- Test: `packages/config-engine/test/model.test.ts`

**Interfaces:**
- Consumes: existing `ParamZ` / `ModelDefZ` in `model.ts`.
- Produces: `Param.extractionHint?: string`, `ModelDef.extraction?: { context?: string }` — Task 2's prompt builder and Task 6's builder UI read exactly these.

- [ ] **Step 1: Write the failing test**

Append to the `describe("ModelDefZ", ...)` block in `packages/config-engine/test/model.test.ts`:

```ts
  test("keeps extraction context and per-parameter hints", () => {
    const m = structuredClone(model) as any;
    m.extraction = { context: "Dimensions are in millimetres unless noted." };
    m.parameters[0].extractionHint = "Title block MATERIAL field";
    const parsed = ModelDefZ.parse(m);
    expect(parsed.extraction?.context).toBe("Dimensions are in millimetres unless noted.");
    expect(parsed.parameters[0]!.extractionHint).toBe("Title block MATERIAL field");
  });
```

(Zod strips unknown keys silently, so the assertion must be on the *parsed output*, not on "doesn't throw".)

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/config-engine/test/model.test.ts`
Expected: FAIL — `parsed.extraction` is `undefined` (Zod stripped the unknown key). TypeScript may also error on `parsed.extraction` not existing; that is the same failure.

- [ ] **Step 3: Add the fields to the schema**

In `packages/config-engine/src/model.ts`, add one line to `ParamZ` (after `help`):

```ts
  help: z.string().optional(),
  extractionHint: z.string().optional(),
});
```

And one line to `ModelDefZ` (after `batchDefaults`):

```ts
  batchDefaults: z.array(z.number().int().positive()),
  extraction: z.object({ context: z.string().optional() }).optional(),
});
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test packages/config-engine`
Expected: PASS (all existing model/propagate/enumerate/etc. tests still green — the fields are optional).

- [ ] **Step 5: Commit**

```bash
git add packages/config-engine/src/model.ts packages/config-engine/test/model.test.ts
git commit -m "feat(engine): optional extraction context + per-parameter hints on ModelDef"
```

---

### Task 2: config-engine — `buildExtractionRequest`

**Files:**
- Create: `packages/config-engine/src/extract.ts`
- Modify: `packages/config-engine/src/index.ts`
- Test: `packages/config-engine/test/extract.test.ts`

**Interfaces:**
- Consumes: `ModelDef`, `Option` from `./model`; Task 1's `extraction.context` / `extractionHint` fields; `ResolvedLookups["domains"]` shape (`Record<string, Option[]>`).
- Produces: `buildExtractionRequest(model: ModelDef, domains: Record<string, Option[]>): ExtractionRequest` where `ExtractionRequest = { prompt: string; responseSchema: JsonSchema }` and `JsonSchema = Record<string, unknown>`. Task 4 passes `responseSchema` straight to Gemini and `prompt` as the text part.

- [ ] **Step 1: Write the failing test**

Create `packages/config-engine/test/extract.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { buildExtractionRequest } from "../src/extract";
import { lookups, model } from "./fixture";

describe("buildExtractionRequest", () => {
  const m = structuredClone(model);
  m.extraction = { context: "Dimensions are in millimetres unless noted." };
  m.parameters.find((p) => p.key === "material")!.extractionHint = "See title block, MATERIAL field";
  const req = buildExtractionRequest(m, lookups.domains);
  const props = req.responseSchema.properties as Record<string, any>;

  test("prompt names the model, context, labels, units, hints and allowed values", () => {
    expect(req.prompt).toContain('"Cable assembly"');
    expect(req.prompt).toContain("Dimensions are in millimetres unless noted.");
    expect(req.prompt).toContain("material: Conductor material (string)");
    expect(req.prompt).toContain("Hint: See title block, MATERIAL field");
    expect(req.prompt).toContain("section: Cross-section (number, mm²)");
    expect(req.prompt).toContain("Allowed values: steel, alu");
    expect(req.prompt).toContain("Allowed values: 10, 16, 25");
  });

  test("finite string domains become enums; numeric and boolean stay free", () => {
    expect(props.material.properties.value).toEqual({ type: "string", enum: ["steel", "alu"], nullable: true });
    expect(props.section.properties.value).toEqual({ type: "number", nullable: true });
    expect(props.coated.properties.value).toEqual({ type: "boolean", nullable: true });
    expect(props.color.properties.value).toEqual({ type: "string", enum: ["red", "black", "blue"], nullable: true });
  });

  test("every parameter is required, with value + evidence", () => {
    expect(req.responseSchema.required).toEqual(["material", "section", "coated", "color"]);
    for (const k of ["material", "section", "coated", "color"]) {
      expect(props[k].type).toBe("object");
      expect(props[k].required).toEqual(["value", "evidence"]);
      expect(props[k].properties.evidence).toEqual({ type: "string" });
    }
  });

  test("range domains appear in the prompt", () => {
    const rm = structuredClone(model);
    rm.parameters.push({
      key: "len", label: "Length", type: "number", ui: "input",
      unit: "mm", domain: { kind: "range", min: 5, max: 5000 },
    });
    const r = buildExtractionRequest(rm, lookups.domains);
    expect(r.prompt).toContain("Allowed range: 5 to 5000");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/config-engine/test/extract.test.ts`
Expected: FAIL — `Cannot find module '../src/extract'`.

- [ ] **Step 3: Write the implementation**

Create `packages/config-engine/src/extract.ts`:

```ts
import type { ModelDef, Option } from "./model";

// Gemini structured-output schema (OpenAPI 3.0 subset: type/enum/nullable/properties/required).
export type JsonSchema = Record<string, unknown>;
export type ExtractionRequest = { prompt: string; responseSchema: JsonSchema };

/** Prompt + response schema for extracting a model's parameters from a technical
 *  drawing. Pure like the rest of the engine: domains are already-resolved options.
 *  // ponytail: single-call extraction; per-view or Werk24 pre-pass if dimension misreads fire */
export function buildExtractionRequest(model: ModelDef, domains: Record<string, Option[]>): ExtractionRequest {
  const lines = [`You are reading a customer's 2D technical drawing to configure the product "${model.name}".`];
  if (model.extraction?.context) lines.push(model.extraction.context);
  lines.push(
    "For each parameter below, find its value on the drawing.",
    "Use null when the drawing does not state the value — never guess.",
    "For every non-null value, set evidence to the exact text or dimension callout you read and where it appears (view, table, note).",
    "",
    "Parameters:",
  );

  const properties: Record<string, JsonSchema> = {};
  for (const p of model.parameters) {
    const opts = domains[p.key] ?? [];
    let line = `- ${p.key}: ${p.label} (${p.type}${p.unit ? `, ${p.unit}` : ""})`;
    if (p.help) line += ` — ${p.help}`;
    lines.push(line);
    if (p.extractionHint) lines.push(`  Hint: ${p.extractionHint}`);
    if (p.domain?.kind === "range") lines.push(`  Allowed range: ${p.domain.min} to ${p.domain.max}`);
    if (opts.length) lines.push(`  Allowed values: ${opts.map((o) => String(o.value)).join(", ")}`);

    // Finite string domains become enums; numeric/open domains stay free (validated server-side).
    const stringEnum = p.type === "string" && opts.length > 0 && opts.every((o) => typeof o.value === "string");
    const value: JsonSchema = stringEnum
      ? { type: "string", enum: opts.map((o) => o.value as string), nullable: true }
      : { type: p.type === "number" ? "number" : p.type === "boolean" ? "boolean" : "string", nullable: true };
    properties[p.key] = {
      type: "object",
      properties: { value, evidence: { type: "string" } },
      required: ["value", "evidence"],
    };
  }

  return {
    prompt: lines.join("\n"),
    responseSchema: { type: "object", properties, required: model.parameters.map((p) => p.key) },
  };
}
```

Append to `packages/config-engine/src/index.ts`:

```ts
export { buildExtractionRequest } from "./extract";
export type { ExtractionRequest, JsonSchema } from "./extract";
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test packages/config-engine`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/config-engine/src/extract.ts packages/config-engine/src/index.ts packages/config-engine/test/extract.test.ts
git commit -m "feat(engine): buildExtractionRequest — prompt + Gemini schema from ModelDef"
```

---

### Task 3: server — `validateSuggestions` (pure domain gate)

**Files:**
- Create: `apps/server/src/extraction.ts`
- Test: `apps/server/test/extraction.test.ts`

**Interfaces:**
- Consumes: `ModelDef`, `Option`, `Val` from `@hera/config-engine`.
- Produces: `validateSuggestions(model: ModelDef, domains: Record<string, Option[]>, raw: unknown): Suggestion[]` and `type Suggestion = { paramKey: string; value: Val; evidence: string; valid: boolean; reason?: string }`. Task 4 calls it on the parsed Gemini JSON; Task 5's UI consumes the `Suggestion` shape via oRPC inference.

- [ ] **Step 1: Write the failing test**

Create `apps/server/test/extraction.test.ts` (mirrors the pure-module style of `test/lookups.test.ts`):

```ts
import { describe, expect, test } from "bun:test";
import type { ModelDef, Option } from "@hera/config-engine";
import { validateSuggestions } from "../src/extraction.ts";

const model: ModelDef = {
  name: "m",
  parameters: [
    {
      key: "material", label: "Material", type: "string", ui: "select",
      domain: { kind: "options", ref: { source: "manual", options: [{ value: "steel" }, { value: "alu" }] } },
    },
    { key: "len", label: "Length", type: "number", ui: "input", domain: { kind: "range", min: 5, max: 100 } },
    { key: "coated", label: "Coated", type: "boolean", ui: "checkbox" },
    { key: "note", label: "Note", type: "string", ui: "input" },
  ],
  structure: { sections: [] },
  computed: [], constraints: [], bom: [], routing: [], queryTables: [],
  pricing: { priceExpr: "1", quoteItemCode: "X" },
  batchDefaults: [1],
};
const domains: Record<string, Option[]> = {
  material: [{ value: "steel", label: "steel" }, { value: "alu", label: "alu" }],
};

describe("validateSuggestions", () => {
  test("in-domain and in-range values are valid", () => {
    const s = validateSuggestions(model, domains, {
      material: { value: "steel", evidence: "title block" },
      len: { value: 50, evidence: "overall dim, front view" },
    });
    expect(s).toEqual([
      { paramKey: "material", value: "steel", evidence: "title block", valid: true, reason: undefined },
      { paramKey: "len", value: 50, evidence: "overall dim, front view", valid: true, reason: undefined },
    ]);
  });

  test("out-of-domain value is flagged, not dropped", () => {
    const [s] = validateSuggestions(model, domains, { material: { value: "copper", evidence: "note 3" } });
    expect(s).toMatchObject({ paramKey: "material", value: "copper", valid: false });
    expect(s!.reason).toContain("allowed values");
  });

  test("out-of-range number is flagged with the range", () => {
    const [s] = validateSuggestions(model, domains, { len: { value: 400, evidence: "side view" } });
    expect(s).toMatchObject({ paramKey: "len", valid: false });
    expect(s!.reason).toContain("5–100");
  });

  test("wrong-typed value is flagged and stringified", () => {
    const [s] = validateSuggestions(model, domains, { coated: { value: "yes", evidence: "note" } });
    expect(s).toMatchObject({ paramKey: "coated", value: "yes", valid: false, reason: "Expected a boolean" });
  });

  test("open string params are always valid", () => {
    const [s] = validateSuggestions(model, domains, { note: { value: "per DIN 912", evidence: "note 1" } });
    expect(s).toMatchObject({ paramKey: "note", value: "per DIN 912", valid: true });
  });

  test("nulls, unknown keys and garbage produce no suggestions", () => {
    expect(validateSuggestions(model, domains, { material: { value: null, evidence: "" }, bogus: { value: 1 } })).toEqual([]);
    expect(validateSuggestions(model, domains, null)).toEqual([]);
    expect(validateSuggestions(model, domains, "not json object")).toEqual([]);
  });

  test("missing evidence degrades to empty string", () => {
    const [s] = validateSuggestions(model, domains, { material: { value: "alu" } });
    expect(s).toMatchObject({ paramKey: "material", value: "alu", evidence: "", valid: true });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test apps/server/test/extraction.test.ts`
Expected: FAIL — `Cannot find module '../src/extraction.ts'`.

- [ ] **Step 3: Write the implementation**

Create `apps/server/src/extraction.ts`:

```ts
import type { ModelDef, Option, Val } from "@hera/config-engine";

// Server-side gate on whatever the LLM returned: type + domain/range check per parameter.
// Invalid values are flagged (never dropped) so the UI can show them with a reason but no
// Accept action. Nothing here writes anywhere — the browser applies accepted suggestions
// as ordinary entries.

export type Suggestion = { paramKey: string; value: Val; evidence: string; valid: boolean; reason?: string };

export function validateSuggestions(
  model: ModelDef,
  domains: Record<string, Option[]>,
  raw: unknown,
): Suggestion[] {
  const rec = (typeof raw === "object" && raw !== null ? raw : {}) as Record<
    string,
    { value?: unknown; evidence?: unknown } | undefined
  >;
  const out: Suggestion[] = [];
  for (const p of model.parameters) {
    const r = rec[p.key];
    if (!r || typeof r !== "object" || r.value === null || r.value === undefined) continue;
    const evidence = typeof r.evidence === "string" ? r.evidence : "";

    // p.type is "string" | "number" | "boolean" — exactly the typeof names.
    if (typeof r.value !== p.type) {
      out.push({ paramKey: p.key, value: String(r.value), evidence, valid: false, reason: `Expected a ${p.type}` });
      continue;
    }
    const value = r.value as Val;
    let reason: string | undefined;
    if (p.domain?.kind === "range" && typeof value === "number" && (value < p.domain.min || value > p.domain.max))
      reason = `Outside allowed range ${p.domain.min}–${p.domain.max}`;
    const opts = domains[p.key];
    if (p.domain?.kind === "options" && opts && !opts.some((o) => o.value === value))
      reason = "Not among the allowed values for this parameter";
    out.push({ paramKey: p.key, value, evidence, valid: !reason, reason });
  }
  return out;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test apps/server/test/extraction.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/extraction.ts apps/server/test/extraction.test.ts
git commit -m "feat(server): validateSuggestions — type/domain/range gate for extraction results"
```

---

### Task 4: server — `extraction.extract` procedure + Gemini call

**Files:**
- Modify: `apps/server/src/orpc/routers/configs.ts` (add `export` to three existing declarations)
- Create: `apps/server/src/orpc/routers/extraction.ts`
- Modify: `apps/server/src/orpc/router.ts`
- Modify: `apps/server/package.json` (via `bun add`)

**Interfaces:**
- Consumes: `buildExtractionRequest` (Task 2), `validateSuggestions` (Task 3), and from `configs.ts`: `loadModel(tenantId, modelId)`, `freshLookups(tenantId, model, fetchQuery)`, `needsAgent(model)`; `agentFetcher(tenantId)` from `models.ts`; `assertAgentReady(tenantId)` from `entities.ts`.
- Produces: oRPC procedure `extraction.extract` — input `{ modelId: string(uuid), file: { name, mimeType: "application/pdf"|"image/png"|"image/jpeg", dataBase64: string } }`, output `{ suggestions: Suggestion[] }`. Task 5 calls it as `orpc.extraction.extract`.

- [ ] **Step 1: Add the dependency**

Run: `bun add @google/genai --cwd apps/server`
Expected: `@google/genai` appears in `apps/server/package.json` dependencies. (Bun isolated installs need it as a **direct** dep of apps/server — do not rely on hoisting.)

- [ ] **Step 2: Export the three configs helpers**

In `apps/server/src/orpc/routers/configs.ts`, change three existing declarations (no other edits):

```ts
export const needsAgent = (m: ModelDef): boolean =>
```

```ts
export async function loadModel(tenantId: string, modelId: string) {
```

```ts
export async function freshLookups(tenantId: string, model: ModelDef, fetchQuery: QueryFetcher): Promise<ResolvedLookups> {
```

- [ ] **Step 3: Write the router**

Create `apps/server/src/orpc/routers/extraction.ts`:

```ts
import { ORPCError } from "@orpc/server";
import { z } from "zod";
import { GoogleGenAI, type Schema } from "@google/genai";
import { buildExtractionRequest } from "@hera/config-engine";
import { userProcedure } from "../base.ts";
import { assertAgentReady } from "./entities.ts";
import { agentFetcher } from "./models.ts";
import { freshLookups, loadModel, needsAgent } from "./configs.ts";
import { validateSuggestions } from "../../extraction.ts";

// Drawing → per-parameter suggestions. Stateless: the drawing is never stored; suggestions
// die with the response. // ponytail: store drawing on project when audit/history need fires
// Platform-level key by design (no per-tenant keys/metering in this milestone).

const MAX_BYTES = 15 * 1024 * 1024;
const MAX_BASE64 = Math.ceil(MAX_BYTES / 3) * 4; // base64 inflates 4/3

export const extractionRouter = {
  extract: userProcedure
    .input(
      z.object({
        modelId: z.uuid(),
        file: z.object({
          name: z.string().min(1),
          mimeType: z.enum(["application/pdf", "image/png", "image/jpeg"]),
          dataBase64: z.string().min(1),
        }),
      }),
    )
    .handler(async ({ input, context }) => {
      const apiKey = process.env.GEMINI_API_KEY;
      if (!apiKey)
        throw new ORPCError("SERVICE_UNAVAILABLE", {
          message: "Drawing extraction is not configured on this server (GEMINI_API_KEY is unset).",
        });
      if (input.file.dataBase64.length > MAX_BASE64)
        throw new ORPCError("BAD_REQUEST", { message: "The file exceeds the 15MB limit." });

      const model = await loadModel(context.tenantId, input.modelId);
      if (needsAgent(model.definition)) await assertAgentReady(context.tenantId);
      const lookups = await freshLookups(context.tenantId, model.definition, agentFetcher(context.tenantId));
      const { prompt, responseSchema } = buildExtractionRequest(model.definition, lookups.domains);

      let text: string | undefined;
      try {
        const ai = new GoogleGenAI({ apiKey });
        const res = await ai.models.generateContent({
          model: process.env.GEMINI_MODEL ?? "gemini-3-flash",
          contents: [
            {
              role: "user",
              parts: [
                { inlineData: { mimeType: input.file.mimeType, data: input.file.dataBase64 } },
                { text: prompt },
              ],
            },
          ],
          config: { responseMimeType: "application/json", responseSchema: responseSchema as Schema },
        });
        text = res.text;
      } catch (e) {
        throw new ORPCError("BAD_GATEWAY", {
          message: `Drawing extraction failed: ${e instanceof Error ? e.message : String(e)}. Retry, or enter the values manually.`,
        });
      }

      let raw: unknown;
      try {
        raw = JSON.parse(text ?? "");
      } catch {
        throw new ORPCError("BAD_GATEWAY", {
          message: "The extraction service returned an unreadable result. Retry, or enter the values manually.",
        });
      }
      return { suggestions: validateSuggestions(model.definition, lookups.domains, raw) };
    }),
};
```

- [ ] **Step 4: Register the router**

In `apps/server/src/orpc/router.ts`:

```ts
import { syncRouter } from "./routers/sync.ts";
import { entitiesRouter } from "./routers/entities.ts";
import { variantsRouter } from "./routers/variants.ts";
import { modelsRouter } from "./routers/models.ts";
import { configsRouter } from "./routers/configs.ts";
import { extractionRouter } from "./routers/extraction.ts";

export const router = {
  sync: syncRouter,
  entities: entitiesRouter,
  variants: variantsRouter,
  models: modelsRouter,
  configs: configsRouter,
  extraction: extractionRouter,
};

export type AppRouter = typeof router;
```

- [ ] **Step 5: Verify — typecheck and full test suite**

Run: `bunx tsc --noEmit -p apps/server`
Expected: no errors. (If `responseSchema as Schema` complains about `enum` value types, the `Schema` import is the SDK's own schema type — check the exact member name in `node_modules/@google/genai`; the cast target is whatever type `config.responseSchema` declares.)

Run: `bun test apps/server packages/config-engine`
Expected: PASS (extraction, lookups, configurator — the DB-gated configurator suite skips without `DATABASE_URL`).

- [ ] **Step 6: Commit**

```bash
git add apps/server/package.json bun.lock apps/server/src/orpc/routers/extraction.ts apps/server/src/orpc/routers/configs.ts apps/server/src/orpc/router.ts
git commit -m "feat(server): extraction.extract — Gemini drawing extraction behind userProcedure"
```

---

### Task 5: web — ExtractPanel in the Configure step

**Files:**
- Create: `apps/web/src/components/configurator/ExtractPanel.tsx`
- Modify: `apps/web/src/components/configurator/StepConfigure.tsx`
- Modify: `apps/web/src/components/configurator/ConfigProcessPage.tsx`

**Interfaces:**
- Consumes: `orpc.extraction.extract` (Task 4) via TanStack Query mutation; `ModelDef`, `Entries`, `Val` from `@hera/config-engine`; suggestion shape `{ paramKey, value, evidence, valid, reason? }` inferred end-to-end from `AppRouter`.
- Produces: `ExtractPanel({ modelId, model, entries, onChange })` — accepted suggestions merge into `entries` through the same `onChange` the form uses, so live propagation and conflict display react exactly as manual entry would.

- [ ] **Step 1: Create the panel component**

Create `apps/web/src/components/configurator/ExtractPanel.tsx`:

```tsx
import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import {
  BusyIndicator, Button, FileUploader, List, ListItemCustom, MessageStrip, ObjectStatus, Panel, Text,
} from "@ui5/webcomponents-react";
import type { Entries, ModelDef, Val } from "@hera/config-engine";
import { orpc } from "../../orpc.ts";

// Upload a customer drawing → server-side Gemini extraction → per-parameter suggestions.
// Suggest-and-confirm: values enter `entries` only through an explicit Accept click; invalid
// (out-of-domain) suggestions render with their reason and no Accept action.

const MAX_BYTES = 15 * 1024 * 1024;
const MIME_BY_EXT: Record<string, "application/pdf" | "image/png" | "image/jpeg"> = {
  pdf: "application/pdf", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
};

async function toBase64(f: File): Promise<string> {
  const buf = new Uint8Array(await f.arrayBuffer());
  let bin = "";
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return btoa(bin);
}

type Suggestion = { paramKey: string; value: Val; evidence: string; valid: boolean; reason?: string };

export function ExtractPanel({ modelId, model, entries, onChange }: {
  modelId: string;
  model: ModelDef;
  entries: Entries;
  onChange: (next: Entries) => void;
}) {
  const [fileError, setFileError] = useState<string | null>(null);
  const [handled, setHandled] = useState<Set<string>>(new Set()); // accepted or dismissed paramKeys
  const extract = useMutation(orpc.extraction.extract.mutationOptions({ onSuccess: () => setHandled(new Set()) }));

  const pick = async (file: File | null | undefined) => {
    setFileError(null);
    if (!file) return;
    const mimeType = MIME_BY_EXT[file.name.split(".").pop()?.toLowerCase() ?? ""];
    if (!mimeType) return setFileError("Only PDF, PNG or JPEG drawings are supported.");
    if (file.size > MAX_BYTES) return setFileError("The file exceeds the 15MB limit.");
    extract.mutate({ modelId, file: { name: file.name, mimeType, dataBase64: await toBase64(file) } });
  };

  const accept = (list: Suggestion[]) => {
    const next = { ...entries };
    for (const s of list) {
      const p = model.parameters.find((x) => x.key === s.paramKey);
      next[s.paramKey] = p?.ui === "multicombo" ? [String(s.value)] : s.value; // multicombo entries are string[]
    }
    onChange(next);
    setHandled((h) => new Set([...h, ...list.map((s) => s.paramKey)]));
  };
  const dismiss = (key: string) => setHandled((h) => new Set([...h, key]));

  const suggestions: Suggestion[] = extract.data?.suggestions ?? [];
  const open = suggestions.filter((s) => !handled.has(s.paramKey));
  const openValid = open.filter((s) => s.valid);
  const labelOf = (key: string) => model.parameters.find((p) => p.key === key)?.label ?? key;

  return (
    <Panel headerText="Extract from drawing" fixed>
      <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
        <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
          <FileUploader hideInput accept=".pdf,.png,.jpg,.jpeg" disabled={extract.isPending}
            onChange={(e) => void pick(e.target.files?.[0])}>
            <Button icon="upload">Upload drawing</Button>
          </FileUploader>
          {extract.isPending ? <BusyIndicator active delay={0} size="S" text="Reading drawing…" /> : null}
          {openValid.length > 1 ? (
            <Button design="Emphasized" onClick={() => accept(openValid)}>Accept all valid ({openValid.length})</Button>
          ) : null}
        </div>

        {fileError ? <MessageStrip design="Negative" hideCloseButton>{fileError}</MessageStrip> : null}
        {extract.error ? (
          <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
            <MessageStrip design="Negative" hideCloseButton>{extract.error.message}</MessageStrip>
            <Button style={{ alignSelf: "start" }} onClick={() => extract.mutate(extract.variables!)}>Retry</Button>
          </div>
        ) : null}
        {extract.isSuccess && suggestions.length === 0 ? (
          <Text>Nothing could be extracted from this drawing.</Text>
        ) : null}

        {open.length ? (
          <List>
            {open.map((s) => (
              <ListItemCustom key={s.paramKey}>
                <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", width: "100%", padding: "0.25rem 0" }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <Text style={{ fontWeight: "bold" }}>{labelOf(s.paramKey)}: {String(s.value)}</Text>
                    <Text wrapping style={{ display: "block", fontSize: "0.8rem" }}>{s.evidence}</Text>
                    {!s.valid ? <ObjectStatus state="Negative">{s.reason}</ObjectStatus> : null}
                  </div>
                  {s.valid ? <Button design="Positive" onClick={() => accept([s])}>Accept</Button> : null}
                  <Button design="Transparent" onClick={() => dismiss(s.paramKey)}>Dismiss</Button>
                </div>
              </ListItemCustom>
            ))}
          </List>
        ) : null}
      </div>
    </Panel>
  );
}
```

- [ ] **Step 2: Render it in StepConfigure**

In `apps/web/src/components/configurator/StepConfigure.tsx`, add the prop and render the panel above the form:

```tsx
import type { UseQueryResult } from "@tanstack/react-query";
import { Bar, BusyIndicator, Button, MessageStrip } from "@ui5/webcomponents-react";
import type { Entries, ModelDef, ResolvedLookups } from "@hera/config-engine";
import { ConfiguratorForm } from "./ConfiguratorForm.tsx";
import { ExtractPanel } from "./ExtractPanel.tsx";

// Wizard step 1: the same form the builder preview uses, over server-resolved lookups.
// Lookup errors (agent offline, source unreachable) surface verbatim with a retry.
export function StepConfigure({ modelId, model, lookups, entries, onChange, onNext, saving, conflicted }: {
  modelId: string;
  model: ModelDef;
  lookups: UseQueryResult<ResolvedLookups, Error>;
  entries: Entries;
  onChange: (next: Entries) => void;
  onNext: () => void;
  saving: boolean;
  conflicted: boolean;
}) {
  if (lookups.isPending) return <BusyIndicator active delay={200} style={{ width: "100%", marginTop: "3rem" }} />;
  if (lookups.error)
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
        <MessageStrip design="Negative" hideCloseButton>{lookups.error.message}</MessageStrip>
        <Button style={{ alignSelf: "start" }} onClick={() => lookups.refetch()}>Retry</Button>
      </div>
    );
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
      <ExtractPanel modelId={modelId} model={model} entries={entries} onChange={onChange} />
      <ConfiguratorForm model={model} lookups={lookups.data} entries={entries} onChange={onChange} />
      <Bar design="FloatingFooter" endContent={
        <Button design="Emphasized" disabled={conflicted || saving} onClick={onNext}
          tooltip={conflicted ? "Resolve the conflicts above first" : undefined}>
          {saving ? "Saving…" : "Next: batches"}
        </Button>
      } />
    </div>
  );
}
```

- [ ] **Step 3: Pass modelId from ConfigProcessPage**

In `apps/web/src/components/configurator/ConfigProcessPage.tsx`, the `StepConfigure` usage becomes:

```tsx
          <StepConfigure model={model.definition} modelId={project.modelId} lookups={lookups} entries={entries}
            onChange={setEntries} onNext={() => goto(1)} saving={update.isPending} conflicted={conflicted} />
```

- [ ] **Step 4: Verify — typecheck and build**

Run: `bunx tsc --noEmit -p apps/web`
Expected: no errors. (If `FileUploader`'s `onChange` typing exposes files on `e.detail` instead of `e.target`, use `e.detail.files?.[0]` — check the `Ui5FileUploaderDomRef` typing; both carry the `FileList`.)

Run: `bun --cwd apps/web build`
Expected: vite build succeeds.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/configurator/ExtractPanel.tsx apps/web/src/components/configurator/StepConfigure.tsx apps/web/src/components/configurator/ConfigProcessPage.tsx
git commit -m "feat(web): drawing upload + extraction suggestions in the Configure step"
```

---

### Task 6: model builder — extraction context + hint fields

**Files:**
- Modify: `apps/web/src/components/configurator/SettingsTab.tsx`
- Modify: `apps/web/src/components/configurator/ParamsTab.tsx`

**Interfaces:**
- Consumes: `ModelDef.extraction?.context` and `Param.extractionHint` (Task 1); the existing `update((d) => ...)` draft updater and `set(patch)` dialog state setter.
- Produces: plain fields on existing dialogs — no new tab, no new components.

- [ ] **Step 1: Extraction context TextArea in SettingsTab**

In `apps/web/src/components/configurator/SettingsTab.tsx`, add `TextArea` to the existing import from `@ui5/webcomponents-react`, then add a `FormItem` inside the `FormGroup headerText="Model"` block, after the "Default batch sizes" item:

```tsx
          <FormItem labelContent={<Label>Extraction context</Label>}>
            <TextArea value={draft.extraction?.context ?? ""} rows={3}
              placeholder="Drawing conventions the AI should know (units, title-block layout, notation)…"
              onInput={(e) =>
                update((d) => ({ ...d, extraction: e.target.value ? { context: e.target.value } : undefined }))} />
          </FormItem>
```

- [ ] **Step 2: Extraction hint Input in the parameter dialog**

In `apps/web/src/components/configurator/ParamsTab.tsx`, inside `ParamDialog`'s grid, after the "Help text" `<div>`:

```tsx
        <div style={{ gridColumn: "1 / -1" }}>
          <Label>Extraction hint</Label>
          <Input value={p.extractionHint ?? ""}
            placeholder='Where/how this appears on drawings, e.g. "title block MATERIAL field"'
            onInput={(e) => set({ extractionHint: e.target.value || undefined })} />
        </div>
```

- [ ] **Step 3: Verify — typecheck**

Run: `bunx tsc --noEmit -p apps/web`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/configurator/SettingsTab.tsx apps/web/src/components/configurator/ParamsTab.tsx
git commit -m "feat(web): extraction context + per-parameter hint fields in model builder"
```

---

### Task 7: manual end-to-end verification

**Files:** none (verification only). Prereq: `GEMINI_API_KEY=<key>` in the root `.env` (optional `GEMINI_MODEL=gemini-3-flash`), and a sample drawing PDF.

- [ ] **Step 1: Full automated suite**

Run: `bun test packages/config-engine apps/server && bunx tsc --noEmit -p apps/server && bunx tsc --noEmit -p apps/web`
Expected: all green.

- [ ] **Step 2: Manual e2e (per the spec's checklist)**

Run: `bun dev`, open the demo tenant (`http://acme.lvh.me:5173`), then verify each:

1. Model builder → Settings: fill "Extraction context"; edit a parameter → fill "Extraction hint"; Save succeeds (fields survive reload).
2. Open a configuration → Configure step → "Upload drawing" with a sample PDF → busy indicator, then suggestions render with evidence text.
3. An out-of-domain value (if the drawing produces one) shows flagged with a reason and **no Accept button**.
4. Accept a valid suggestion → the form control updates, live propagation reacts (dependent domains narrow / conflicts surface exactly as manual entry).
5. "Accept all valid" applies every open valid suggestion at once.
6. Upload a >15MB file → client-side error before any request; upload a `.txt` → "Only PDF, PNG or JPEG".
7. Unset `GEMINI_API_KEY`, restart the server, upload → friendly "not configured" message with Retry.
8. Upload a non-drawing PDF (e.g. a text invoice) → "Nothing could be extracted from this drawing." (model returns nulls).

- [ ] **Step 3: Commit anything the manual pass shook out; otherwise done**

---

## Self-Review (completed)

- **Spec coverage:** ModelDef extension → T1; `extract.ts` prompt+schema → T2; server validation → T3; `extraction.extract` procedure, size/mime gate, Gemini call, error handling → T4; Configure-step upload/suggestions/accept flow → T5; builder fields → T6; engine golden tests → T2, server validation tests → T3, manual e2e → T7. Persistence/out-of-scope items: nothing added — matches spec.
- **Placeholder scan:** every code step carries full code; no TBDs.
- **Type consistency:** `Suggestion` shape identical in T3 (source of truth), T4 (returned), T5 (local mirror type — inferred via oRPC anyway); `buildExtractionRequest(model, domains)` signature identical in T2 and T4; `extraction?.context` / `extractionHint` names identical in T1, T2, T6.
