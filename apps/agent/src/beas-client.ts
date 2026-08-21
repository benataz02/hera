// Thin Beas web-API GET client. Same trust rule as B1: credentials live in the agent's
// local .env (BEAS_BASE_URL, BEAS_USER, BEAS_PASS, BEAS_INSECURE_TLS), never the cloud DB.
// ponytail: GET-only + basic auth; grow it if Beas writes ever land.
import { nextLinkPath, parseSlError, SlError } from "./service-layer-client.ts";

export class BeasClient {
  constructor(
    private cfg: { baseUrl: string; user?: string; pass?: string; insecureTls?: boolean; timeoutMs?: number },
  ) {}

  async get(path: string, all = false): Promise<unknown> {
    if (!path.startsWith("/")) throw new SlError(400, "BAD_PATH", "Beas query path must start with /");
    const headers: Record<string, string> = { Accept: "application/json" };
    if (this.cfg.user) headers.Authorization = "Basic " + btoa(`${this.cfg.user}:${this.cfg.pass ?? ""}`);
    const init: RequestInit & { tls?: { rejectUnauthorized: boolean } } = {
      headers,
      signal: AbortSignal.timeout(this.cfg.timeoutMs ?? 30_000),
    };
    if (this.cfg.insecureTls) init.tls = { rejectUnauthorized: false }; // Bun fetch extension, same as ServiceLayerClient
    const baseUrl = this.cfg.baseUrl.replace(/\/$/, "");
    let next: string | undefined = path;
    let first: Record<string, unknown> | undefined;
    const rows: unknown[] = [];
    const seen = new Set<string>();
    while (next) {
      const page = new URL(next, "https://beas.invalid");
      page.searchParams.sort();
      const pageKey = `${page.pathname}${page.search}`;
      if (seen.has(pageKey)) throw new SlError(502, "PAGING_CYCLE", "Beas pagination returned a repeated nextLink");
      seen.add(pageKey);
      const res = await fetch(baseUrl + next, init);
      if (!res.ok) {
        const raw = (await res.text().catch(() => "")).slice(0, 2000);
        const { code, message } = parseSlError(res.status, res.statusText, raw, "Beas");
        console.error(`[beas] ! ${message}`);
        throw new SlError(res.status, code, message);
      }
      const json = (await res.json()) as Record<string, unknown>;
      if (!Array.isArray(json.value)) return json;
      const nextLink = nextLinkPath(json["@odata.nextLink"] ?? json["odata.nextLink"], this.cfg.baseUrl);
      if (!all) return { ...json, "@odata.nextLink": nextLink };
      first ??= json;
      rows.push(...json.value);
      next = nextLink;
    }
    return { ...first, value: rows, "@odata.nextLink": undefined, "odata.nextLink": undefined };
  }
}
