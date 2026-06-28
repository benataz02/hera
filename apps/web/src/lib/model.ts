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

// --- row identity (encoded into each Table row's data-key so one set of handlers acts on any row) ----
export type Key = { kind: "s" | "g" | "i"; sid: string; gid?: string; iid?: string };
export const keyOf = (k: Key): string => [k.kind, k.sid, k.gid, k.iid].filter(Boolean).join(":");
export const parseKey = (s?: string | null): Key | null => {
  const [kind, sid, gid, iid] = (s ?? "").split(":");
  if (kind === "s" && sid) return { kind, sid };
  if (kind === "g" && sid && gid) return { kind, sid, gid };
  if (kind === "i" && sid && gid && iid) return { kind, sid, gid, iid };
  return null;
};

// An oRPC input-validation issue (Zod): an index-based JSON path into the submitted input + a message.
export type Issue = { path: (string | number)[]; message: string };

// Resolve a save-validation issue path to the row it belongs to. The path is index-based against the
// *submitted* model and prefixed with "definition" (the input is `{ id, definition: ModelZ }`):
//   ["definition","sections",si,("groups",gi,("items",ii, …field))]
// Returns the row's keyOf string + the trailing field path (e.g. "input.dataSource.kind") for the
// message. null when it isn't a row-level issue (e.g. ["definition","name"]).
export const locateIssue = (path: (string | number)[], model: Model): { key: string; field: string } | null => {
  if (path[0] !== "definition" || path[1] !== "sections" || typeof path[2] !== "number") return null;
  const s = model.sections[path[2]];
  if (!s) return null;
  if (path[3] !== "groups" || typeof path[4] !== "number")
    return { key: keyOf({ kind: "s", sid: s.id }), field: path.slice(3).join(".") };
  const g = s.groups[path[4]];
  if (!g) return { key: keyOf({ kind: "s", sid: s.id }), field: path.slice(3).join(".") };
  if (path[5] !== "items" || typeof path[6] !== "number")
    return { key: keyOf({ kind: "g", sid: s.id, gid: g.id }), field: path.slice(5).join(".") };
  const it = g.items[path[6]];
  if (!it) return { key: keyOf({ kind: "g", sid: s.id, gid: g.id }), field: path.slice(5).join(".") };
  return { key: keyOf({ kind: "i", sid: s.id, gid: g.id, iid: it.id }), field: path.slice(7).join(".") };
};

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

  // locateIssue: index-based validation paths resolve to the right row key (with fallbacks).
  const m: Model = {
    name: "m", family: "", rules: [],
    sections: [{ id: "S", label: "", groups: [{ id: "G", label: "", items: [{ ...blankItem(), id: "I" }] }] }],
  };
  const at = (path: (string | number)[]) => locateIssue(path, m);
  ok(at(["definition", "sections", 0, "groups", 0, "items", 0, "input", "dataSource", "kind"])?.key === "i:S:G:I", "item path → item key");
  ok(at(["definition", "sections", 0, "groups", 0, "items", 0, "input", "dataSource", "kind"])?.field === "input.dataSource.kind", "item path → field suffix");
  ok(at(["definition", "sections", 0, "groups", 0, "label"])?.key === "g:S:G", "group path → group key");
  ok(at(["definition", "sections", 0, "label"])?.key === "s:S", "section path → section key");
  ok(at(["definition", "sections", 0, "groups", 0, "items", 9])?.key === "g:S:G", "out-of-range item falls back to group");
  ok(at(["definition", "name"]) === null, "non-row path → null");

  console.log("model lib self-check: OK");
}
