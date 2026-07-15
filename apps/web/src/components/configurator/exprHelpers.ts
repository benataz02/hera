import { FUNCS, refColumns, derivedKey, type ModelDef } from "@hera/config-engine";

// Suggestion machinery for ExprInput. Completion targets the TRAILING identifier of the
// value — the common typing flow. // ponytail: caret-aware mid-expression completion needs
// shadow-DOM selectionStart poking; add if authors ask for it.

export type Suggestion = {
  text: string;
  kind: "param" | "computed" | "var" | "function" | "derived";
  /** human label shown as secondary text (params only) */
  label?: string;
};

export function scopeSuggestions(model: ModelDef, extraVars: string[] = []): Suggestion[] {
  // ponytail: tenant-table columns aren't available here, so default-all tenant refs get no
  // derived suggestions (checkModel still validates them); pass tables through if it ever matters.
  const colsOf = (name: string) => model.queryTables.find((q) => q.name === name)?.columns;
  const derived = model.parameters.flatMap((p) => {
    const ref = p.domain?.kind === "options" ? p.domain.ref : undefined;
    if (!ref || ref.source === "manual") return [];
    return refColumns(ref, colsOf(ref.table)).map((c) => ({ text: derivedKey(p.key, c), kind: "derived" as const }));
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
  return all.filter((s) => s.text.toLowerCase().startsWith(lower) && s.text !== frag);
}

export function complete(src: string, s: Suggestion): string {
  const frag = trailingIdent(src);
  const done = src.slice(0, src.length - frag.length) + s.text;
  return s.kind === "function" ? done + "(" : done;
}
