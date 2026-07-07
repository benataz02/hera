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
