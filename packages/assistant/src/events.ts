import { z } from "zod";

// The wire protocol between the Chati turn loop and the browser. Strict: unknown event
// types/keys, invalid ids, out-of-bound arrays or text are rejected BEFORE yield.

export const ValZ = z.union([z.string().max(4000), z.number(), z.boolean(), z.array(z.string().max(400)).max(100), z.null()]);
const envelope = { turnId: z.uuid(), seq: z.number().int().min(0) };

export const ProvenanceZ = z.strictObject({
  source: z.enum(["user", "drawing", "similar", "document"]),
  detail: z.string().max(2000),
  sourceRef: z.unknown().optional(),
});

export const ChangeRowZ = z.strictObject({
  key: z.string().max(200),
  from: ValZ.optional(),
  to: ValZ,
  evidence: z.string().max(2000),
  provenance: ProvenanceZ,
  valid: z.boolean(),
  reason: z.string().max(1000).optional(),
});

const CandidateTopZ = z.strictObject({
  candidateId: z.string().max(100),
  label: z.string().max(400),
  keyFigure: z.string().max(200).optional(),
});
const UsageZ = z.strictObject({ inputTokens: z.number().int().min(0), outputTokens: z.number().int().min(0) });
const SelectionRowZ = z.strictObject({ candidateId: z.string().max(100), batchQty: z.number().int().min(1) });

export const AssistantEventZ = z.discriminatedUnion("type", [
  z.strictObject({ ...envelope, type: z.literal("snapshot"),
    text: z.string().max(100_000), changes: z.array(ChangeRowZ).max(200),
    results: z.array(z.strictObject({ tool: z.string().max(50), resultId: z.string().max(100), data: z.unknown() })).max(16),
    candidates: z.strictObject({ runId: z.uuid(), projectVersion: z.string().max(40), selectionVersion: z.number().int().min(0), candidateCount: z.number().int().min(0), top: z.array(CandidateTopZ).max(5) }).optional(),
    selection: z.strictObject({ runId: z.uuid(), selectionVersion: z.number().int().min(0), selections: z.array(SelectionRowZ).max(100) }).optional(),
    suggestions: z.array(z.string().max(120)).max(3).optional(),
    status: z.enum(["running", "partial", "complete", "failed"]),
    projectVersion: z.string().max(40),
  }),
  z.strictObject({ ...envelope, type: z.literal("delta"), text: z.string().min(1).max(4096) }),
  z.strictObject({ ...envelope, type: z.literal("tool"), name: z.string().max(50), label: z.string().max(200) }),
  z.strictObject({ ...envelope, type: z.literal("result"),
    tool: z.enum(["searchSimilar", "getDocHistory", "previewCandidates"]),
    resultId: z.string().max(100), observedProjectVersion: z.string().max(40), data: z.unknown() }),
  z.strictObject({ ...envelope, type: z.literal("changes"),
    workingRevision: z.number().int().min(0), changes: z.array(ChangeRowZ).min(1).max(200) }),
  z.strictObject({ ...envelope, type: z.literal("candidates"),
    runId: z.uuid(), projectVersion: z.string().max(40), selectionVersion: z.number().int().min(0),
    candidateCount: z.number().int().min(0), top: z.array(CandidateTopZ).max(5) }),
  z.strictObject({ ...envelope, type: z.literal("selection"),
    runId: z.uuid(), selectionVersion: z.number().int().min(0), selections: z.array(SelectionRowZ).max(100) }),
  z.strictObject({ ...envelope, type: z.literal("conversation"),
    id: z.uuid(), title: z.string().max(120), provider: z.enum(["gemini", "anthropic", "openai"]) }),
  z.strictObject({ ...envelope, type: z.literal("error"),
    code: z.string().max(50), message: z.string().max(2000), retryable: z.boolean() }),
  z.strictObject({ ...envelope, type: z.literal("done"),
    suggestions: z.array(z.string().max(120)).max(3), usage: UsageZ }),
]);
export type AssistantEvent = z.infer<typeof AssistantEventZ>;
export type ChangeRow = z.infer<typeof ChangeRowZ>;
