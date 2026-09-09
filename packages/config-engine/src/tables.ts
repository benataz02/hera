import { evaluate } from "./dsl";
import {
  aggregateKey,
  refKeyCols,
  type ModelDef,
  type Option,
  type ResolvedLookups,
  type ResolvedTable,
  type TableColumn,
  type TableDef,
  type TableRows,
  type Val,
} from "./model";

/** A half-filled row still has to produce a number, or the footer totals would blank out while
 *  the salesperson types. Missing cells read as the type's zero. */
const zeroOf = (t: TableColumn["type"]): Val => (t === "number" ? 0 : t === "boolean" ? false : "");

const numOf = (v: Val | undefined): number => (typeof v === "number" ? v : 0);

/** Options for an `options` cell. Same `ResolvedLookups` the engine already holds: a manual ref
 *  carries its own list, a table/query ref reads the fetched rows — so no new server-side domain
 *  plumbing, only `referencedTables` has to name the table. */
export function columnOptions(col: TableColumn, lookups: ResolvedLookups): Option[] {
  if (col.cell.kind !== "options") return [];
  const ref = col.cell.ref;
  if (ref.source === "manual")
    return ref.options.map((o) => ({ value: o.value, label: o.label ?? String(o.value) }));
  const t = lookups.tables[ref.table];
  if (!t) return [];
  const { valueCol, labelCol } = refKeyCols(ref, t.columns);
  const vi = t.columns.indexOf(valueCol);
  if (vi < 0) return [];
  const li = labelCol ? t.columns.indexOf(labelCol) : -1;
  return t.rows.map((r) => ({ value: r[vi] ?? null, label: String((li >= 0 ? r[li] : r[vi]) ?? "") }));
}

/**
 * Stored cells as-is, formula cells evaluated against the model scope plus the row's own cells.
 * Row cells shadow model identifiers, which is what lets a column be named `width` next to a
 * parameter called `width`.
 *
 * ponytail: declaration order, not a fixpoint — check.ts rejects a formula that references a
 * later column of the same table, so the ordering is the author's to state. Fixpoint only if a
 * real model ever needs one.
 */
export function evalTableRows(
  def: TableDef,
  rows: Record<string, Val>[],
  scopeVars: Record<string, Val>,
  tables?: Record<string, ResolvedTable>,
): Record<string, Val>[] {
  return rows.map((row) => {
    const vars: Record<string, Val> = { ...scopeVars };
    const out: Record<string, Val> = {};
    for (const c of def.columns) {
      if (c.cell.kind === "formula") continue;
      const v = row[c.key] ?? zeroOf(c.type);
      out[c.key] = v;
      vars[c.key] = v;
    }
    for (const c of def.columns) {
      if (c.cell.kind !== "formula") continue;
      let v: Val;
      try {
        v = evaluate(c.cell.expr, { vars, tables });
      } catch {
        v = null; // undecidable while the row is incomplete, exactly like an unbound parameter
      }
      out[c.key] = v;
      vars[c.key] = v;
    }
    return out;
  });
}

/** `<table>_<col>` (Σ over rows, numeric columns only) and `<table>_count`, for every table the
 *  model declares. This is the whole interface between a table and the model's formulas. */
export function tableAggregates(
  model: ModelDef,
  rows: TableRows,
  scopeVars: Record<string, Val>,
  lookups: ResolvedLookups,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const def of model.tables ?? []) {
    const evaluated = evalTableRows(def, rows[def.key] ?? [], scopeVars, lookups.tables);
    out[aggregateKey(def.key, "count")] = evaluated.length;
    for (const c of def.columns) {
      if (c.type !== "number") continue;
      out[aggregateKey(def.key, c.key)] = evaluated.reduce((a, r) => a + numOf(r[c.key]), 0);
    }
  }
  return out;
}

/**
 * Split one configuration's total across the item rows by `basis × qty`.
 *
 * The joint cost of a merge run cannot be computed per item, only divided, so the configuration
 * total stays authoritative and the lines are derived from it. Largest-remainder to whole cents:
 * the cents rounding drops go to the biggest fractions, so `Σ shares === round(total, 2)`
 * exactly — otherwise the quotation's DocTotal would not match the stored `quotedValue`.
 */
export function splitShares(
  rows: Record<string, Val>[],
  qtyCol: string,
  basisCol: string,
  total: number,
): number[] {
  if (rows.length === 0) return [];
  let w = rows.map((r) => numOf(r[basisCol]) * numOf(r[qtyCol]));
  if (w.reduce((a, b) => a + b, 0) <= 0) w = w.map(() => 1); // nothing to weigh by -> equal split
  const sum = w.reduce((a, b) => a + b, 0);
  const cents = Math.round(total * 100);
  const exact = w.map((x) => (cents * x) / sum);
  const share = exact.map((e) => Math.floor(e));
  let rest = cents - share.reduce((a, b) => a + b, 0);
  const byRemainder = exact
    .map((e, i) => [e - Math.floor(e), i] as const)
    .sort((a, b) => b[0] - a[0]);
  for (const [, i] of byRemainder) {
    if (rest <= 0) break;
    share[i] = share[i]! + 1;
    rest--;
  }
  return share.map((c) => c / 100);
}
