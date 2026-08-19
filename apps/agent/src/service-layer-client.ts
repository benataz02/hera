// Real SAP B1 Service Layer client. Lives on-prem with the agent; B1 creds never
// leave the customer site. ponytail: login with single-flight re-auth, the quote-backbone
// BusinessPartner GET/POST, plus generic metadata/list/get/create/update for autodiscovered
// entities. No $batch yet — add it when bulk writes matter.
import { XMLParser } from "fast-xml-parser";

export type EnumOption = { value: string; text: string; numericValue?: number };
export type EntityProperty = {
  name: string;
  type: string;
  nullable: boolean;
  options?: EnumOption[];
  lookup?: { entitySet: string; valueField: string; labelField?: string };
};
export type CollectionSchema = {
  name: string;
  typeName: string;
  many: boolean;
  properties: EntityProperty[];
};
export type EntitySchema = {
  name: string; // EntitySet name (what you query, e.g. "BusinessPartners")
  typeName: string;
  keys: string[];
  properties: EntityProperty[];
  collections: CollectionSchema[];
};
/** @deprecated use EntityProperty */
export type EdmProperty = EntityProperty;

// Find a child by local XML name, ignoring namespace prefix (edmx:Edmx, m:Something, ...).
function pick(obj: Record<string, unknown> | undefined, local: string): unknown {
  if (!obj) return undefined;
  for (const k of Object.keys(obj)) if (k === local || k.endsWith(":" + local)) return obj[k];
  return undefined;
}
const asArray = <T>(v: T | T[] | undefined): T[] => (v == null ? [] : Array.isArray(v) ? v : [v]);

function localName(qualified: string | undefined): string {
  return (qualified ?? "").split(".").pop() ?? "";
}

function collectionInner(type: string): string | null {
  const m = /^Collection\((.+)\)$/.exec(type);
  return m ? m[1]! : null;
}

/**
 * B1 enum members are Hungarian-prefixed: `tYES`, `psNo`, `cCustomer`, `bost_Open`,
 * `dDocument_Items`. Drop the leading lowercase run (and its underscore) for display text; the
 * exact member Name stays in `value` for round trips. All-lowercase members keep their name.
 * ponytail: prefix strip only — no camel-case splitting until a label actually reads badly.
 */
export function enumText(name: string): string {
  const stripped = name.replace(/^[a-z]+_?/, "").replace(/_/g, " ");
  return stripped || name;
}

type RawProp = { name: string; type: string; nullable: boolean };
type NavConstraint = { property: string; referencedProperty: string; targetType: string };

/**
 * Description column for a value help, from the target type's own properties. B1 names the pair
 * conventionally (CardCode/CardName, ItemCode/ItemName, Code/Name), so the key's stem drives the
 * guess before falling back to any *Name/*Description string field.
 * ponytail: naming convention only — add a per-entity override if a target breaks the pattern.
 */
export function pickLabelField(props: RawProp[], valueField: string): string | undefined {
  const strings = props.filter((p) => /string/i.test(p.type) && p.name !== valueField);
  const names = new Set(strings.map((p) => p.name));
  const stem = valueField.replace(/(Code|Entry|Number|Num|ID|Key)$/, "");
  for (const c of [`${stem}Name`, `${stem}Description`, "Name", "Description"]) {
    if (names.has(c)) return c;
  }
  return strings.find((p) => /(Name|Description)$/.test(p.name))?.name;
}

// Parse an OData $metadata (EDMX) document into per-EntitySet schemas. Handles both the v3
// (b1s/v1) and v4 (b1s/v2) shapes. One-level complex collections, enum members, and validated
// lookup constraints; reverse entity-set navigations are excluded from owned collections.
export function parseEdmx(xml: string): EntitySchema[] {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
    isArray: (name) =>
      [
        "Schema",
        "EntityType",
        "ComplexType",
        "EnumType",
        "Member",
        "EntitySet",
        "EntityContainer",
        "Property",
        "PropertyRef",
        "NavigationProperty",
        "ReferentialConstraint",
      ].includes(name),
  });
  const doc = parser.parse(xml) as Record<string, unknown>;
  const dataServices = pick(pick(doc, "Edmx") as Record<string, unknown>, "DataServices") as Record<
    string,
    unknown
  >;
  const schemas = asArray(pick(dataServices, "Schema") as unknown) as Record<string, unknown>[];

  // 1. Enum local name -> members (Name as value; numeric Value only in numericValue).
  const enums = new Map<string, EnumOption[]>();
  for (const schema of schemas) {
    for (const et of asArray(pick(schema, "EnumType") as unknown) as Record<string, unknown>[]) {
      const name = et["@_Name"] as string;
      const members = asArray(pick(et, "Member") as unknown).map((m) => {
        const mr = m as Record<string, string>;
        const memberName = mr["@_Name"]!;
        const raw = mr["@_Value"];
        const numericValue = raw != null && raw !== "" && !Number.isNaN(Number(raw)) ? Number(raw) : undefined;
        return {
          value: memberName,
          text: enumText(memberName),
          ...(numericValue !== undefined ? { numericValue } : {}),
        };
      });
      enums.set(name, members);
    }
  }

  // 2. complex/entity type local name -> raw properties.
  const typeProps = new Map<string, RawProp[]>();
  const complexNames = new Set<string>();
  const entityTypeNames = new Set<string>();

  for (const schema of schemas) {
    for (const ct of asArray(pick(schema, "ComplexType") as unknown) as Record<string, unknown>[]) {
      const name = ct["@_Name"] as string;
      complexNames.add(name);
      typeProps.set(
        name,
        asArray(pick(ct, "Property") as unknown).map((p) => {
          const pr = p as Record<string, string>;
          return {
            name: pr["@_Name"]!,
            type: pr["@_Type"] ?? "Edm.String",
            nullable: pr["@_Nullable"] !== "false",
          };
        }),
      );
    }
    for (const et of asArray(pick(schema, "EntityType") as unknown) as Record<string, unknown>[]) {
      const name = et["@_Name"] as string;
      entityTypeNames.add(name);
      typeProps.set(
        name,
        asArray(pick(et, "Property") as unknown).map((p) => {
          const pr = p as Record<string, string>;
          return {
            name: pr["@_Name"]!,
            type: pr["@_Type"] ?? "Edm.String",
            nullable: pr["@_Nullable"] !== "false",
          };
        }),
      );
    }
  }

  // 3. entity type -> keys + navigation referential constraints.
  const typeKeys = new Map<string, string[]>();
  const typeNavs = new Map<string, NavConstraint[]>();
  for (const schema of schemas) {
    for (const et of asArray(pick(schema, "EntityType") as unknown) as Record<string, unknown>[]) {
      const name = et["@_Name"] as string;
      const keys = asArray(pick(pick(et, "Key") as Record<string, unknown>, "PropertyRef") as unknown).map(
        (r) => (r as Record<string, string>)["@_Name"]!,
      );
      typeKeys.set(name, keys);
      const navs: NavConstraint[] = [];
      for (const nav of asArray(pick(et, "NavigationProperty") as unknown) as Record<string, unknown>[]) {
        const targetType = localName(collectionInner((nav["@_Type"] as string) ?? "") ?? (nav["@_Type"] as string));
        for (const rc of asArray(pick(nav, "ReferentialConstraint") as unknown) as Record<string, string>[]) {
          if (rc["@_Property"] && rc["@_ReferencedProperty"]) {
            navs.push({
              property: rc["@_Property"],
              referencedProperty: rc["@_ReferencedProperty"],
              targetType,
            });
          }
        }
      }
      typeNavs.set(name, navs);
    }
  }

  // 4. entity type local name -> entity-set name(s).
  const typeToSets = new Map<string, string[]>();
  for (const schema of schemas) {
    for (const container of asArray(pick(schema, "EntityContainer") as unknown) as Record<string, unknown>[]) {
      for (const set of asArray(pick(container, "EntitySet") as unknown) as Record<string, string>[]) {
        const typeName = localName(set["@_EntityType"]);
        const list = typeToSets.get(typeName) ?? [];
        list.push(set["@_Name"]!);
        typeToSets.set(typeName, list);
      }
    }
  }

  const addressableTypes = new Set(typeToSets.keys());

  /** Resolve one referential constraint to a lookup, or null when the target isn't a single set. */
  function navLookup(nav: NavConstraint): EntityProperty["lookup"] | null {
    const sets = typeToSets.get(nav.targetType) ?? [];
    if (sets.length !== 1) return null;
    const labelField = pickLabelField(typeProps.get(nav.targetType) ?? [], nav.referencedProperty);
    return {
      entitySet: sets[0]!,
      valueField: nav.referencedProperty,
      ...(labelField ? { labelField } : {}),
    };
  }

  // Field name -> lookup, pooled across every EntityType in the document. ComplexTypes
  // (DocumentLines and friends) declare no NavigationProperty, so a same-named constraint on an
  // addressable type is the only metadata evidence for their FK fields — e.g. ItemCode carries
  // ItemCode->Items on SpecialPrices. A name whose constraints disagree on the target is dropped
  // (null) rather than guessed. Used ONLY for complex children; entity types keep their own
  // precise per-type constraints so this can never invent a header lookup B1 doesn't declare.
  const pooledLookups = new Map<string, EntityProperty["lookup"] | null>();
  for (const navs of typeNavs.values()) {
    for (const nav of navs) {
      const candidate = navLookup(nav);
      if (!candidate) continue;
      if (!pooledLookups.has(nav.property)) {
        pooledLookups.set(nav.property, candidate);
        continue;
      }
      const seen = pooledLookups.get(nav.property);
      if (!seen) continue; // already ambiguous
      if (seen.entitySet !== candidate.entitySet || seen.valueField !== candidate.valueField) {
        pooledLookups.set(nav.property, null);
      }
    }
  }

  /** Lookups for a ComplexType's children, by pooled field-name agreement. Scalars only. */
  function pooledFor(raw: RawProp[]): Map<string, EntityProperty["lookup"]> {
    const out = new Map<string, EntityProperty["lookup"]>();
    for (const p of raw) {
      const local = localName(collectionInner(p.type) ?? p.type);
      if (complexNames.has(local) || entityTypeNames.has(local) || enums.has(local)) continue;
      const hit = pooledLookups.get(p.name);
      if (hit) out.set(p.name, hit);
    }
    return out;
  }

  function resolveProps(raw: RawProp[], lookups: Map<string, EntityProperty["lookup"]>): EntityProperty[] {
    return raw.map((p) => {
      const local = localName(p.type);
      const options = enums.get(local);
      const lookup = lookups.get(p.name);
      return {
        name: p.name,
        type: p.type,
        nullable: p.nullable,
        ...(options ? { options } : {}),
        ...(lookup ? { lookup } : {}),
      };
    });
  }

  function splitOwned(
    raw: RawProp[],
    lookups: Map<string, EntityProperty["lookup"]>,
  ): { properties: EntityProperty[]; collections: CollectionSchema[] } {
    const properties: EntityProperty[] = [];
    const collections: CollectionSchema[] = [];
    for (const p of raw) {
      const innerQualified = collectionInner(p.type);
      const many = innerQualified != null;
      const targetQualified = innerQualified ?? p.type;
      const targetLocal = localName(targetQualified);

      // Owned collection/complex section: ComplexType only. Entity types with an EntitySet are
      // reverse/addressable navigations (or would be) — never owned sections.
      if (complexNames.has(targetLocal) && !addressableTypes.has(targetLocal)) {
        const childRaw = typeProps.get(targetLocal) ?? [];
        collections.push({
          name: p.name,
          typeName: targetLocal,
          many: many || false,
          properties: resolveProps(childRaw, pooledFor(childRaw)),
        });
        continue;
      }
      if (many && addressableTypes.has(targetLocal)) continue; // reverse entity-set collection prop
      if (!many && entityTypeNames.has(targetLocal) && addressableTypes.has(targetLocal)) continue;

      properties.push(...resolveProps([p], lookups));
    }
    return { properties, collections };
  }

  // 5. entity sets -> resolved EntitySchema.
  const out: EntitySchema[] = [];
  for (const schema of schemas) {
    for (const container of asArray(pick(schema, "EntityContainer") as unknown) as Record<string, unknown>[]) {
      for (const set of asArray(pick(container, "EntitySet") as unknown) as Record<string, string>[]) {
        const typeName = localName(set["@_EntityType"]);
        const raw = typeProps.get(typeName);
        if (!raw) continue;

        // Entity types use their OWN constraints only — never the pooled map.
        const lookups = new Map<string, EntityProperty["lookup"]>();
        for (const nav of typeNavs.get(typeName) ?? []) {
          const lookup = navLookup(nav);
          if (lookup) lookups.set(nav.property, lookup);
        }

        const { properties, collections } = splitOwned(raw, lookups);
        out.push({
          name: set["@_Name"]!,
          typeName,
          keys: typeKeys.get(typeName) ?? [],
          properties,
          collections,
        });
      }
    }
  }
  return out;
}

// A saved view IS this OData call. The structured spec arrives from the cloud (server-validated
// against the entity schema); here we compile + escape it. `type` is the Edm type of the field
// (attached server-side) so values are encoded right: numbers/bools/dates bare, everything else
// a quoted string.
export type FilterOp = "eq" | "ne" | "contains" | "startswith" | "gt" | "ge" | "lt" | "le";
export type FilterClause = { field: string; op: FilterOp; value: string | number | boolean; type?: string };
export interface ListQuery {
  top: number;
  skip: number;
  q?: string;
  fields?: string[];
  select?: string[];
  filter?: FilterClause[];
  orderby?: { field: string; dir: "asc" | "desc" }[];
}

const IDENT = /^[A-Za-z0-9_]+$/;

// OData literal for a comparison value. Quote strings (with '->'' escaping); leave numbers, booleans
// and datetimes bare — B1 v2 OData datetime literals are unquoted ISO.
function odataLiteral(value: string | number | boolean, type?: string): string {
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return String(value);
  if (type && /bool/i.test(type)) return value === "true" ? "true" : "false";
  if (type && /(int|double|decimal|single|byte)/i.test(type)) return String(Number(value));
  if (type && /(date|time)/i.test(type)) return String(value);
  return `'${String(value).replace(/'/g, "''")}'`;
}

function clauseOf(c: FilterClause): string | null {
  if (!IDENT.test(c.field)) return null; // defense-in-depth; server already validated against schema
  if (c.op === "contains" || c.op === "startswith") {
    return `${c.op}(${c.field},'${String(c.value).replace(/'/g, "''")}')`;
  }
  if (["eq", "ne", "gt", "ge", "lt", "le"].includes(c.op)) {
    return `${c.field} ${c.op} ${odataLiteral(c.value, c.type)}`;
  }
  return null;
}

// Build the OData v4 query path for a paged, filtered, projected, sorted entity list. Pure (no I/O)
// so it has a network-free self-check in scripts/e2e.ts --unit.
export function buildListPath(entity: string, opts: ListQuery): string {
  const params = [`$top=${opts.top}`, `$skip=${opts.skip}`, "$count=true"];

  // $filter = the global-search OR-group AND'd with the per-field conditions.
  let qOr = "";
  if (opts.q && opts.fields?.length) {
    const term = opts.q.replace(/'/g, "''");
    const ors = opts.fields.filter((f) => IDENT.test(f)).map((f) => `contains(${f},'${term}')`);
    if (ors.length) qOr = ors.join(" or ");
  }
  const conds = (opts.filter ?? []).map(clauseOf).filter((c): c is string => c != null);
  let filterStr = "";
  if (qOr && conds.length) filterStr = [`(${qOr})`, ...conds].join(" and ");
  else if (qOr) filterStr = qOr;
  else if (conds.length) filterStr = conds.join(" and ");
  if (filterStr) params.push(`$filter=${encodeURIComponent(filterStr)}`);

  const select = (opts.select ?? []).filter((f) => IDENT.test(f));
  if (select.length) params.push(`$select=${select.join(",")}`);

  const orderby = (opts.orderby ?? [])
    .filter((o) => IDENT.test(o.field))
    .map((o) => `${o.field} ${o.dir === "desc" ? "desc" : "asc"}`);
  if (orderby.length) params.push(`$orderby=${encodeURIComponent(orderby.join(","))}`);

  return `/${entity}?${params.join("&")}`;
}

/** Server-compiled object projection. Agent never invents select/join keys. */
export type ObjectFetchRequest = {
  entity: string;
  key: string;
  keyQuoted: boolean;
  select: string[];
  collections: Array<{
    name: string;
    select: string[];
    parentKey: string;
    childParentKey: string;
    rowKey: string;
  }>;
  fullRecordFallback: boolean;
};

function assertIdent(name: string, label = "identifier"): void {
  if (!IDENT.test(name)) throw new SlError(400, "BAD_IDENT", `Invalid ${label} '${name}'`);
}

/** OData key literal: quoted strings escape `'`; numerics stay bare. */
export function odataKeyLiteral(key: string, quoted: boolean): string {
  if (!quoted) return key;
  return `'${String(key).replace(/'/g, "''")}'`;
}

export function buildObjectHeaderPath(
  entity: string,
  key: string,
  keyQuoted: boolean,
  select: string[],
): string {
  assertIdent(entity, "entity");
  for (const f of select) assertIdent(f, "field");
  const sel = select.length ? `?$select=${select.join(",")}` : "";
  return `/${entity}(${odataKeyLiteral(key, keyQuoted)})${sel}`;
}

export function buildCrossjoinPath(opts: {
  entity: string;
  key: string;
  keyQuoted: boolean;
  collection: ObjectFetchRequest["collections"][number];
}): string {
  const { entity, key, keyQuoted, collection } = opts;
  assertIdent(entity, "entity");
  assertIdent(collection.name, "collection");
  assertIdent(collection.parentKey, "field");
  assertIdent(collection.childParentKey, "field");
  assertIdent(collection.rowKey, "field");
  for (const f of collection.select) assertIdent(f, "field");

  const parentAlias = entity;
  const childAlias = `${entity}/${collection.name}`;
  const expand =
    `${parentAlias}($select=${collection.parentKey}),` +
    `${childAlias}($select=${collection.select.join(",")})`;
  const keyLit = odataKeyLiteral(key, keyQuoted);
  const filter =
    `${parentAlias}/${collection.parentKey} eq ${childAlias}/${collection.childParentKey}` +
    ` and ${parentAlias}/${collection.parentKey} eq ${keyLit}`;
  return (
    `/$crossjoin(${entity},${childAlias})` +
    `?$expand=${expand}` +
    `&$filter=${encodeURIComponent(filter)}`
  );
}

/** Flatten OData crossjoin value rows into collection row objects. */
export function flattenCrossjoinRows(
  rows: Record<string, unknown>[],
  entity: string,
  collection: string,
): Record<string, unknown>[] {
  const childKey = `${entity}/${collection}`;
  return rows.map((row) => {
    const child = row[childKey];
    return child && typeof child === "object" && !Array.isArray(child)
      ? { ...(child as Record<string, unknown>) }
      : {};
  });
}

/** When fallback is on, keep only the compiled header/collection fields from a full GET. */
export function projectFullRecord(
  full: Record<string, unknown>,
  request: ObjectFetchRequest,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of request.select) {
    if (f in full) out[f] = full[f];
  }
  for (const col of request.collections) {
    const raw = full[col.name];
    if (!Array.isArray(raw)) {
      out[col.name] = [];
      continue;
    }
    out[col.name] = raw.map((row) => {
      if (!row || typeof row !== "object") return {};
      const r = row as Record<string, unknown>;
      const projected: Record<string, unknown> = {};
      for (const f of col.select) {
        if (f in r) projected[f] = r[f];
      }
      return projected;
    });
  }
  return out;
}

export type LookupListOpts = {
  entity: string;
  keyField: string;
  labelField: string;
  search: string;
  skip: number;
  top: number;
};

/** Paged OData list for value-help: key+label $select, contains search on both. */
export function buildLookupListPath(opts: LookupListOpts): string {
  assertIdent(opts.entity, "entity");
  assertIdent(opts.keyField, "field");
  assertIdent(opts.labelField, "field");
  const select =
    opts.keyField === opts.labelField ? [opts.keyField] : [opts.keyField, opts.labelField];
  return buildListPath(opts.entity, {
    top: opts.top,
    skip: opts.skip,
    q: opts.search || undefined,
    fields: opts.search ? select : [],
    select,
  });
}

/** B1 returns @odata.nextLink either relative ("Orders?$skip=20") or absolute. Normalize to a
 *  rawFetch path (rawFetch does baseUrl + path, so the service root must be stripped). */
export function nextLinkPath(link: unknown, baseUrl: string): string | undefined {
  if (typeof link !== "string" || link === "") return undefined;
  if (!/^https?:\/\//i.test(link)) return link.startsWith("/") ? link : `/${link}`;
  const u = new URL(link);
  const root = new URL(baseUrl).pathname.replace(/\/$/, "");
  const path = root && u.pathname.startsWith(root) ? u.pathname.slice(root.length) : u.pathname;
  return `${path}${u.search}`;
}

/** DateTimeOffset for GetItemPrice only when the input parses as a real date. */
export function normalizeItemPriceDate(date?: string): string | undefined {
  if (!date?.trim()) return undefined;
  const t = date.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) {
    const d = new Date(`${t}T00:00:00Z`);
    if (Number.isNaN(d.getTime())) return undefined;
    return `${t}T00:00:00Z`;
  }
  const d = new Date(t);
  if (Number.isNaN(d.getTime())) return undefined;
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

export type ItemPriceInput = {
  itemCode: string;
  cardCode?: string;
  inventoryQuantity?: number;
  uomEntry?: number;
  uomQuantity?: number;
  date?: string;
  currency?: string;
  priceList?: number;
};

/** Pure body for POST /CompanyService_GetItemPrice — InventoryQuantity, never Quantity. */
export function buildItemPriceBody(input: ItemPriceInput): {
  ItemPriceParams: Record<string, unknown>;
} {
  const params: Record<string, unknown> = { ItemCode: input.itemCode };
  if (input.cardCode != null && input.cardCode !== "") params.CardCode = input.cardCode;
  if (input.inventoryQuantity != null) params.InventoryQuantity = input.inventoryQuantity;
  if (input.uomEntry != null) params.UoMEntry = input.uomEntry;
  if (input.uomQuantity != null) params.UoMQuantity = input.uomQuantity;
  const date = normalizeItemPriceDate(input.date);
  if (date) params.Date = date;
  if (input.currency != null && input.currency !== "") params.Currency = input.currency;
  if (input.priceList != null) params.PriceList = input.priceList;
  return { ItemPriceParams: params };
}

export type LookupResult = {
  rows: Array<{ key: string; label: string }>;
  hasMore: boolean;
};

export type ItemContextAgentInput = {
  itemCode: string;
  select: string[];
  price: ItemPriceInput;
};

export type ItemContextAgentResult = {
  defaults: Record<string, unknown>;
  price?: { value: number; currency?: string; discount?: number };
};

export class SlError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | number | undefined,
    message: string,
  ) {
    super(message);
  }
}

/** Reject non-XML /$metadata payloads (JSON error bodies, HTML gateways, …). */
export function requireXmlMetadata(contentType: string | null, body: string): void {
  const ct = (contentType ?? "").toLowerCase();
  if (ct.includes("xml")) return;
  if (body.trimStart().startsWith("<")) return;
  throw new SlError(502, "BAD_METADATA_RESPONSE", "Service Layer /$metadata did not return XML");
}

// Error shape: {error:{code,message}} — message is a plain string on b1s/v2 (OData 4) and a
// {lang,value} object on b1s/v1 and Beas. Anything else (HTML error page, reverse-proxy blurb)
// keeps the raw body — never collapse to statusText, that's how a bare "Bad Request" reaches the
// browser with the cause discarded. Status + code are folded into the message because sync.ts's
// msg() forwards only e.message to the cloud.
// Exported (like parseEdmx/buildListPath) so it has a self-check without a live B1.
export function parseSlError(
  status: number,
  statusText: string,
  raw: string,
  source = "B1",
): { code: string | number | undefined; message: string } {
  let code: string | number | undefined;
  let detail = raw;
  try {
    const body = JSON.parse(raw) as { error?: { code?: string | number; message?: string | { value?: string } } };
    code = body.error?.code;
    const m = body.error?.message;
    detail = (typeof m === "string" ? m : m?.value)?.trim() || raw;
  } catch {
    // non-JSON body — raw it is
  }
  // Beas echoes the HTTP status as the code; don't render "404 code 404".
  const label = [status, code != null && String(code) !== String(status) && `code ${code}`]
    .filter(Boolean)
    .join(" ");
  return { code, message: `${source} ${label}: ${detail || statusText}` };
}

export interface SlConfig {
  baseUrl: string; // .../b1s/v1 or /b1s/v2
  companyDb: string;
  user: string;
  pass: string;
  insecureTls?: boolean;
  timeoutMs?: number;
}

export class ServiceLayerClient {
  private cookie = "";
  private loginInFlight: Promise<void> | null = null;
  private readonly timeoutMs: number;

  constructor(private readonly cfg: SlConfig) {
    // B1 document/master-data POSTs can be genuinely slow (10s+ on some instances),
    // so the cap is high — it exists to catch true hangs, not to bound normal writes.
    this.timeoutMs = cfg.timeoutMs ?? 60_000;
  }

  private async rawFetch(path: string, init: RequestInit): Promise<Response> {
    const headers = new Headers(init.headers);
    if (this.cookie) headers.set("cookie", this.cookie);
    // Hard timeout: a stalled B1 connection must abort, not block the loop forever.
    // The thrown TimeoutError is non-SlError -> classified transient -> redelivered.
    const full: RequestInit & { tls?: { rejectUnauthorized: boolean } } = {
      ...init,
      headers,
      signal: AbortSignal.timeout(this.timeoutMs),
    };
    if (this.cfg.insecureTls) full.tls = { rejectUnauthorized: false };
    // ponytail: one log site for every SL call — login/GET/POST/PATCH all funnel through here.
    // Add res.clone().text() if you ever need response bodies too.
    const url = this.cfg.baseUrl + path;
    const body =
      typeof init.body === "string" ? init.body.replace(/("Password":")[^"]*"/, '$1***"') : "";
    console.log(`[sl] → ${init.method} ${url}${body ? " " + body : ""}`);
    const t0 = Date.now();
    const res = await fetch(url, full as RequestInit);
    console.log(`[sl] ← ${res.status} ${init.method} ${url} (${Date.now() - t0}ms)`);
    return res;
  }

  /** Single-flight: concurrent 401s share one re-login instead of stampeding /Login. */
  private login(): Promise<void> {
    if (this.loginInFlight) return this.loginInFlight;
    this.loginInFlight = (async () => {
      const res = await this.rawFetch("/Login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          CompanyDB: this.cfg.companyDb,
          UserName: this.cfg.user,
          Password: this.cfg.pass,
        }),
      });
      if (!res.ok) throw new SlError(res.status, "LOGIN_FAILED", await res.text());
      // Carry B1SESSION (required) and ROUTEID (load-balancer stickiness).
      const parts: string[] = [];
      for (const sc of res.headers.getSetCookie()) {
        const kv = sc.split(";")[0]!;
        if (kv.startsWith("B1SESSION=") || kv.startsWith("ROUTEID=")) parts.push(kv);
      }
      this.cookie = parts.join("; ");
    })().finally(() => {
      this.loginInFlight = null;
    });
    return this.loginInFlight;
  }

  /** Establish a B1 session now (no-op if one is live) so the user's first query doesn't pay the
   *  /Login round-trip. Idempotent and single-flight via login(); safe to call on every app load. */
  async ensureSession(): Promise<void> {
    if (!this.cookie) await this.login();
  }

  private async request(
    method: string,
    path: string,
    body?: unknown,
    extraHeaders?: Record<string, string>,
  ): Promise<Response> {
    if (!this.cookie) await this.login();
    const init: RequestInit = { method };
    const headers: Record<string, string> = { ...extraHeaders };
    if (body !== undefined) {
      init.body = JSON.stringify(body);
      headers["content-type"] = "application/json";
      headers["odatamaxpagesize"] = "1000"; // B1 v2 default is 20, which is too small for many lists
    }
    if (Object.keys(headers).length) init.headers = headers;
    let res = await this.rawFetch(path, init);
    if (res.status === 401) {
      // Session expired — re-login once and retry. Don't count this as a delivery attempt.
      this.cookie = "";
      await this.login();
      res = await this.rawFetch(path, init);
    }
    return res;
  }

  // --- Generic entity access for autodiscovered entities ---

  // Entity names come from the cloud (admin-selected from discovery) but still flow into a URL
  // path, so re-validate at this trust boundary before building any request.
  private assertEntity(entity: string): void {
    if (!/^[A-Za-z0-9_]+$/.test(entity)) throw new SlError(400, "BAD_ENTITY", `Invalid entity name '${entity}'`);
  }

  private keyPredicate(key: string, quoted: boolean): string {
    const k = encodeURIComponent(key);
    return quoted ? `'${k}'` : k;
  }

  /** Discover all entity sets + their field schemas from the Service Layer $metadata. */
  async metadata(): Promise<EntitySchema[]> {
    const res = await this.request("POST", "/$metadata", undefined, { Accept: "application/xml" });
    if (!res.ok) throw await this.toError(res);
    const body = await res.text();
    requireXmlMetadata(res.headers.get("content-type"), body);
    return parseEdmx(body);
  }

  /** List a page of an entity set with the inline total. OData v4 server pagination (maxpagesize=100). */
  async listEntity(
    entity: string,
    opts: Omit<ListQuery, "skip"> & { skip?: number },
  ): Promise<{ rows: Record<string, unknown>[]; count: number | null; hasMore: boolean }> {
    this.assertEntity(entity);
    const res = await this.request(
      "GET",
      buildListPath(entity, { ...opts, skip: opts.skip ?? 0 }),
      undefined,
      { Prefer: "odata.maxpagesize=100" },
    );
    if (!res.ok) throw await this.toError(res);
    const json = (await res.json()) as {
      value?: Record<string, unknown>[];
      "@odata.count"?: number | string;
      "@odata.nextLink"?: string;
    };
    const count = json["@odata.count"] != null ? Number(json["@odata.count"]) : null;
    return { rows: json.value ?? [], count, hasMore: !!json["@odata.nextLink"] };
  }

  /** Fetch one record by key. */
  async getEntity(entity: string, key: string, keyQuoted: boolean): Promise<Record<string, unknown>> {
    this.assertEntity(entity);
    const res = await this.request("GET", `/${entity}(${this.keyPredicate(key, keyQuoted)})`);
    if (!res.ok) throw await this.toError(res);
    return (await res.json()) as Record<string, unknown>;
  }

  /** Header $select + profiled $crossjoin collections (or one full GET when fallback). */
  async getEntityProjected(request: ObjectFetchRequest): Promise<Record<string, unknown>> {
    this.assertEntity(request.entity);

    if (request.fullRecordFallback) {
      const res = await this.request(
        "GET",
        `/${request.entity}(${odataKeyLiteral(request.key, request.keyQuoted)})`,
      );
      if (!res.ok) throw await this.toError(res);
      const full = (await res.json()) as Record<string, unknown>;
      return projectFullRecord(full, request);
    }

    const headerRes = await this.request(
      "GET",
      buildObjectHeaderPath(request.entity, request.key, request.keyQuoted, request.select),
    );
    if (!headerRes.ok) throw await this.toError(headerRes);
    const record = (await headerRes.json()) as Record<string, unknown>;

    for (const col of request.collections) {
      const path = buildCrossjoinPath({
        entity: request.entity,
        key: request.key,
        keyQuoted: request.keyQuoted,
        collection: col,
      });
      const res = await this.request("GET", path);
      if (!res.ok) throw await this.toError(res);
      const json = (await res.json()) as { value?: Record<string, unknown>[] };
      record[col.name] = flattenCrossjoinRows(json.value ?? [], request.entity, col.name);
    }
    return record;
  }

  /** Create a record. Returns B1's created entity body. */
  async createEntity(entity: string, data: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.assertEntity(entity);
    const res = await this.request("POST", `/${entity}`, data);
    if (!res.ok) throw await this.toError(res);
    return (await res.json()) as Record<string, unknown>;
  }

  /** Update a record by key. B1 PATCH returns 204 No Content.
   *  Set replaceCollections when the payload includes a changed collection array. */
  async updateEntity(
    entity: string,
    key: string,
    keyQuoted: boolean,
    data: Record<string, unknown>,
    opts?: { replaceCollections?: boolean },
  ): Promise<{ ok: true }> {
    this.assertEntity(entity);
    const headers = opts?.replaceCollections
      ? { "B1S-ReplaceCollectionsOnPatch": "true" }
      : undefined;
    const res = await this.request(
      "PATCH",
      `/${entity}(${this.keyPredicate(key, keyQuoted)})`,
      data,
      headers,
    );
    if (!res.ok) throw await this.toError(res);
    return { ok: true };
  }

  /** Dedup lookup for create redelivery / unique-conflict recovery. At most 2 rows.
   *  Exactly one = found; zero = absent; two = invariant failure (DEDUP_AMBIGUOUS). */
  async findByDedup(
    entity: string,
    field: string,
    value: string,
    resultKey: string,
  ): Promise<{ status: "found"; record: Record<string, unknown> } | { status: "absent" }> {
    this.assertEntity(entity);
    assertIdent(field, "field");
    assertIdent(resultKey, "field");
    const filter = `${field} eq ${odataLiteral(value)}`;
    const path =
      `/${entity}?$filter=${encodeURIComponent(filter)}` +
      `&$top=2&$select=${resultKey}`;
    const res = await this.request("GET", path);
    if (!res.ok) throw await this.toError(res);
    const json = (await res.json()) as { value?: Record<string, unknown>[] };
    const rows = json.value ?? [];
    if (rows.length === 0) return { status: "absent" };
    if (rows.length > 1) {
      throw new SlError(500, "DEDUP_AMBIGUOUS", `Multiple rows for ${entity}.${field}=${value}`);
    }
    return { status: "found", record: rows[0]! };
  }

  /** Generic read-only OData GET for the configurator "Query" data source and the dashboard
   *  snapshot. The path is server- or admin-authored and GET-only. Collection responses are
   *  paged to exhaustion; anything else (aggregates, single entities) passes straight through.
   *  ponytail: 20k-row ceiling with a console warning — raise it, or push the aggregation into
   *  B1 with $apply, only if a real tenant hits it. */
  async queryRaw(path: string): Promise<unknown> {
    if (!path.startsWith("/")) throw new SlError(400, "BAD_PATH", "query path must start with /");
    const MAX_ROWS = 20_000;
    let next: string | undefined = path;
    let envelope: Record<string, unknown> | undefined;
    const rows: unknown[] = [];

    while (next) {
      const res = await this.request("GET", next, undefined, { Prefer: "odata.maxpagesize=1000" });
      if (!res.ok) throw await this.toError(res);
      const json = (await res.json()) as Record<string, unknown>;
      if (!Array.isArray(json.value)) return json;
      envelope ??= json;
      rows.push(...json.value);
      if (rows.length >= MAX_ROWS) {
        console.warn(`[sl] queryRaw hit the ${MAX_ROWS}-row cap for ${path}; result is truncated`);
        break;
      }
      next = nextLinkPath(json["@odata.nextLink"], this.cfg.baseUrl);
    }

    return { ...envelope, value: rows, "@odata.nextLink": undefined };
  }

  /** Value-help page: server-fixed key/label fields only. */
  async listLookup(opts: LookupListOpts): Promise<LookupResult> {
    this.assertEntity(opts.entity);
    assertIdent(opts.keyField, "field");
    assertIdent(opts.labelField, "field");
    const res = await this.request("GET", buildLookupListPath(opts), undefined, {
      Prefer: "odata.maxpagesize=100",
    });
    if (!res.ok) throw await this.toError(res);
    const json = (await res.json()) as {
      value?: Record<string, unknown>[];
      "@odata.nextLink"?: string;
    };
    const rows = (json.value ?? []).map((r) => {
      const key = r[opts.keyField];
      const label = r[opts.labelField] ?? key;
      return { key: key == null ? "" : String(key), label: label == null ? "" : String(label) };
    });
    return { rows, hasMore: !!json["@odata.nextLink"] };
  }

  /** Selected Item master fields + CompanyService_GetItemPrice (InventoryQuantity). */
  async getItemContext(input: ItemContextAgentInput): Promise<ItemContextAgentResult> {
    this.assertEntity("Items");
    for (const f of input.select) assertIdent(f, "field");

    const select = input.select.filter((f) => IDENT.test(f));
    const sel = select.length ? `?$select=${select.join(",")}` : "";
    const itemRes = await this.request(
      "GET",
      `/Items(${odataKeyLiteral(input.itemCode, true)})${sel}`,
    );
    if (!itemRes.ok) throw await this.toError(itemRes);
    const defaults = (await itemRes.json()) as Record<string, unknown>;

    const priceRes = await this.request(
      "POST",
      "/CompanyService_GetItemPrice",
      buildItemPriceBody({ ...input.price, itemCode: input.itemCode }),
    );
    if (!priceRes.ok) throw await this.toError(priceRes);
    const priceJson = (await priceRes.json()) as {
      Price?: number;
      Currency?: string;
      Discount?: number;
    };
    const price =
      priceJson.Price != null
        ? {
            value: Number(priceJson.Price),
            currency: priceJson.Currency || undefined,
            discount: priceJson.Discount != null ? Number(priceJson.Discount) : undefined,
          }
        : undefined;
    return { defaults, price };
  }

  private async toError(res: Response): Promise<SlError> {
    const raw = (await res.text().catch(() => "")).slice(0, 2000);
    const { code, message } = parseSlError(res.status, res.statusText, raw);
    console.error(`[sl] ! ${message}`);
    return new SlError(res.status, code, message);
  }
}
