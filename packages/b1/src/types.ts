/** Entity key: a scalar for a single-key set, an object for a composite one. */
export type Key = string | number | Record<string, string | number>;

export type Prefer = "representation" | "no-content";

export type QueryOptions = {
  filter?: string;
  select?: string[];
  orderby?: string;
  top?: number;
  skip?: number;
  expand?: string;
  /** $count=true — the total lands in the same response as `@odata.count`, not a second call. */
  count?: boolean;
  /** `Prefer: odata.maxpagesize` — rows per page. 0 means "no server paging". */
  maxPageSize?: number;
};

/** $crossjoin as data, not a hand-built string. The only way to filter a document by its lines:
 *  B1's $filter has no lambda operators (see apps/server/src/doc-history.ts). */
export type CrossJoinSpec = {
  /** e.g. ["Orders", "Orders/DocumentLines"] */
  entities: string[];
  expand: { entity: string; select: string[] }[];
  filter?: string;
  orderby?: string;
  top?: number;
};

export type B1Response = {
  status: number;
  /** `@odata.etag` off the body when the entity carries one. */
  etag?: string;
  data: unknown;
};

export type B1MetadataParams = {
  /** typically "entityset" */
  scope?: string;
  /** comma-separated, e.g. "labelWithTable,labelWithField" */
  annotation?: string;
  entityset?: string;
  dependency?: boolean;
};

/** The seam. `DirectTransport` (agent) talks to the Service Layer; `RemoteTransport` (cloud)
 *  talks to the agent. Cloud call sites are written against this and never see a URL. */
export interface B1Transport {
  readEntitySet(entitySet: string, q?: QueryOptions): Promise<B1Response>;
  readEntity(entitySet: string, key: Key, q?: QueryOptions): Promise<B1Response>;
  createEntity(entitySet: string, data: unknown, o?: { prefer?: Prefer }): Promise<B1Response>;
  updateEntity(entitySet: string, key: Key, data: unknown, o?: { etag?: string }): Promise<B1Response>;
  deleteEntity(entitySet: string, key: Key, o?: { etag?: string }): Promise<B1Response>;
  metadata(p?: B1MetadataParams): Promise<string>;
  /** One page per call. There is deliberately no readAll — see packages/b1/README-less note in
   *  the plan: callers loop with a visible page cap. */
  readNext(nextLink: string): Promise<B1Response>;
  crossJoin(spec: CrossJoinSpec): Promise<B1Response>;
}

/** Two methods is all the ported code ever used. */
export type Logger = {
  info(msg: string, meta?: unknown): void;
  warn(msg: string, meta?: unknown): void;
};

export const silentLogger: Logger = { info: () => {}, warn: () => {} };

/** Collection envelope helpers — every caller shapes `{ value, @odata.nextLink, @odata.count }`. */
export const rowsOf = (data: unknown): Record<string, unknown>[] => {
  const v = Array.isArray(data) ? data : (data as { value?: unknown } | null)?.value;
  return Array.isArray(v) ? (v as Record<string, unknown>[]) : [];
};

/** Same, but loud: a query that answers with something other than a collection is a modelling
 *  mistake, and silently folding it to zero rows hides it behind an empty value help. */
export const rowsOrThrow = (data: unknown, what: string): Record<string, unknown>[] => {
  const v = Array.isArray(data) ? data : (data as { value?: unknown } | null)?.value;
  if (!Array.isArray(v)) throw new Error(`${what} did not return a row array`);
  return v as Record<string, unknown>[];
};

export const nextLinkOf = (data: unknown): string | undefined => {
  const e = data as Record<string, unknown> | null;
  const v = e?.["@odata.nextLink"] ?? e?.["odata.nextLink"];
  return typeof v === "string" && v ? v : undefined;
};

export const countOf = (data: unknown): number | undefined => {
  const v = (data as Record<string, unknown> | null)?.["@odata.count"];
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : undefined;
};

/** Both live targets a model can name. `beas` is null unless the tenant enabled it. */
export type Connector = { b1: B1Transport; beas: B1Transport | null };
