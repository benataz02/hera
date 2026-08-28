import { XMLParser } from "fast-xml-parser";

// Port of b1-mcp-server's b1-metadata-parser.ts (MIT). Two deliberate changes:
//
// 1. jsdom -> fast-xml-parser. A 29 MB DOM emulator to read 40 KB of XML earns nothing.
// 2. NavigationProperty + ReferentialConstraint are parsed. SAP's parser reads only `Property`
//    elements, so it cannot express `CardCode -> BusinessPartners` — the entity relations the
//    document UI is built on, and the only place we add what SAP omitted.
//
// The output shape is HERA's, not SAP's: plain JSON (the EDM model in the sample is built out of
// Maps, which neither cache in jsonb nor cross the wire) carrying exactly what a form needs to
// pick a control and validate a value.

export type B1FieldKind =
  | "string" | "number" | "boolean" | "date" | "time" | "enum" | "collection";

export type B1Field = {
  name: string;
  kind: B1FieldKind;
  /** The raw EDM type, kept so a renderer can be more specific than `kind` if it needs to be. */
  edmType: string;
  label?: string;
  maxLength?: number;
  isUDF?: boolean;
  /** enum: the ValidValue codes B1 accepts, in declaration order. */
  options?: { value: string; label: string }[];
  /** collection: the complex type's own fields. */
  fields?: B1Field[];
  /** from a NavigationProperty's ReferentialConstraint — render as a value help. */
  lookup?: { entitySet: string; keyField: string };
};

export type B1EntityClass = "standard" | "udt" | "udo";

export type B1EntityRef = {
  name: string;
  entityType: string;
  table: string;
  label: string;
  entityClass: B1EntityClass;
};

export type B1EntitySchema = B1EntityRef & {
  keys: string[];
  fields: B1Field[];
};

/** B1 exposes these but they are binary/session plumbing, not data a browser should list. */
const UNSUPPORTED = new Set(["Attachments2", "B1Sessions", "ItemImages", "EmployeeImages", "Pictures"]);

const YES_NO_ENUM = "BoYesNoEnum";

const KIND: Record<string, B1FieldKind> = {
  "Edm.String": "string", "Edm.Guid": "string",
  "Edm.Byte": "number", "Edm.Int16": "number", "Edm.Int32": "number", "Edm.Int64": "number",
  "Edm.Double": "number", "Edm.Decimal": "number", "Edm.Single": "number",
  "Edm.Boolean": "boolean",
  // Every date-ish EDM type lands on "date". B1's DateTimeOffset columns (DocDate, DocDueDate…)
  // are floating dates whose time half is always 00:00 — a DateTimePicker on those asks the user
  // for a time B1 will not keep.
  "Edm.Date": "date", "Edm.DateTime": "date", "Edm.DateTimeOffset": "date",
  "Edm.Time": "time", "Edm.TimeOfDay": "time",
};

// Attributes come through prefixed with "@"; single children are objects, repeated ones arrays,
// so every access goes through `many()`.
const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@",
  removeNSPrefix: true,
  parseAttributeValue: false,
  trimValues: true,
});

type Node = Record<string, unknown>;
const many = (v: unknown): Node[] => (Array.isArray(v) ? (v as Node[]) : v ? [v as Node] : []);
const attr = (n: Node | undefined, name: string): string | undefined => {
  const v = n?.[`@${name}`];
  return typeof v === "string" ? v : typeof v === "number" ? String(v) : undefined;
};

/** `<Annotation Term="Common.Label" String="…"/>` directly under this node. */
const annotation = (n: Node, term: string): string | undefined =>
  many(n.Annotation).find((a) => attr(a, "Term") === term)?.["@String"] as string | undefined;

const schemaOf = (xml: string): Node => {
  const doc = parser.parse(xml) as Node;
  const edmx = (doc.Edmx ?? doc) as Node;
  const services = (edmx.DataServices ?? edmx) as Node;
  return (many(services.Schema)[0] ?? {}) as Node;
};

const shortName = (t: string): string => t.split(".").pop() ?? t;

const classOf = (name: string, table: string): B1EntityClass =>
  table.startsWith("@") ? (name.startsWith("U_") ? "udt" : "udo") : "standard";

function entitySetNodes(schema: Node): Node[] {
  return many(schema.EntityContainer).flatMap((c) => many(c.EntitySet));
}

function refOf(node: Node): B1EntityRef | null {
  const name = attr(node, "Name");
  const entityType = attr(node, "EntityType");
  if (!name || !entityType || UNSUPPORTED.has(name)) return null;
  const table = annotation(node, "SAPB1.TableName") || name;
  return { name, entityType, table, label: annotation(node, "Common.Label") || name, entityClass: classOf(name, table) };
}

/** `$metadata?scope=entityset&annotation=labelWithTable` — the cheap listing. */
export function parseEntityList(xml: string): B1EntityRef[] {
  return entitySetNodes(schemaOf(xml)).map(refOf).filter((e): e is B1EntityRef => !!e);
}

type EnumMap = Record<string, { value: string; label: string }[]>;

function parseEnums(schema: Node): EnumMap {
  const out: EnumMap = {};
  for (const e of many(schema.EnumType)) {
    const name = attr(e, "Name");
    if (!name) continue;
    out[name] = many(e.Member)
      .map((m) => ({ value: annotation(m, "SAPB1.ValidValue") ?? "", label: attr(m, "Name") ?? "" }))
      .filter((o) => o.value && o.label);
  }
  return out;
}

function field(
  node: Node,
  ctx: { enums: EnumMap; complex: Record<string, Node>; depth: number },
): B1Field | null {
  const name = attr(node, "Name");
  let type = attr(node, "Type");
  if (!name || !type) return null;

  const isCollection = type.startsWith("Collection(");
  if (isCollection) type = type.slice("Collection(".length, -1);

  const label = annotation(node, "Common.Label");
  const base = { name, edmType: type, ...(label ? { label } : {}), ...(name.startsWith("U_") ? { isUDF: true } : {}) };

  const primitive = KIND[type];
  if (primitive) {
    const maxLength = attr(node, "MaxLength");
    return { ...base, kind: primitive, ...(maxLength && /^\d+$/.test(maxLength) ? { maxLength: Number(maxLength) } : {}) };
  }

  const local = shortName(type);
  // BoYesNoEnum is a boolean wearing a costume: two members, tYES/tNO. It carries no information
  // a checkbox can't, so it never becomes a dropdown. The wire values stay tYES/tNO — see isYesNo.
  if (local === YES_NO_ENUM) return { ...base, kind: "boolean" as const };
  const options = ctx.enums[local];
  if (options) return { ...base, kind: "enum", options };

  const complex = ctx.complex[local];
  if (complex) {
    // One level is what a document needs (header + its lines). Deeper nesting exists in B1 but no
    // renderer consumes it, and following it blindly is how you recurse into a cycle.
    // ponytail: depth 1; raise it when a screen actually needs a grandchild collection.
    const fields = ctx.depth > 0
      ? []
      : many(complex.Property).map((p) => field(p, { ...ctx, depth: ctx.depth + 1 })).filter((f): f is B1Field => !!f);
    return { ...base, kind: "collection", fields };
  }

  return null; // unresolvable type — omitted rather than rendered as a mystery box
}

/**
 * One entity set's schema from `$metadata?scope=entityset&entityset=X&dependency=true`.
 * `entitySets` maps a fully-qualified EntityType to its set name so ReferentialConstraints can
 * name a target the router can actually read; pass the cached entity list.
 */
export function parseEntitySchema(
  xml: string,
  entitySetName: string,
  entitySets: B1EntityRef[] = [],
): B1EntitySchema {
  const schema = schemaOf(xml);
  const setNode = entitySetNodes(schema).find((n) => attr(n, "Name") === entitySetName);
  if (!setNode) throw new Error(`EntitySet '${entitySetName}' not found in metadata`);
  const ref = refOf(setNode);
  if (!ref) throw new Error(`EntitySet '${entitySetName}' is not readable`);

  const typeName = shortName(ref.entityType);
  const typeNode = many(schema.EntityType).find((n) => attr(n, "Name") === typeName);
  if (!typeNode) throw new Error(`EntityType '${typeName}' not found in metadata`);

  const complex: Record<string, Node> = {};
  for (const c of many(schema.ComplexType)) {
    const n = attr(c, "Name");
    if (n) complex[n] = c;
  }
  const ctx = { enums: parseEnums(schema), complex, depth: 0 };

  const fields = many(typeNode.Property).map((p) => field(p, ctx)).filter((f): f is B1Field => !!f);
  const byName = new Map(fields.map((f) => [f.name, f]));

  // The addition over SAP's parser: a NavigationProperty's ReferentialConstraint says which of
  // this entity's own fields is a foreign key, and into what. That is the value help.
  const setByType = new Map([...entitySets, ref].map((e) => [e.entityType, e.name]));
  for (const nav of many(typeNode.NavigationProperty)) {
    let navType = attr(nav, "Type") ?? "";
    if (navType.startsWith("Collection(")) navType = navType.slice("Collection(".length, -1);
    const target = setByType.get(navType);
    if (!target) continue;
    for (const rc of many(nav.ReferentialConstraint)) {
      const property = attr(rc, "Property");
      const referenced = attr(rc, "ReferencedProperty");
      const f = property ? byName.get(property) : undefined;
      if (f && referenced && !f.lookup) f.lookup = { entitySet: target, keyField: referenced };
    }
  }

  const keys = many(many(typeNode.Key)[0]?.PropertyRef)
    .map((k) => attr(k, "Name"))
    .filter((k): k is string => !!k);

  return { ...ref, keys, fields };
}

/** A boolean field B1 wants as the string 'tYES'/'tNO' rather than true/false. Keyed on the EDM
 *  type, not the member labels: a tenant whose $metadata omits the ValidValue annotations still
 *  gets a checkbox instead of an empty dropdown. */
export const isYesNo = (f: Pick<B1Field, "edmType">): boolean => shortName(f.edmType) === YES_NO_ENUM;

/** The value to send B1 for a boolean field: 'tYES'/'tNO' for BoYesNoEnum, true/false otherwise. */
export const encodeBool = (f: Pick<B1Field, "edmType">, on: boolean): string | boolean =>
  isYesNo(f) ? (on ? "tYES" : "tNO") : on;

/** B1 sends 'tYES'/'Y'/true depending on the field; read them all as one boolean. */
export const decodeBool = (v: unknown): boolean => v === true || v === "tYES" || v === "Y";
