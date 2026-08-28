import { andFilter, encodeBool, escapeLiteral, isYesNo, type B1Field, type B1EntitySchema, type QueryOptions } from "@hera/b1";
import type { FilterCond, ListVariantDef } from "@hera/db";

// Compile a saved list view (ListVariantDef) into a B1 read. The browser-side counterpart is
// listSpec.ts's applySpec, which does the same thing over an in-memory array — same spec, same
// result, one executed by B1 and one locally.
//
// Pure: no db, no transport. The router hands it a cached schema and gets QueryOptions back.

/** Fields a list can project and filter on: scalars only. A collection in $select drags every
 *  document line into a list page. */
export const scalarFields = (schema: B1EntitySchema): B1Field[] =>
  schema.fields.filter((f) => f.kind !== "collection");

const literal = (f: B1Field, value: string | number | boolean): string => {
  switch (f.kind) {
    case "number":
      if (typeof value === "boolean" || !Number.isFinite(Number(value)))
        throw new Error(`'${f.name}' needs a number, got '${value}'`);
      return String(Number(value));
    case "boolean": {
      const on = value === true || value === "true" || value === "tYES";
      // A BoYesNoEnum column rejects `eq true` — it wants the quoted member, as dashboard-snapshot.ts
      // already does with `Cancelled eq 'tNO'`.
      return isYesNo(f) ? `'${encodeBool(f, on)}'` : String(on);
    }
    // OData v4 date/time literals are unquoted. (dashboard-snapshot.ts quotes its DocDate
    // literals — that form is what was verified against the live b1s/v2 there, so it stays;
    // ponytail: if one of the two 400s in the field, make both match whichever wins.)
    case "date":
    case "time":
      return String(value);
    default:
      return `'${escapeLiteral(String(value))}'`;
  }
};

const condition = (cond: FilterCond, f: B1Field): string => {
  if (cond.op === "contains" || cond.op === "startswith")
    return `${cond.op}(${f.name},'${escapeLiteral(String(cond.value))}')`;
  return `${f.name} ${cond.op} ${literal(f, cond.value)}`;
};

/**
 * `spec` -> `QueryOptions`. Rules:
 *  - $select is the key fields plus the visible columns, so a row can always be opened.
 *  - a filter naming a field the entity does not have is an error: silently dropping it would
 *    show MORE rows than were asked for.
 *  - a *select* naming a missing field is not: a saved view outliving a UDF should still open.
 *  - free-text search becomes contains() over string fields only, which is all B1 accepts.
 */
export function compileList(
  schema: B1EntitySchema,
  spec: ListVariantDef,
  opts: { top: number; skip?: number; count?: boolean } = { top: 50 },
): QueryOptions {
  const fields = scalarFields(schema);
  const byName = new Map(fields.map((f) => [f.name, f]));

  const visible = spec.select.length ? spec.select : fields.map((f) => f.name);
  const select = [...new Set([...schema.keys, ...visible])].filter((n) => byName.has(n));

  let filter: string | undefined;
  for (const cond of spec.filter) {
    const f = byName.get(cond.field);
    if (!f) throw new Error(`Filter field '${cond.field}' is not on ${schema.name}`);
    filter = andFilter(filter, condition(cond, f));
  }

  const q = spec.search?.trim();
  if (q) {
    const ors = fields
      .filter((f) => f.kind === "string" && (!spec.select.length || select.includes(f.name)))
      .map((f) => `contains(${f.name},'${escapeLiteral(q)}')`);
    if (ors.length) filter = andFilter(filter, ors.join(" or "));
  }

  const ord = spec.orderby.find((o) => byName.has(o.field));
  return {
    select,
    ...(filter ? { filter } : {}),
    ...(ord ? { orderby: `${ord.field}${ord.dir === "desc" ? " desc" : ""}` } : {}),
    top: opts.top,
    ...(opts.skip ? { skip: opts.skip } : {}),
    ...(opts.count ? { count: true } : {}),
  };
}
