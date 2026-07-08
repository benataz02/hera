import { ORPCError } from "@orpc/server";
import { z } from "zod";
import { GoogleGenAI, type Schema } from "@google/genai";
import { buildExtractionRequest, type ModelDef, type ResolvedLookups } from "@hera/config-engine";
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

export const ExtractFileZ = z.object({
  name: z.string().min(1),
  mimeType: z.enum(["application/pdf", "image/png", "image/jpeg"]),
  dataBase64: z.string().min(1),
});
export type ExtractFile = z.infer<typeof ExtractFileZ>;

// Gemini call + validation, shared by the internal and portal `extract` handlers — both resolve
// model/lookups/agent-readiness themselves first (portal additionally gates on model.portal).
export async function extractSuggestions(model: { definition: ModelDef }, lookups: ResolvedLookups, file: ExtractFile) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey)
    throw new ORPCError("SERVICE_UNAVAILABLE", {
      message: "Drawing extraction is not configured on this server (GEMINI_API_KEY is unset).",
    });
  if (file.dataBase64.length > MAX_BASE64)
    throw new ORPCError("BAD_REQUEST", { message: "The file exceeds the 15MB limit." });

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
            { inlineData: { mimeType: file.mimeType, data: file.dataBase64 } },
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
}

export const extractionRouter = {
  extract: userProcedure
    .input(z.object({ modelId: z.uuid(), file: ExtractFileZ }))
    .handler(async ({ input, context }) => {
      const model = await loadModel(context.tenantId, input.modelId);
      if (needsAgent(model.definition)) await assertAgentReady(context.tenantId);
      const lookups = await freshLookups(context.tenantId, model.definition, agentFetcher(context.tenantId));
      return extractSuggestions(model, lookups, input.file);
    }),
};
