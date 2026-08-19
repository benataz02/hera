import type { Entries, ModelDef, Option, Val } from "./model";

// Gemini structured-output schema (OpenAPI 3.0 subset: type/enum/nullable/properties/required).
export type JsonSchema = Record<string, unknown>;
export type ExtractionRequest = { prompt: string; responseSchema: JsonSchema };

/** The one way parameters are described to any LLM (extraction + assistant prompts).
 *  Without opts: byte-identical to the historical extraction lines. With opts: adds a
 *  Current line per parameter and hides eliminated options. */
export function formatParameterBlock(
  model: ModelDef,
  domains: Record<string, { value: Val; eliminatedBy?: string }[]>,
  opts?: { current?: Entries; defaulted?: Set<string> },
): string {
  const lines: string[] = [];
  for (const p of model.parameters) {
    const opts_ = (domains[p.key] ?? []).filter((o) => !opts || !o.eliminatedBy);
    let line = `- ${p.key}: ${p.label} (${p.type}${p.unit ? `, ${p.unit}` : ""})`;
    if (p.help) line += ` — ${p.help}`;
    lines.push(line);
    if (opts) {
      const v = opts.current?.[p.key];
      lines.push(`  Current: ${v === undefined || v === null ? "not set" : String(v)}${opts.defaulted?.has(p.key) ? " (defaulted)" : ""}`);
    }
    if (p.extractionHint) lines.push(`  Hint: ${p.extractionHint}`);
    if (p.domain?.kind === "range") lines.push(`  Allowed range: ${p.domain.min} to ${p.domain.max}`);
    if (opts_.length) lines.push(`  Allowed values: ${opts_.map((o) => String(o.value)).join(", ")}`);
  }
  return lines.join("\n");
}

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
    formatParameterBlock(model, domains as Record<string, { value: Val; eliminatedBy?: string }[]>),
  );

  const properties: Record<string, JsonSchema> = {};
  for (const p of model.parameters) {
    const opts = domains[p.key] ?? [];

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
