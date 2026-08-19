import { z } from "zod";

// The `assist.chat` input contract. Lives in the package (not next to the loop) because
// apps/web types its send() call against it.

export const ExtractFileZ = z.strictObject({
  name: z.string().min(1).max(400),
  mimeType: z.enum(["application/pdf", "image/png", "image/jpeg"]),
  dataBase64: z.string().min(1),
});
export type ExtractFile = z.infer<typeof ExtractFileZ>;

const ResumeZ = z.strictObject({
  lastAppliedSeq: z.number().int().min(-1),
  touchedEntryKeys: z.array(z.string().max(200)).max(200),
  batchesTouched: z.boolean(),
});

export const EntriesValZ = z.union([z.number(), z.string(), z.boolean(), z.null(), z.array(z.string())]);

export const AssistChatInputZ = z.strictObject({
  projectId: z.uuid(), conversationId: z.uuid().optional(), turnId: z.uuid(),
  provider: z.enum(["gemini", "anthropic", "openai"]).optional(),
  model: z.string().min(1).max(200).optional(),
  entries: z.record(z.string(), EntriesValZ), batches: z.array(z.number().int().min(1)).max(50),
  projectVersion: z.string().max(40),
  message: z.string().min(1).max(4000),
  file: ExtractFileZ.optional(),
  resume: ResumeZ.optional(),
});
export type AssistChatInput = z.infer<typeof AssistChatInputZ>;
