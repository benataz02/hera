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

const isDateType = (t: string) => /date|time/i.test(t);
export const isTextType = (t: string) => /string|char|memo|guid|text/i.test(t);

export const EMPTY_SPEC: ListVariantDef = { select: [], filter: [], orderby: [], filterBar: [] };

/** A boolean filter has three states, not two: undefined = unfiltered. */
export const boolFilterState = (c?: FilterCond): boolean | undefined =>
  c ? c.value === true || c.value === "true" : undefined;

/** Click cycle for the filter bar's boolean checkbox: Any -> Yes -> No -> Any ("" clears). */
export const nextBoolFilter = (v: boolean | undefined): boolean | "" =>
  v === undefined ? true : v ? false : "";

// Rendered columns only — identity keys are merged separately via listSelect for the OData $select.
export const visibleColumns = (spec: ListVariantDef, columns: ListColumn[]): string[] =>
  spec.select.length ? spec.select : columns.map((c) => c.name);

/** Select for the list fetch / table. `null` until a view has been applied — EMPTY_SPEC
 *  otherwise falls back to every discovered column. */
export const listFetchSelect = (
  ready: boolean,
  spec: ListVariantDef,
  columns: ListColumn[],
): string[] | null => (ready ? visibleColumns(spec, columns) : null);

/** Dedupe preserving first-seen order. */
export const uniqueNames = (names: string[]): string[] => {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const n of names) {
    if (seen.has(n)) continue;
    seen.add(n);
    out.push(n);
  }
  return out;
};

/** The part of a saved view that IS the query, and nothing else. `widths`, `labels` and
 *  `filterBar` are presentation: no executor reads them, but they live in the same jsonb document,
 *  and that document is the oRPC infinite-query key — so without this projection a column resize or
 *  a header rename mints a new key and throws away every loaded page. `select` is sorted because
 *  reordering columns doesn't change what $select asks for either.
 *  Every list fetch input goes through here. */
export const listQuery = (spec: ListVariantDef): ListVariantDef => ({
  select: [...spec.select].sort(),
  filter: spec.filter,
  orderby: spec.orderby,
  filterBar: [],
  ...(spec.search ? { search: spec.search } : {}),
});

/** Fetch $select = schema keys ∪ visible columns (keys stay fetch-only unless also visible).
 *  Client sends visible columns as `select`; server applies this union for OData projection. */
export const listSelect = (keys: string[], visibleCols: string[]): string[] =>
  uniqueNames([...keys, ...visibleCols]);

// Table cells are strings. Dates render as the local date alone — B1's date columns come back as
// "2026-08-28T00:00:00Z" and the time half is never meaningful.
//
// The y/m/d are read off the string rather than through `new Date(v).toLocaleDateString()`: that
// parses "…T00:00:00Z" as UTC midnight, which is the *previous* day anywhere west of Greenwich.
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})/;
export const formatCell = (v: unknown, type = ""): string => {
  if (v == null) return "";
  if (isDateType(type)) {
    if (type === "Edm.Time" || type === "Edm.TimeOfDay") return String(v);
    const iso = ISO_DATE.exec(String(v));
    if (iso) return new Date(+iso[1]!, +iso[2]! - 1, +iso[3]!).toLocaleDateString();
    const d = new Date(v as string | number | Date);
    return Number.isNaN(d.getTime()) ? String(v) : d.toLocaleDateString();
  }
  return typeof v === "object" ? JSON.stringify(v) : String(v);
};
