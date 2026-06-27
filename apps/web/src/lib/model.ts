import type { Model, FormSection, FormGroup, FormItem, PredefinedFormula } from "@hera/config-engine";

// Short ids for builder nodes (client-only; the engine keys on item `name`, not `id`).
export const uid = (): string => Math.random().toString(36).slice(2, 10);

export const blankModel = (): Model => ({ name: "New model", family: "", sections: [], rules: [], formulas: [] });

export const blankFormula = (itemId?: string): PredefinedFormula =>
  ({ id: uid(), name: "formula_" + uid().slice(0, 4), expr: "", ...(itemId ? { itemId } : {}) });

export const blankSection = (): FormSection => ({ id: uid(), label: "New section", groups: [] });

export const blankGroup = (): FormGroup => ({ id: uid(), label: "New group", items: [] });

export const blankItem = (): FormItem => ({
  id: uid(),
  name: "field_" + uid().slice(0, 4),
  label: "New field",
  input: { mandatory: false, dataSource: { kind: "normal" }, inputType: "input", value: { kind: "manual" } },
});

// Walk every item once (used for the live preview's enumerate + the runtime render).
export const allItems = (m: Model): FormItem[] => m.sections.flatMap((s) => s.groups.flatMap((g) => g.items));

// --- expression-input autocomplete helpers (used by ModelBuilder's ExprInput) -------------------
// The identifier the user is mid-typing = the trailing identifier of the value.
const TOKEN = /[A-Za-z_][A-Za-z0-9_]*$/;
export const trailingToken = (s: string): string => s.match(TOKEN)?.[0] ?? "";

// UI5's Input overwrites the whole field with the bare name when a suggestion is picked. `next` is
// the value UI5 produced; if it's exactly a known formula name and there's a prefix before the typed
// token, the user picked — splice the name back onto that prefix. Otherwise it's ordinary typing.
export const applyExprPick = (value: string, next: string, names: Set<string>): string => {
  const base = value.replace(TOKEN, "");
  return base && names.has(next) ? base + next : next;
};

if (import.meta.main) {
  const ok = (c: boolean, m: string) => { if (!c) throw new Error(m); };
  const names = new Set(["areaM2", "unit"]);
  ok(trailingToken("x == ar") === "ar", "trailing token");
  ok(trailingToken("x == ") === "", "no token after operator");
  ok(applyExprPick("x == ar", "areaM2", names) === "x == areaM2", "pick splices onto prefix");
  ok(applyExprPick("are", "areaM2", names) === "areaM2", "pick with no prefix");
  ok(applyExprPick("x == are", "x == area", names) === "x == area", "ordinary typing passes through");

  console.log("model lib self-check: OK");
}
