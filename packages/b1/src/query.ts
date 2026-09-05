import type { CrossJoinSpec, Key, QueryOptions } from "./types.ts";

// The ONLY place a Service Layer URL is assembled. Same builder in the agent and in the tests,
// and no other module can hand-assemble a path.

/** `Orders`, `Orders/DocumentLines` — anything else is not a name we will put in a URL. */
const NAME = /^[A-Za-z_][A-Za-z0-9_]*(\/[A-Za-z_][A-Za-z0-9_]*)*$/;
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function assertName(name: string, what = "entity set"): string {
  if (!NAME.test(name)) throw new Error(`Invalid ${what} '${name}'`);
  return name;
}

/** OData literal. Ported from b1-schema-execute-handlers' buildKeyValue: the sample client's
 *  `typeof key === 'number' ? key : `'${key}'`` neither escapes quotes nor handles composite keys. */
const literal = (v: string | number): string =>
  typeof v === "number" ? String(v) : `'${String(v).replace(/'/g, "''")}'`;

export function buildKeyValue(key: Key): string {
  if (key !== null && typeof key === "object") {
    const parts = Object.entries(key).map(([k, v]) => {
      if (!IDENT.test(k)) throw new Error(`Invalid key field '${k}'`);
      return `${k}=${literal(v)}`;
    });
    if (!parts.length) throw new Error("Composite key needs at least one field");
    return parts.join(",");
  }
  if (typeof key !== "string" && typeof key !== "number") throw new Error("Key must be a string, number or object");
  if (typeof key === "number" && !Number.isFinite(key)) throw new Error("Key must be a finite number");
  return literal(key);
}

/** Route param → untyped key. Never infers number-from-digits: ItemCode '0000377' is a string. */
export function parseKeyParam(raw: string): string | Record<string, string | number> {
  if (raw.startsWith("{")) {
    try { return JSON.parse(raw) as Record<string, string | number>; } catch { /* fall through */ }
  }
  return raw;
}

/** Route/RPC key → the JS type `buildKeyValue` needs. Digit-looking strings stay strings unless
 *  $metadata says the key is numeric — ItemCode '0000377' is not Orders(377). */
export function coerceKey(
  schema: { keys: string[]; fields: { name: string; kind: string }[] },
  raw: Key,
): Key {
  const byName = new Map(schema.fields.map((f) => [f.name, f]));
  const one = (name: string, value: unknown): string | number => {
    if (byName.get(name)?.kind === "number") {
      const n = typeof value === "number" ? value : Number(value);
      if (!Number.isFinite(n)) throw new Error(`Key '${name}' must be a number`);
      return n;
    }
    return String(value ?? "");
  };
  if (raw !== null && typeof raw === "object") {
    const out: Record<string, string | number> = {};
    for (const name of schema.keys) {
      if (!(name in raw)) throw new Error(`Missing key field '${name}'`);
      out[name] = one(name, raw[name]);
    }
    if (!schema.keys.length) throw new Error("Entity has no key");
    return out;
  }
  if (schema.keys.length > 1) throw new Error("Composite key needs an object");
  const name = schema.keys[0];
  if (!name) throw new Error("Entity has no key");
  return one(name, raw);
}

/** `$filter=…&$select=…`. Values are percent-encoded, the `$option` names are NOT: URLSearchParams
 *  would emit `%24select`, and the Service Layer matches the option name literally. */
export function queryString(q?: QueryOptions): string {
  if (!q) return "";
  const parts: string[] = [];
  const set = (k: string, v: string) => parts.push(`${k}=${encodeURIComponent(v)}`);
  if (q.filter) set("$filter", q.filter);
  if (q.select?.length) set("$select", q.select.map((c) => assertName(c, "column")).join(","));
  if (q.orderby) set("$orderby", q.orderby);
  if (q.top !== undefined) set("$top", String(q.top));
  if (q.skip !== undefined) set("$skip", String(q.skip));
  if (q.expand) set("$expand", q.expand);
  if (q.count) set("$count", "true");
  return parts.join("&");
}

const withQuery = (path: string, qs: string): string => (qs ? `${path}?${qs}` : path);

export const entitySetPath = (entitySet: string, q?: QueryOptions): string =>
  withQuery(assertName(entitySet), queryString(q));

export const entityPath = (entitySet: string, key: Key, q?: QueryOptions): string =>
  withQuery(`${assertName(entitySet)}(${buildKeyValue(key)})`, queryString(q));

/** `$crossjoin(A,A/B)?$expand=A($select=…),A/B($select=…)&$filter=…` — B1 wants the expand
 *  clause unencoded, so it is composed by hand and only the values are escaped. */
export function crossJoinPath(spec: CrossJoinSpec): string {
  if (!spec.entities.length) throw new Error("crossJoin needs at least one entity");
  const entities = spec.entities.map((e) => assertName(e));
  const expand = spec.expand
    .map((e) => `${assertName(e.entity)}($select=${e.select.map((c) => assertName(c, "column")).join(",")})`)
    .join(",");
  const parts: string[] = [];
  if (expand) parts.push(`$expand=${expand}`);
  if (spec.filter) parts.push(`$filter=${encodeURIComponent(spec.filter)}`);
  if (spec.orderby) parts.push(`$orderby=${encodeURIComponent(spec.orderby)}`);
  if (spec.top !== undefined) parts.push(`$top=${spec.top}`);
  return withQuery(`$crossjoin(${entities.join(",")})`, parts.join("&"));
}

export function metadataPath(p?: { scope?: string; annotation?: string; entityset?: string; dependency?: boolean }): string {
  if (!p) return "$metadata";
  const parts: string[] = [];
  if (p.scope) parts.push(`scope=${encodeURIComponent(p.scope)}`);
  // Multiple annotations are separate repeated params, not one comma-joined value.
  for (const a of p.annotation?.split(",").map((s) => s.trim()).filter(Boolean) ?? [])
    parts.push(`annotation=${encodeURIComponent(a)}`);
  if (p.entityset) parts.push(`entityset=${encodeURIComponent(p.entityset)}`);
  if (p.dependency !== undefined) parts.push(`dependency=${p.dependency}`);
  return withQuery("$metadata", parts.join("&"));
}

/** AND an extra clause onto an existing $filter. Replaces lookups.ts' regex surgery on a
 *  URL-encoded query string — with a structured query it is plain string composition. */
export const andFilter = (base: string | undefined, extra: string): string =>
  base?.trim() ? `(${base}) and (${extra})` : extra;

export const escapeLiteral = (s: string): string => s.replace(/'/g, "''");
