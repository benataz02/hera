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
    /** extra columns exposed as `<param>_<col>` and shown in pickers; absent = all except valueCol */
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
    z.object({ name: z.string(), target: z.enum(["b1", "beas"]), path: z.string(), columns: z.array(z.string()) }),
  ),
  history: z
    .object({
      itemCodeParam: KeyZ.optional(),
      query: z
        .object({ target: z.enum(["b1", "beas"]), path: z.string(), columns: z.array(z.string()) })
        .optional(),
      mappings: z.array(HistoryMappingZ),
      display: z.array(z.string()),
    })
    .optional(),
  pricing: z.object({ priceExpr: z.string(), quoteItemCode: z.string().min(1) }),
  batchDefaults: z.array(z.number().int().positive()),
  extraction: z.object({ context: z.string().optional() }).optional(),
});
export type ModelDef = z.infer<typeof ModelDefZ>;

export type Option = { value: Val; label: string };
export type ResolvedTable = { columns: string[]; rows: Val[][] };
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

/** The source columns a ref exposes (display + derived values). */
export function refColumns(ref: LookupRef, all: string[] | undefined): string[] {
  if (ref.source === "manual") return [];
  if (ref.columns) return ref.columns;
  const { valueCol } = refKeyCols(ref, all);
  return (all ?? []).filter((c) => c !== valueCol);
}

/** Derived value key for a param's source column, e.g. material_density. */
export const derivedKey = (paramKey: string, col: string) => `${paramKey}_${col}`;
