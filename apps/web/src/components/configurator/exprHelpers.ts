import { FUNCS, derivedColumns, derivedKey, type ModelDef, type Param } from "@hera/config-engine";

// Suggestion machinery for ExprInput. Completion targets the TRAILING identifier of the
// value — the common typing flow. // ponytail: caret-aware mid-expression completion needs
// shadow-DOM selectionStart poking; add if authors ask for it.

export type Suggestion = {
  text: string;
  kind: "param" | "computed" | "var" | "function" | "derived";
  /** human label shown as secondary text (params and derived columns) */
  label?: string;
};

/** One tenant masterdata table, as the builder needs it: a name, its column keys, and which
 *  kind it is. Both kinds share one namespace — a model references either the same way. */
export type TableCols = { name: string; kind: "table" | "query"; columns: string[] };

/** Overlay a param being edited (including unsaved new ones) so its derived keys are in scope. */
export function modelWithParam(model: ModelDef, p: Param): ModelDef {
  if (!p.key) return model;
  return { ...model, parameters: [...model.parameters.filter((x) => x.key !== p.key), p] };
}

export function scopeSuggestions(model: ModelDef, extraVars: string[] = [], tables: TableCols[] = []): Suggestion[] {
  const colsOf = (name: string) => tables.find((t) => t.name === name)?.columns;
  const derived = model.parameters.flatMap((p) => {
    const ref = p.domain?.kind === "options" ? p.domain.ref : undefined;
    if (!ref || ref.source === "manual") return [];
    return derivedColumns(ref, colsOf(ref.table)).map((c) => ({
      text: derivedKey(p.key, c),
      kind: "derived" as const,
      label: c,
    }));
  });
  return [
    ...model.parameters.map((p) => ({ text: p.key, kind: "param" as const, label: p.label })),
    ...derived,
    ...model.computed.map((c) => ({ text: c.key, kind: "computed" as const })),
    ...extraVars.map((v) => ({ text: v, kind: "var" as const })),
    ...[...FUNCS].map((f) => ({ text: f, kind: "function" as const })),
  ];
}

export function trailingIdent(src: string): string {
  return /([a-zA-Z_][a-zA-Z0-9_]*)$/.exec(src)?.[1] ?? "";
}

export function matches(all: Suggestion[], src: string): Suggestion[] {
  const frag = trailingIdent(src);
  if (!frag) return [];
  const lower = frag.toLowerCase();
  const col = `_${lower}`;
  return all.filter((s) => {
    if (s.text === frag) return false;
    const t = s.text.toLowerCase();
    return t.startsWith(lower) || (s.kind === "derived" && t.includes(col));
  });
}

export function complete(src: string, s: Suggestion): string {
  const frag = trailingIdent(src);
  const done = src.slice(0, src.length - frag.length) + s.text;
  return s.kind === "function" ? done + "(" : done;
}
