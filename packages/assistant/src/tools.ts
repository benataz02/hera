import { z } from "zod";
import { ValZ } from "./events.ts";

// Eight tool declarations: strict zod input AND output schemas with descriptions.
// Executors are injected by apps/server; TanStack toolDefinition() conversion happens
// in the server adapter so this module stays adapter-free.

export const EvidenceZ = z.strictObject({
  source: z.enum(["user", "drawing", "similar", "document"]).describe("where this value came from"),
  detail: z.string().min(1).max(2000).describe("the exact words/callout/row that state the value"),
  sourceRef: z.strictObject({
    toolCallId: z.string().min(1).max(100), resultId: z.string().min(1).max(100),
    rowId: z.string().max(100).optional(), paramKey: z.string().max(200).optional(),
  }).optional().describe("required for drawing/similar/document: the exact ids that tool returned"),
});
export type Evidence = z.infer<typeof EvidenceZ>;

const errZ = z.strictObject({
  ok: z.literal(false), code: z.string().max(50), message: z.string().max(2000),
  retryable: z.boolean(), details: z.unknown().optional(),
});
const staleZ = z.strictObject({
  ok: z.literal(true), stale: z.literal(true),
  observedProjectVersion: z.string().max(40).optional(), observedAt: z.string().max(40).optional(),
  summary: z.string().max(2000).optional(), message: z.string().max(200),
});
export const staleResult = (observedProjectVersion?: string) => ({
  ok: true as const, stale: true as const, observedProjectVersion,
  message: "Call the tool again for current data",
});
/** ok-variant helper: { ok:true, stale:false, ...shape } | stale | error */
const toolResult = <T extends z.ZodRawShape>(shape: T) =>
  z.union([z.strictObject({ ok: z.literal(true), stale: z.literal(false), ...shape }), staleZ, errZ]);

const version = z.string().max(40);
const changeRowsZ = z.array(z.strictObject({
  key: z.string().max(200), from: ValZ.optional(), to: ValZ, evidence: z.string().max(2000),
  valid: z.boolean(), reason: z.string().max(1000).optional(),
})).max(200);
const topZ = z.array(z.strictObject({
  candidateId: z.string().max(100), label: z.string().max(400), keyFigure: z.string().max(200).optional(),
})).max(5);
const previewTopZ = z.array(z.strictObject({
  previewId: z.string().max(100), label: z.string().max(400), keyFigure: z.string().max(200).optional(),
})).max(5);

export const makeSetValuesInputZ = (paramKeys: string[]) =>
  z.strictObject({
    values: z.array(z.strictObject({
      key: z.enum(paramKeys as [string, ...string[]]).describe("parameter key"),
      value: ValZ.describe("the value to set"),
      evidence: EvidenceZ,
    })).min(1).max(Math.max(paramKeys.length, 1)),
  });

export const makePreviewCandidatesInputZ = (paramKeys: string[]) =>
  z.strictObject({
    overrides: z.strictObject(Object.fromEntries(
      paramKeys.map((key) => [key, ValZ.optional()]),
    )).optional(),
  });

export const TOOLS = {
  setValues: {
    name: "setValues", kind: "write" as const,
    label: "Applying values…",
    description: "Set one or more configuration values with structured evidence. Returns per-value validity, the new working revision, narrowed domains and remaining conflicts. Invalid values are returned, never applied.",
    // NOTE: the loop swaps this for makeSetValuesInputZ(model keys) per turn; this static
    // fallback keeps the declaration self-contained.
    input: z.strictObject({ values: z.array(z.strictObject({ key: z.string().max(200), value: ValZ, evidence: EvidenceZ })).min(1).max(200) }),
    output: toolResult({
      workingRevision: z.number().int().min(0), changes: changeRowsZ,
      conflicts: z.array(z.string().max(1000)).max(50), unset: z.array(z.string().max(200)).max(200),
    }),
  },
  extractFromDrawing: {
    name: "extractFromDrawing", kind: "read" as const,
    label: "Reading the drawing…",
    description: "Read the attached technical drawing and return per-parameter value suggestions with evidence and provenance ids. Apply values with setValues afterwards.",
    input: z.strictObject({}),
    output: toolResult({
      resultId: z.string().max(100), observedProjectVersion: version,
      params: z.array(z.strictObject({
        paramKey: z.string().max(200), value: ValZ, evidence: z.string().max(2000), rowId: z.string().max(100),
      })).max(200),
    }),
  },
  previewCandidates: {
    name: "previewCandidates", kind: "read" as const,
    label: "Previewing candidates…",
    description: "What-if enumeration on the current working values plus optional overrides. Persists nothing; preview ids are NOT selectable.",
    input: makePreviewCandidatesInputZ([]),
    output: toolResult({
      resultId: z.string().max(100), observedProjectVersion: version,
      workingRevision: z.number().int().min(0), candidateCount: z.number().int().min(0), top: previewTopZ,
    }),
  },
  calculate: {
    name: "calculate", kind: "write" as const,
    label: "Calculating candidates…",
    description: "Persist the working configuration and compute candidates (or reuse the identical latest run). Freezes setValues for the rest of this turn.",
    input: z.strictObject({}),
    output: toolResult({
      runId: z.uuid(), projectVersion: version,
      reused: z.boolean(), candidateCount: z.number().int().min(0), top: topZ,
    }),
  },
  selectCandidates: {
    name: "selectCandidates", kind: "write" as const,
    label: "Saving selection…",
    description: "Save candidate picks on the current run. Requires the exact current runId and candidateIds from this turn's calculate result.",
    input: z.strictObject({
      runId: z.uuid(),
      selections: z.array(z.strictObject({ candidateId: z.string().max(100), batchQty: z.number().int().min(1) })).min(1).max(100),
      mode: z.enum(["add", "replace"]),
    }),
    output: toolResult({
      runId: z.uuid(),
      selections: z.array(z.strictObject({ candidateId: z.string().max(100), batchQty: z.number().int().min(1) })).max(100),
    }),
  },
  searchSimilar: {
    name: "searchSimilar", kind: "read" as const,
    label: "Searching similar configurations…",
    description: "Rank past configurations by similarity to the current working values. Row ids are provenance for setValues.",
    input: z.strictObject({}),
    output: toolResult({
      resultId: z.string().max(100), observedProjectVersion: version,
      rows: z.array(z.strictObject({
        rowId: z.string().max(100), score: z.number(),
        values: z.record(z.string().max(200), ValZ), display: z.record(z.string().max(200), ValZ),
      })).max(3),
    }),
  },
  getDocHistory: {
    name: "getDocHistory", kind: "read" as const,
    label: "Fetching document history…",
    description: "Live B1 orders/quotations for the project customer and/or an item code. Row ids are provenance for setValues.",
    input: z.strictObject({ itemCode: z.string().max(100).optional() }),
    output: toolResult({
      resultId: z.string().max(100), observedProjectVersion: version, observedAt: z.string().max(40),
      rows: z.array(z.strictObject({
        rowId: z.string().max(100), kind: z.enum(["order", "quotation"]),
        docNum: z.string().max(50), date: z.string().max(40), itemCode: z.string().max(100),
        qty: z.number(), price: z.number().optional(),
      })).max(20),
      truncated: z.boolean(), total: z.number().int().min(0),
    }),
  },
  suggestFollowUps: {
    name: "suggestFollowUps", kind: "read" as const,
    label: "Preparing suggestions…",
    description: "Propose up to 3 short next-step prompts in the user's voice, shown as chips under your final reply. Call before your final answer.",
    input: z.strictObject({ suggestions: z.array(z.string().min(1).max(120)).max(3) }),
    output: toolResult({ accepted: z.array(z.string().max(120)).max(3) }),
  },
} as const;
export type ToolName = keyof typeof TOOLS;
