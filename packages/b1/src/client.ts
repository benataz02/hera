import { crossJoinPath, entityPath, entitySetPath } from "./query.ts";
import type { ServiceLayer } from "./service-layer.ts";
import type {
  B1MetadataParams, B1Response, B1Transport, CrossJoinSpec, Key, Prefer, QueryOptions,
} from "./types.ts";

const etagOf = (data: unknown): string | undefined => {
  const v = (data as Record<string, unknown> | null)?.["@odata.etag"];
  return typeof v === "string" && v ? v : undefined;
};

const pageHeader = (q?: QueryOptions): Record<string, string> | undefined =>
  q?.maxPageSize === undefined ? undefined : { Prefer: `odata.maxpagesize=${q.maxPageSize}` };

/** Expanded port of b1-mcp-server's B1Client (MIT). Every capability HERA needs is a named,
 *  typed method — there is deliberately no generic escape hatch, so no caller can hand the
 *  agent an arbitrary URL. Added over the sample: etag, prefer, expand, count, readNext,
 *  crossJoin, metadata. */
export class DirectTransport implements B1Transport {
  constructor(private readonly sl: ServiceLayer) {}

  private async get(url: string, headers?: Record<string, string>): Promise<B1Response> {
    const res = await this.sl.request({ url, method: "GET", headers });
    return { status: res.status, data: res.data, etag: etagOf(res.data) };
  }

  readEntitySet(entitySet: string, q?: QueryOptions): Promise<B1Response> {
    return this.get(entitySetPath(entitySet, q), pageHeader(q));
  }

  readEntity(entitySet: string, key: Key, q?: QueryOptions): Promise<B1Response> {
    return this.get(entityPath(entitySet, key, q));
  }

  crossJoin(spec: CrossJoinSpec): Promise<B1Response> {
    return this.get(crossJoinPath(spec));
  }

  /** The one method that accepts a B1-supplied URL, so it is the one that must be checked:
   *  a relative link resolves under the Service Layer base, an absolute one must already be
   *  under it. A cloud caller cannot point the agent somewhere else. */
  async readNext(nextLink: string): Promise<B1Response> {
    const resolved = new URL(nextLink, this.sl.base).toString();
    if (!resolved.startsWith(this.sl.base)) throw new Error("nextLink is outside the Service Layer");
    return this.get(resolved);
  }

  async createEntity(entitySet: string, data: unknown, o?: { prefer?: Prefer }): Promise<B1Response> {
    // The sample only ever asked for return-no-content. Quote write-back needs the created
    // document (DocEntry, DocNum, totals) back in one call.
    const prefer = o?.prefer === "no-content" ? "return-no-content" : "return-representation";
    const res = await this.sl.request({
      url: entitySetPath(entitySet), method: "POST", data, headers: { Prefer: prefer },
    });
    return { status: res.status, data: res.data, etag: etagOf(res.data) };
  }

  async updateEntity(entitySet: string, key: Key, data: unknown, o?: { etag?: string }): Promise<B1Response> {
    const res = await this.sl.request({
      url: entityPath(entitySet, key), method: "PATCH", data,
      headers: o?.etag ? { "If-Match": o.etag } : undefined,
    });
    return { status: res.status, data: res.data };
  }

  async deleteEntity(entitySet: string, key: Key, o?: { etag?: string }): Promise<B1Response> {
    const res = await this.sl.request({
      url: entityPath(entitySet, key), method: "DELETE",
      headers: o?.etag ? { "If-Match": o.etag } : undefined,
    });
    return { status: res.status, data: res.data };
  }

  metadata(p?: B1MetadataParams): Promise<string> {
    return this.sl.fetchMetadata(p);
  }
}
