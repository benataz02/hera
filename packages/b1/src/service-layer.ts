import { B1Error } from "./errors.ts";
import { metadataPath } from "./query.ts";
import { nextLinkOf, rowsOf, silentLogger, type B1MetadataParams, type Logger } from "./types.ts";

export type ServiceLayerOptions = {
  /** Root, e.g. https://sap:50000 — `basePath` is appended. */
  url: string;
  /** B1 Service Layer is /b1s/v2/; Beas OData lives somewhere else on its own host. */
  basePath?: string;
  /** Session login (B1) vs a static Authorization header (Beas, if it uses basic auth). */
  auth?: "session" | "basic";
  companyDb?: string;
  user: string;
  pass: string;
  /** A stock on-prem Service Layer ships a self-signed cert, and dev is all on localhost. */
  allowSelfSigned?: boolean;
  /** Bound on the agent -> SL hop. A hung Service Layer must not pin the request forever. */
  timeoutMs?: number;
  logger?: Logger;
};

type HttpMethod = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

export type RawResponse = { status: number; headers: Headers; data: unknown };

export type PersonalFieldSetup = { tableName: string; fieldName: string; dataClassification: string; category?: string };

/** Ported from b1-mcp-server's B1ServiceLayer (MIT). Changes on port, all deliberate:
 *  - Set-Cookie is read with getSetCookie(); the original's split(",") shredded
 *    `Expires=Wed, 09 Jun 2021 ...` into bogus fragments and lost ROUTEID, which a
 *    load-balanced Service Layer requires.
 *  - one in-flight login promise, so N cold concurrent requests burn one licence slot, not N.
 *  - B1Error instead of Error(string).
 *  - the OAuth branch, the Config singleton and the AsyncLocalStorage request context are gone.
 *  - logout(), request timeouts, and Bun's `tls` option instead of an undici dispatcher (Bun's
 *    fetch ignores `dispatcher` entirely — the ported code would have silently kept verifying). */
export class ServiceLayer {
  private readonly baseUrl: string;
  private readonly o: ServiceLayerOptions;
  private readonly logger: Logger;
  private cookieHeader: string | null = null;
  private loginInFlight: Promise<void> | null = null;

  constructor(options: ServiceLayerOptions) {
    this.o = options;
    this.logger = options.logger ?? silentLogger;
    const base = options.url.replace(/\/+$/, "");
    const path = (options.basePath ?? "/b1s/v2/").replace(/^\/*/, "/").replace(/\/*$/, "/");
    this.baseUrl = base + path;
  }

  /** Public so the agent can origin-check a B1-supplied nextLink against it. */
  get base(): string {
    return this.baseUrl;
  }

  private init(extra: RequestInit): RequestInit {
    return {
      ...extra,
      signal: AbortSignal.timeout(this.o.timeoutMs ?? 60_000),
      // Bun-specific; the undici `dispatcher` the sample used is a no-op here.
      ...(this.o.allowSelfSigned ? { tls: { rejectUnauthorized: false } } : {}),
    } as RequestInit;
  }

  private async login(): Promise<void> {
    if (this.o.auth === "basic") {
      this.cookieHeader = ""; // nothing to fetch; request() adds the header itself
      return;
    }
    const res = await fetch(
      this.joinUrl("Login"),
      this.init({
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ CompanyDB: this.o.companyDb, UserName: this.o.user, Password: this.o.pass }),
      }),
    );

    const payload = await res.text();
    let data: unknown = payload;
    try { data = payload ? JSON.parse(payload) : null; } catch { /* keep text */ }
    if (!res.ok) {
      const err = B1Error.parse(res.status, data);
      this.logger.warn(`B1 Service Layer login failed (${err.status}): ${err.message}`);
      throw err;
    }

    // getSetCookie() keeps each Set-Cookie header whole. Splitting the joined header on ","
    // (what the sample does) breaks inside `Expires=Wed, 09 Jun 2021 ...` and drops ROUTEID.
    const cookies = res.headers.getSetCookie();
    if (cookies.length) {
      this.cookieHeader = cookies.map((c) => c.split(";")[0]!.trim()).filter(Boolean).join("; ");
    } else {
      const sessionId = (data as { SessionId?: unknown } | null)?.SessionId;
      if (typeof sessionId !== "string" || !sessionId) {
        const err = new B1Error(res.status, null, "B1 login succeeded but returned neither cookies nor a SessionId");
        this.logger.warn(`B1 Service Layer login failed (${err.status}): ${err.message}`);
        throw err;
      }
      this.cookieHeader = `B1SESSION=${sessionId}; CompanyDB=${this.o.companyDb ?? ""}`;
    }
    this.logger.info("B1 Service Layer login successful");
  }

  /** One login at a time: without this, N concurrent cold requests fire N logins and burn
   *  N B1 licence slots. */
  private ensureSession(): Promise<void> {
    if (this.cookieHeader !== null) return Promise.resolve();
    this.loginInFlight ??= this.login().finally(() => { this.loginInFlight = null; });
    return this.loginInFlight;
  }

  async logout(): Promise<void> {
    if (this.cookieHeader === null || this.o.auth === "basic") return;
    try {
      await fetch(this.joinUrl("Logout"), this.init({ method: "POST", headers: { Cookie: this.cookieHeader } }));
    } catch (e) {
      this.logger.warn("B1 logout failed", e);
    }
    this.cookieHeader = null;
  }

  private joinUrl(pathOrUrl: string): string {
    if (/^https?:\/\//i.test(pathOrUrl)) return pathOrUrl;
    return this.baseUrl + pathOrUrl.replace(/^\/+/, "");
  }

  async request(
    options: { url: string; method: HttpMethod; data?: unknown; headers?: Record<string, string> },
    retried = false,
  ): Promise<RawResponse> {
    await this.ensureSession();
    const url = this.joinUrl(options.url);

    const headers: Record<string, string> = {
      Accept: "application/json",
      "Content-Type": "application/json",
      ...(this.o.auth === "basic"
        ? { Authorization: `Basic ${btoa(`${this.o.user}:${this.o.pass}`)}` }
        : { Cookie: this.cookieHeader ?? "" }),
      ...options.headers,
    };

    const started = performance.now();
    const res = await fetch(
      url,
      this.init({
        method: options.method,
        headers,
        body: options.data !== undefined && options.method !== "GET" ? JSON.stringify(options.data) : undefined,
      }),
    );
    const rel = url.startsWith(this.baseUrl) ? url.slice(this.baseUrl.length) : options.url;
    const path = `/${rel.replace(/^\/+/, "")}`;
    this.logger.info(`${options.method} ${res.status} ${Math.round(performance.now() - started)}ms ${path}`);

    // Reactive re-login, once. B1 idles sessions out at ~30 min; a keep-alive timer is code that
    // exists only to avoid one cheap retry.
    // ponytail: reactive re-login; add keep-alive only if 401 churn shows in the agent log.
    if ((res.status === 401 || res.status === 403) && !retried && this.o.auth !== "basic") {
      this.logger.warn(`B1 request unauthorized (${res.status}); re-logging in and retrying once`, { url: path });
      this.cookieHeader = null;
      return this.request(options, true);
    }

    const isXml = (res.headers.get("content-type") ?? "").includes("xml");
    const payload = await res.text();
    let data: unknown = payload;
    if (!isXml) {
      try { data = payload ? JSON.parse(payload) : null; } catch { /* keep text */ }
    }
    if (!res.ok) throw B1Error.parse(res.status, data);
    return { status: res.status, headers: res.headers, data };
  }

  async fetchMetadata(params?: B1MetadataParams): Promise<string> {
    const res = await this.request({
      url: metadataPath(params),
      method: "GET",
      headers: { Accept: "application/xml" },
    });
    return String(res.data ?? "");
  }

  /** Every PersonalFieldsSetups page. Private to this method and bounded by the setup table,
   *  not by user data — which is why it may loop where callers may not. */
  async fetchPersonalFieldsSetups(maxPageSize = 200): Promise<PersonalFieldSetup[]> {
    const out: PersonalFieldSetup[] = [];
    let next = "PersonalFieldsSetups";
    while (next) {
      const res = await this.request({
        url: next,
        method: "GET",
        headers: { Accept: "application/json", Prefer: `odata.maxpagesize=${maxPageSize}` },
      });
      for (const row of rowsOf(res.data)) {
        if (!row.TableName || !row.FieldName) continue;
        out.push({
          tableName: String(row.TableName),
          fieldName: String(row.FieldName),
          dataClassification: String(row.DataClassification ?? ""),
          category: row.Category === undefined ? undefined : String(row.Category),
        });
      }
      next = nextLinkOf(res.data) ?? "";
    }
    return out;
  }
}
