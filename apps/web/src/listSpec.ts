import type { AnalyticalTableColumnDefinition } from "@ui5/webcomponents-react";
import type { ListVariantDef, FilterCond } from "@hera/db";

// The pure half of a list view: column descriptors, the local executor, cell formatting. No hooks,
// no orpc — variants.ts re-exports all of it, and the test imports this module directly (orpc.ts
// touches `window` at module scope, so anything importing it can't be unit-tested under bun).

export type { ListVariantDef, ObjectVariantDef, FilterCond, FilterOp } from "@hera/db";

// VariantManagement's dialog flags come back as boolean | "true" | "false" (string-bool). Coerce.
export const truthy = (v: unknown): boolean => v === true || v === "true";

// Dirty = live view differs from the saved one. JSON compare is order-sensitive, which is what we
// want — column/sort/filter order are meaningful parts of the view.
// ponytail: structural compare via JSON.stringify; specs are built deterministically.
export const sameDef = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

// A column as ListReport needs it. B1 pages pass `schema.properties` straight through (its
// {name, type, nullable} is structurally compatible); local pages hand-write the three optional
// fields. `Cell` and `options` must be stable references — AnalyticalTable memoization.
export type ListColumn = {
  name: string;
  type: string;
  /** human header; a variant's `labels` override still wins */
  label?: string;
  /** renders a Select in the FilterBar instead of a free-text Input */
  options?: { value: string; text: string }[];
  /** custom cell renderer; receives the raw (unformatted) value. Type-only import, erased at build. */
  Cell?: AnalyticalTableColumnDefinition["Cell"];
};

const isNumType = (t: string) => /int|double|decimal|single|byte|number/i.test(t);
const isDateType = (t: string) => /date|time/i.test(t);
const isBoolType = (t: string) => /bool/i.test(t);
export const isTextType = (t: string) => /string|char|memo|guid|text/i.test(t);

export const EMPTY_SPEC: ListVariantDef = { select: [], filter: [], orderby: [], filterBar: [] };

// The view's rendered column set = its explicit columns, or every column when it pins none
// (Standard). SINGLE source of truth for both the OData $select sent to B1 and the table columns.
export const visibleColumns = (spec: ListVariantDef, columns: ListColumn[]): string[] =>
  spec.select.length ? spec.select : columns.map((c) => c.name);

const compare = (a: unknown, b: unknown, type: string): number => {
  if (a == null && b == null) return 0;
  if (a == null) return -1;
  if (b == null) return 1;
  if (isNumType(type) || isBoolType(type)) return Number(a) - Number(b);
  if (isDateType(type)) return new Date(a as string).getTime() - new Date(b as string).getTime();
  return String(a).localeCompare(String(b));
};

const matches = (v: unknown, c: FilterCond, type: string): boolean => {
  if (c.op === "contains" || c.op === "startswith") {
    const hay = String(v ?? "").toLowerCase();
    const needle = String(c.value).toLowerCase();
    return c.op === "contains" ? hay.includes(needle) : hay.startsWith(needle);
  }
  // eq/ne are exact, matching OData. Numbers/dates/bools go through compare so "10" == 10.
  if (c.op === "eq" || c.op === "ne") {
    const same = isTextType(type) ? String(v ?? "") === String(c.value) : v != null && compare(v, c.value, type) === 0;
    return c.op === "eq" ? same : !same;
  }
  if (v == null) return false; // null compares to nothing, the way SQL/OData treat it
  const d = compare(v, c.value, type);
  return c.op === "gt" ? d > 0 : c.op === "ge" ? d >= 0 : c.op === "lt" ? d < 0 : d <= 0;
};

// Local counterpart of the agent's OData compilation: filter + search + orderby from the same
// ListVariantDef. Used by the pages whose list endpoint returns the whole array (models, configs),
// so saved views behave identically there without the table ever doing its own processing.
// ponytail: linear scan per condition — these lists are tens of rows, not thousands.
export function applySpec<T extends Record<string, unknown>>(
  rows: T[],
  spec: ListVariantDef,
  columns: ListColumn[],
): T[] {
  const typeOf = (field: string) => columns.find((c) => c.name === field)?.type ?? "string";
  let out = rows;

  for (const cond of spec.filter) {
    const type = typeOf(cond.field);
    out = out.filter((r) => matches(r[cond.field], cond, type));
  }

  // Search hits text columns only — same rule the server applies for B1 (contains() is string-only).
  const q = spec.search?.trim().toLowerCase();
  if (q) {
    const fields = columns.filter((c) => isTextType(c.type)).map((c) => c.name);
    out = out.filter((r) => fields.some((f) => String(r[f] ?? "").toLowerCase().includes(q)));
  }

  const ord = spec.orderby[0];
  if (ord) {
    const type = typeOf(ord.field);
    const sign = ord.dir === "desc" ? -1 : 1;
    // Copy before sorting: `out` may still be the caller's (query cache's) array.
    out = [...out].sort((a, b) => sign * compare(a[ord.field], b[ord.field], type));
  }
  return out;
}

// Table cells are strings. Dates get toLocaleString instead of String(date), which would render
// "Mon Jul 20 2026 10:33:21 GMT+0200 (Central European Summer Time)".
export const formatCell = (v: unknown, type = ""): string => {
  if (v == null) return "";
  if (isDateType(type)) {
    const d = new Date(v as string | number | Date);
    return Number.isNaN(d.getTime()) ? String(v) : d.toLocaleString();
  }
  return typeof v === "object" ? JSON.stringify(v) : String(v);
};
