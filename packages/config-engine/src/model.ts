import { z } from "zod";

export type Val = number | string | boolean | null | string[];

export const ValZ = z.union([z.number(), z.string(), z.boolean(), z.null()]);
/** User-entry value: scalar Val, or string[] for multicombo params. */
export const EntriesZ = z.record(z.string(), z.union([ValZ, z.array(z.string())]));

export const LookupRefZ = z.discriminatedUnion("source", [
  z.object({
    source: z.literal("manual"),
    options: z.array(z.object({ value: ValZ, label: z.string().optional() })),
  }),
  z.object({
    source: z.literal("table"),
    table: z.string(),
    valueCol: z.string(),
    labelCol: z.string().optional(),
    /** extra columns shown in pickers; absent = all extra. Derived keys always use every extra column. */
    columns: z.array(z.string()).optional(),
  }),
  z.object({
    source: z.literal("query"),
    /** names a ModelDef.queryTables entry — the query itself is defined there */
    table: z.string(),
    /** convention: absent = 1st declared column (see refKeyCols) */
    valueCol: z.string().optional(),
    labelCol: z.string().optional(),
    columns: z.array(z.string()).optional(),
  }),
]);
export type LookupRef = z.infer<typeof LookupRefZ>;

const KeyZ = z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/, "must be a valid identifier");

/** A live read, as data rather than as a URL string. `$select` is derived from the source's
 *  `columns` and deliberately not stored — one field fewer, and the two can never disagree.
 *  URL construction lives in packages/b1's query.ts and nowhere else. */
export const ODataQueryZ = z.object({
  entitySet: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "must be an entity set name"),
  filter: z.string().optional(),
  orderby: z.string().optional(),
  /** rows per read — the value help's page size, not a hard total. */
  top: z.number().int().positive().optional(),
});
export type ODataQuery = z.infer<typeof ODataQueryZ>;

/** One named live source: where to read, what to read, and the column set it yields. */
export const QuerySourceZ = z.object({
  target: z.enum(["b1", "beas"]),
  query: ODataQueryZ,
  columns: z.array(z.string()),
});
export type QuerySource = z.infer<typeof QuerySourceZ>;

export const ParamZ = z.object({
  key: KeyZ,
  label: z.string(),
  type: z.enum(["string", "number", "boolean"]),
  ui: z.enum(["input", "select", "radio", "checkbox", "multicombo", "step"]),
  domain: z
    .union([
      z.object({ kind: z.literal("options"), ref: LookupRefZ }),
      z.object({ kind: z.literal("range"), min: z.number(), max: z.number(), step: z.number().optional() }),
    ])
    .optional(),
  defaultExpr: z.string().optional(),
  visibleWhen: z.string().optional(),
  requiredWhen: z.string().optional(),
  /** informational per-unit price shown at the field's top-right; never enters the calculated price */
  priceExpr: z.string().optional(),
  readonly: z.boolean().optional(),
  excludeFromDomains: z.boolean().optional(),
  unit: z.string().optional(),
  help: z.string().optional(),
  extractionHint: z.string().optional(),
});
export type Param = z.infer<typeof ParamZ>;

export const ConstraintZ = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("expr"),
    when: z.string().optional(),
    assert: z.string(),
    message: z.string(),
  }),
  z.object({
    kind: z.literal("table"),
    params: z.array(KeyZ).min(2),
    rows: z.array(z.array(ValZ)),
    mode: z.enum(["allow", "forbid"]),
  }),
]);
export type Constraint = z.infer<typeof ConstraintZ>;

export const BomLineZ = z.object({
  id: z.string(),
  itemCode: z.string(), // expr
  desc: z.string().optional(), // expr
  condition: z.string().optional(), // expr -> boolean
  qty: z.string(), // expr, per finished unit; batch qty available as `qty`
  price: z.string(), // expr, cost per item unit
  scrapPct: z.number().default(0),
});

export const OperationZ = z.object({
  id: z.string(),
  resource: z.string(),
  condition: z.string().optional(),
  setupMin: z.string(), // expr, minutes per batch
  runMinPerUnit: z.string(), // expr, minutes per unit
  ratePerHour: z.string(), // expr, cost per hour
});

export const HistoryMappingZ = z.object({
  param: KeyZ,
  column: z.string().min(1),
  match: z.enum(["exact", "closeness", "contains"]),
  weight: z.number().positive().default(1),
});
export type HistoryMapping = z.infer<typeof HistoryMappingZ>;

export const ModelDefZ = z.object({
  name: z.string(),
  parameters: z.array(ParamZ),
  structure: z.object({
    sections: z.array(
      z.object({
        key: KeyZ,
        title: z.string(),
        groups: z.array(z.object({ key: KeyZ, title: z.string(), params: z.array(KeyZ) })),
      }),
    ),
  }),
  computed: z.array(z.object({ key: KeyZ, expr: z.string() })),
  constraints: z.array(ConstraintZ),
  bom: z.array(BomLineZ),
  routing: z.array(OperationZ),
  queryTables: z.array(
    QuerySourceZ.extend({
      name: z.string(),
      /** dialog headers; missing/blank → show the key. Engine ignores. */
      labels: z.record(z.string(), z.string()).optional(),
      /** keys omitted from the value-help dialog. Still fetched, still derived. */
      hidden: z.array(z.string()).optional(),
    }),
  ),
  history: z
    .object({
      itemCodeParam: KeyZ.optional(),
      query: QuerySourceZ.optional(),
      mappings: z.array(HistoryMappingZ),
      display: z.array(z.string()),
    })
    .optional(),
  // currency is optional, not .default("EUR"): a zod default lands in the inferred type as required
  // and would force the key into every ModelDef literal. One `?? "EUR"` in money() covers it.
  pricing: z.object({ priceExpr: z.string(), quoteItemCode: z.string().min(1), currency: z.string().optional() }),
  batchDefaults: z.array(z.number().int().positive()),
  extraction: z.object({ context: z.string().optional() }).optional(),
});
export type ModelDef = z.infer<typeof ModelDefZ>;

export type Option = { value: Val; label: string };
export type ResolvedTable = { columns: string[]; rows: Val[][]; /** $skip for the next page; absent = last page */ nextSkip?: number };
/** Everything external, already fetched: engine never sees source kinds. */
export type ResolvedLookups = {
  domains: Record<string, Option[]>;
  tables: Record<string, ResolvedTable>;
};
/** User-entered values only; absent key = open parameter. */
export type Entries = Record<string, Val>;

/** Effective key/label columns; query refs default by convention: 1st column = key, 2nd = label. */
export function refKeyCols(ref: LookupRef, all: string[] | undefined): { valueCol: string; labelCol?: string } {
  if (ref.source === "manual") return { valueCol: "" };
  if (ref.source === "query")
    return { valueCol: ref.valueCol || (all?.[0] ?? ""), labelCol: ref.labelCol ?? all?.[1] };
  return { valueCol: ref.valueCol, labelCol: ref.labelCol };
}

/** Extra source columns bound as `<param>_<col>`; ignores `ref.columns`. */
export function derivedColumns(ref: LookupRef, all: string[] | undefined): string[] {
  if (ref.source === "manual") return [];
  const { valueCol } = refKeyCols(ref, all);
  return (all ?? []).filter((c) => c !== valueCol);
}

/** Extra columns shown in pickers; `ref.columns` is the visibility subset. */
export function displayColumns(ref: LookupRef, all: string[] | undefined): string[] {
  if (ref.source === "manual") return [];
  if (ref.columns) return ref.columns;
  return derivedColumns(ref, all);
}

/** Derived value key for a param's source column, e.g. material_density. */
export const derivedKey = (paramKey: string, col: string) => `${paramKey}_${col}`;
