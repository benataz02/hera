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
