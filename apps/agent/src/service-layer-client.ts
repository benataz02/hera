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

// Build the OData v4 query path for a paged, optionally-filtered entity list. Pure (no I/O) so it
// has a network-free self-check in scripts/e2e.ts --unit. The search term is a user trust boundary:
// escape single quotes ('->'') and URL-encode; only keep schema field names matching the ident RE.
export function buildListPath(
  entity: string,
  opts: { top: number; skip: number; q?: string; fields?: string[] },
): string {
  const params = [`$top=${opts.top}`, `$skip=${opts.skip}`, "$count=true"];
  if (opts.q && opts.fields?.length) {
    const term = opts.q.replace(/'/g, "''");
    const clauses = opts.fields
      .filter((f) => /^[A-Za-z0-9_]+$/.test(f))
      .map((f) => `contains(${f},'${term}')`);
    if (clauses.length) params.push(`$filter=${encodeURIComponent(clauses.join(" or "))}`);
  }
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

  /** GET a BusinessPartner by CardCode. Returns the CardCode if it exists, else null. */
  async getBusinessPartner(cardCode: string): Promise<string | null> {
    const res = await this.request(
      "GET",
      `/BusinessPartners('${encodeURIComponent(cardCode)}')?$select=CardCode`,
    );
    if (res.status === 404) return null;
    if (!res.ok) throw await this.toError(res);
    const json = (await res.json()) as { CardCode: string };
    return json.CardCode;
  }

  /** Create a BusinessPartner. Returns the CardCode (our idempotency / external key). */
  async createBusinessPartner(bp: {
    CardCode: string;
    CardName: string;
    CardType?: string;
  }): Promise<string> {
    const res = await this.request("POST", "/BusinessPartners", {
      CardType: "cCustomer",
      ...bp,
    });
    if (!res.ok) throw await this.toError(res);
    return bp.CardCode;
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
    // SL v2 GET /$metadata is pathologically slow / hangs; POST returns the same EDMX in ~2s.
    // ponytail: POST, not GET — empty body. Do not "fix" this back to GET.
    const res = await this.request("POST", "/$metadata");
    if (!res.ok) throw await this.toError(res);
    return parseEdmx(await res.text());
  }

  /** List a page of an entity set with the inline total. OData v4 server pagination (maxpagesize=100). */
  async listEntity(
    entity: string,
    opts: { top: number; skip?: number; q?: string; fields?: string[] },
  ): Promise<{ rows: Record<string, unknown>[]; count: number | null; hasMore: boolean }> {
    this.assertEntity(entity);
    const res = await this.request(
      "GET",
      buildListPath(entity, { top: opts.top, skip: opts.skip ?? 0, q: opts.q, fields: opts.fields }),
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

  private async toError(res: Response): Promise<SlError> {
    let code: string | number | undefined;
    let message = res.statusText;
    try {
      const body = (await res.json()) as { error?: { code?: string | number; message?: { value?: string } } };
      code = body.error?.code;
      message = body.error?.message?.value ?? message;
    } catch {
      // non-JSON body
    }
    return new SlError(res.status, code, message);
  }
}
