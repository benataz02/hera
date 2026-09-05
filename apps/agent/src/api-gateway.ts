import { B1Error, silentLogger, type Logger } from "@hera/b1";

// The SAP B1 API Gateway's Reporting Service. A *different service* from the Service Layer:
// its own port, its own `POST /login`, and an export that answers with a base64 string rather
// than a document. That is why it is not a B1Transport method — there is no URL shape query.ts
// could express and no binary channel ServiceLayer.request has. Base64 is JSON-safe, so the
// agent's existing Response.json reply channel carries it unchanged.
//
// Two lessons are copied verbatim from packages/b1/src/service-layer.ts because they were paid
// for once already:
//   - getSetCookie(), never a split(",") — that shreds `Expires=Wed, 09 Jun ...` and loses the
//     load-balancer's route cookie.
//   - one in-flight login promise, so N cold concurrent requests are one login, not N.

export type ApiGatewayConfig = {
  /** e.g. https://localhost:60020 */
  url: string;
  companyDb: string;
  user: string;
  pass: string;
  /** entity set -> the Crystal layout DocCode that prints it, e.g. { Quotations: "QUT20009" } */
  layouts: Record<string, string>;
  /** The gateway ships a self-signed cert on a stock install. */
  allowSelfSigned?: boolean;
  timeoutMs?: number;
};

export class ApiGateway {
  private readonly base: string;
  private cookieHeader: string | null = null;
  private loginInFlight: Promise<void> | null = null;

  constructor(private readonly o: ApiGatewayConfig, private readonly logger: Logger = silentLogger) {
    this.base = o.url.replace(/\/+$/, "");
  }

  /** Bun-specific: Bun's fetch ignores undici's `dispatcher`, so self-signed handling is `tls`. */
  private init(extra: RequestInit): RequestInit {
    return {
      ...extra,
      signal: AbortSignal.timeout(this.o.timeoutMs ?? 60_000),
      ...(this.o.allowSelfSigned ? { tls: { rejectUnauthorized: false } } : {}),
    } as RequestInit;
  }

  private async login(): Promise<void> {
    const res = await fetch(
      `${this.base}/login`,
      this.init({
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ CompanyDB: this.o.companyDb, UserName: this.o.user, Password: this.o.pass }),
      }),
    );
    if (!res.ok) {
      const text = (await res.text()).slice(0, 500);
      throw new B1Error(res.status, null, `API Gateway login failed (${res.status}): ${text}`);
    }
    const cookies = res.headers.getSetCookie();
    if (!cookies.length) throw new B1Error(res.status, null, "API Gateway login returned no session cookie");
    this.cookieHeader = cookies.map((c) => c.split(";")[0]!.trim()).filter(Boolean).join("; ");
    this.logger.info("API Gateway login successful");
  }

  private ensureSession(): Promise<void> {
    if (this.cookieHeader !== null) return Promise.resolve();
    this.loginInFlight ??= this.login().finally(() => { this.loginInFlight = null; });
    return this.loginInFlight;
  }

  /** The document layout parameter body. `DocKey@` is Crystal's name for the document key —
   *  confirmed against the live gateway by scripts/print-smoke.ts step 3. */
  private static body(docEntry: number) {
    return [{ name: "DocKey@", type: "xsd:string", value: [[String(docEntry)]] }];
  }

  async exportPdf(entity: string, docEntry: number): Promise<{ pdf: string; fileName: string }> {
    const layout = this.o.layouts[entity];
    if (!layout) throw new B1Error(400, null, `No print layout configured for '${entity}' in agent.json apiGateway.layouts`);
    if (!Number.isFinite(docEntry)) throw new B1Error(400, null, `Not a document key: '${docEntry}'`);

    const pdf = await this.post(layout, docEntry, false);
    return { pdf, fileName: `${entity}-${docEntry}.pdf` };
  }

  private async post(layout: string, docEntry: number, retried: boolean): Promise<string> {
    await this.ensureSession();
    const res = await fetch(
      `${this.base}/rs/v1/ExportPDFData?DocCode=${encodeURIComponent(layout)}`,
      this.init({
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json", Cookie: this.cookieHeader! },
        body: JSON.stringify(ApiGateway.body(docEntry)),
      }),
    );

    if (res.status === 401 && !retried) {
      // The session died on the gateway's side; drop ours and go once round again.
      this.cookieHeader = null;
      return this.post(layout, docEntry, true);
    }

    const text = await res.text();
    if (!res.ok) throw new B1Error(res.status, null, `API Gateway ExportPDFData ${layout} failed (${res.status}): ${text.slice(0, 500)}`);

    // The gateway answers with a bare JSON string. Tolerate the two other shapes a Crystal
    // endpoint has been seen to use rather than guess wrong at 3am.
    let parsed: unknown = text;
    try { parsed = JSON.parse(text); } catch { /* a raw base64 body is fine too */ }
    const pdf =
      typeof parsed === "string" ? parsed
      : typeof (parsed as { value?: unknown })?.value === "string" ? (parsed as { value: string }).value
      : typeof (parsed as { PDFData?: unknown })?.PDFData === "string" ? (parsed as { PDFData: string }).PDFData
      : null;
    if (!pdf) throw new B1Error(502, null, `API Gateway returned no PDF data for ${layout}`);
    return pdf;
  }
}
