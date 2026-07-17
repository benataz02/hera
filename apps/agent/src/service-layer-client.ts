// Real SAP B1 Service Layer client. Lives on-prem with the agent; B1 creds never
// leave the customer site. ponytail: login with single-flight re-auth, the quote-backbone
// BusinessPartner GET/POST, plus generic metadata/list/get/create/update for autodiscovered
// entities. No $batch yet — add it when bulk writes matter.
import { XMLParser } from "fast-xml-parser";

export interface EdmProperty {
  name: string;
  type: string;
  nullable: boolean;
}
export interface EntitySchema {
  name: string; // EntitySet name (what you query, e.g. "BusinessPartners")
  keys: string[];
  properties: EdmProperty[];
}

// Find a child by local XML name, ignoring namespace prefix (edmx:Edmx, m:Something, ...).
function pick(obj: Record<string, unknown> | undefined, local: string): unknown {
  if (!obj) return undefined;
  for (const k of Object.keys(obj)) if (k === local || k.endsWith(":" + local)) return obj[k];
  return undefined;
}
const asArray = <T>(v: T | T[] | undefined): T[] => (v == null ? [] : Array.isArray(v) ? v : [v]);

// Parse an OData $metadata (EDMX) document into per-EntitySet schemas. Handles both the v3
// (b1s/v1) and v4 (b1s/v2) shapes — structurally the same for EntityType/Key/Property/EntitySet.
// Exported so it has a runnable self-check (scripts/e2e.ts --unit) without a live B1.
export function parseEdmx(xml: string): EntitySchema[] {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
    isArray: (name) =>
      ["Schema", "EntityType", "EntitySet", "EntityContainer", "Property", "PropertyRef"].includes(name),
  });
  const doc = parser.parse(xml) as Record<string, unknown>;
  const dataServices = pick(pick(doc, "Edmx") as Record<string, unknown>, "DataServices") as Record<string, unknown>;
  const schemas = asArray(pick(dataServices, "Schema") as unknown);

  // EntityType (by local name) -> its keys + properties.
  const types = new Map<string, { keys: string[]; properties: EdmProperty[] }>();
  for (const schema of schemas as Record<string, unknown>[]) {
    for (const et of asArray(pick(schema, "EntityType") as unknown) as Record<string, unknown>[]) {
      const name = et["@_Name"] as string;
      const keys = asArray(pick(pick(et, "Key") as Record<string, unknown>, "PropertyRef") as unknown)
        .map((r) => (r as Record<string, string>)["@_Name"]!);
      const properties = asArray(pick(et, "Property") as unknown).map((p) => {
        const pr = p as Record<string, string>;
        return { name: pr["@_Name"]!, type: pr["@_Type"] ?? "Edm.String", nullable: pr["@_Nullable"] !== "false" };
      });
      types.set(name, { keys, properties });
    }
  }

  // EntitySet -> the EntityType it exposes.
  const out: EntitySchema[] = [];
  for (const schema of schemas as Record<string, unknown>[]) {
    for (const container of asArray(pick(schema, "EntityContainer") as unknown) as Record<string, unknown>[]) {
      for (const set of asArray(pick(container, "EntitySet") as unknown) as Record<string, string>[]) {
        const t = types.get((set["@_EntityType"] ?? "").split(".").pop()!);
        if (t) out.push({ name: set["@_Name"]!, keys: t.keys, properties: t.properties });
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

export class SlError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | number | undefined,
    message: string,
  ) {
    super(message);
  }
}

// b1s/v2 (OData 4) error shape: {error:{code,message}} with message a plain string. Anything else
// (HTML error page, reverse-proxy blurb) keeps the raw body — never collapse to statusText, that's
// how a bare "Bad Request" reaches the browser with the cause discarded. Status + code are folded
// into the message because sync.ts's msg() forwards only e.message to the cloud.
// ponytail: v2 only — b1s/v1 wraps message as {lang,value}; add that branch if a v1 tenant appears.
// Exported (like parseEdmx/buildListPath) so it has a self-check without a live B1.
export function parseSlError(
  status: number,
  statusText: string,
  raw: string,
): { code: string | number | undefined; message: string } {
  let code: string | number | undefined;
  let detail = raw;
  try {
    const body = JSON.parse(raw) as { error?: { code?: string | number; message?: string } };
    code = body.error?.code;
    detail = body.error?.message || raw;
  } catch {
    // non-JSON body — raw it is
  }
  const label = [status, code != null && `code ${code}`].filter(Boolean).join(" ");
  return { code, message: `B1 ${label}: ${detail || statusText}` };
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
    const res = await this.request("POST", "/$metadata");
    if (!res.ok) throw await this.toError(res);
    return parseEdmx(await res.text());
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

  /** Create a record. Returns B1's created entity body. */
  async createEntity(entity: string, data: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.assertEntity(entity);
    const res = await this.request("POST", `/${entity}`, data);
    if (!res.ok) throw await this.toError(res);
    return (await res.json()) as Record<string, unknown>;
  }

  /** Update a record by key. B1 PATCH returns 204 No Content. */
  async updateEntity(entity: string, key: string, keyQuoted: boolean, data: Record<string, unknown>): Promise<{ ok: true }> {
    this.assertEntity(entity);
    const res = await this.request("PATCH", `/${entity}(${this.keyPredicate(key, keyQuoted)})`, data);
    if (!res.ok) throw await this.toError(res);
    return { ok: true };
  }

  /** Generic read-only OData GET for the configurator "Query" data source. The path is admin-
   *  authored (in the model) and GET-only, against this agent's B1 Service Layer base. */
  async queryRaw(path: string): Promise<unknown> {
    if (!path.startsWith("/")) throw new SlError(400, "BAD_PATH", "query path must start with /");
    const res = await this.request("GET", path);
    if (!res.ok) throw await this.toError(res);
    return (await res.json()) as unknown;
  }

  private async toError(res: Response): Promise<SlError> {
    const raw = (await res.text().catch(() => "")).slice(0, 2000);
    const { code, message } = parseSlError(res.status, res.statusText, raw);
    console.error(`[sl] ! ${message}`);
    return new SlError(res.status, code, message);
  }
}
