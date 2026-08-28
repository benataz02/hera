import { B1Error } from "./errors.ts";
import type {
  B1MetadataParams, B1Response, B1Transport, CrossJoinSpec, Key, Prefer, QueryOptions,
} from "./types.ts";

export type RemoteOptions = {
  /** http://localhost:4000 in dev, the tunnel hostname in production. A row in sapConnection —
   *  which is the whole reason the tunnel is deployment config and not a code dependency. */
  agentUrl: string;
  /** Bearer secret the agent checks on every request. */
  secret: string;
  /** Which service the agent should route to. */
  target?: "b1" | "beas";
  /** Cloudflare Access service token — absent in dev, present in production. */
  accessClientId?: string | null;
  accessClientSecret?: string | null;
  /** Bound on the cloud -> agent hop, independent of the agent -> SL bound. */
  timeoutMs?: number;
};

/** Wire shape of the agent's reply. */
type Wire =
  | { status: number; data: unknown; etag?: string }
  | { error: { status: number; code: string | number | null; message: string } };

/** Cloud side of the seam: the same B1Transport methods, one HTTP call each to an
 *  operation-shaped agent endpoint. No route takes a URL except /next, which the agent
 *  origin-checks. */
export class RemoteTransport implements B1Transport {
  private readonly base: string;
  constructor(private readonly o: RemoteOptions) {
    this.base = `${o.agentUrl.replace(/\/+$/, "")}/${o.target ?? "b1"}`;
  }

  private async call(route: string, body: unknown): Promise<B1Response> {
    let res: Response;
    try {
      res = await fetch(`${this.base}${route}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.o.secret}`,
          ...(this.o.accessClientId && this.o.accessClientSecret
            ? {
                "CF-Access-Client-Id": this.o.accessClientId,
                "CF-Access-Client-Secret": this.o.accessClientSecret,
              }
            : {}),
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.o.timeoutMs ?? 70_000),
      });
    } catch (e) {
      // Unreachable agent, DNS, TLS, or our own timeout — never a B1 status.
      throw new B1Error(503, null, `Agent unreachable at ${this.o.agentUrl}: ${e instanceof Error ? e.message : String(e)}`);
    }

    const text = await res.text();
    let wire: Wire | null = null;
    try { wire = text ? (JSON.parse(text) as Wire) : null; } catch { /* fall through */ }
    if (wire && "error" in wire) throw new B1Error(wire.error.status, wire.error.code, wire.error.message);
    if (!res.ok || !wire) throw new B1Error(res.status, null, `Agent error ${res.status}: ${text.slice(0, 500)}`);
    return wire;
  }

  readEntitySet(entitySet: string, query?: QueryOptions) {
    return this.call("/entity-set", { entitySet, query });
  }
  readEntity(entitySet: string, key: Key, query?: QueryOptions) {
    return this.call("/entity", { entitySet, key, query });
  }
  readNext(nextLink: string) {
    return this.call("/next", { nextLink });
  }
  crossJoin(spec: CrossJoinSpec) {
    return this.call("/cross-join", spec);
  }
  createEntity(entitySet: string, data: unknown, o?: { prefer?: Prefer }) {
    return this.call("/create", { entitySet, data, prefer: o?.prefer });
  }
  updateEntity(entitySet: string, key: Key, data: unknown, o?: { etag?: string }) {
    return this.call("/update", { entitySet, key, data, etag: o?.etag });
  }
  deleteEntity(entitySet: string, key: Key, o?: { etag?: string }) {
    return this.call("/delete", { entitySet, key, etag: o?.etag });
  }
  async metadata(p?: B1MetadataParams) {
    return String((await this.call("/metadata", p ?? {})).data ?? "");
  }
}
