// The agent's delivery decision, isolated from transport/env so it can be unit-tested
// with a mock B1. This is where the "effectively once" guarantee is enforced.
import type { ListQuery } from "./service-layer-client.ts";

// --- On-demand request/reply (reads + generic writes for autodiscovered entities) ---

export interface RequestRow {
  id: string;
  kind: string; // metadata | list | get | create | update | query | login
  payload: Record<string, unknown>;
}

export interface SlReadPort {
  ensureSession(): Promise<void>;
  metadata(): Promise<unknown>;
  listEntity(entity: string, opts: Omit<ListQuery, "skip"> & { skip?: number }): Promise<unknown>;
  getEntity(entity: string, key: string, keyQuoted: boolean): Promise<unknown>;
  createEntity(entity: string, data: Record<string, unknown>): Promise<unknown>;
  updateEntity(entity: string, key: string, keyQuoted: boolean, data: Record<string, unknown>): Promise<unknown>;
  queryRaw(path: string): Promise<unknown>;
}

export interface RequestCloudPort {
  fulfill(input: { id: string; result: unknown }): Promise<unknown>;
  fail(input: { id: string; error: string }): Promise<unknown>;
}

export interface BeasPort {
  get(path: string): Promise<unknown>;
}

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

// Reads are idempotent and the user is waiting: just run it and report the result/error.
// No GET-before-POST/dedup — every kind here is safely retryable by the caller.
export async function processRequest(
  req: RequestRow,
  sl: SlReadPort,
  cloud: RequestCloudPort,
  beas?: BeasPort,
): Promise<void> {
  try {
    const p = req.payload;
    let result: unknown;
    switch (req.kind) {
      case "metadata":
        result = await sl.metadata();
        break;
      case "list": {
        const opts: Omit<ListQuery, "skip"> & { skip?: number } = {
          top: Number(p.top ?? 100),
          skip: Number(p.skip ?? 0),
          q: p.q ? String(p.q) : undefined,
          fields: Array.isArray(p.fields) ? (p.fields as string[]) : [],
        };
        if (Array.isArray(p.select)) opts.select = p.select as string[];
        if (Array.isArray(p.filter)) opts.filter = p.filter as ListQuery["filter"];
        if (Array.isArray(p.orderby)) opts.orderby = p.orderby as ListQuery["orderby"];
        result = await sl.listEntity(String(p.entity), opts);
        break;
      }
      case "get":
        result = await sl.getEntity(String(p.entity), String(p.key), Boolean(p.keyQuoted));
        break;
      case "create":
        result = await sl.createEntity(String(p.entity), (p.data ?? {}) as Record<string, unknown>);
        break;
      case "update":
        result = await sl.updateEntity(String(p.entity), String(p.key), Boolean(p.keyQuoted), (p.data ?? {}) as Record<string, unknown>);
        break;
      case "query":
        if (p.target === "beas") {
          if (!beas) throw new Error("Beas is not configured on this agent (set BEAS_BASE_URL in .env)");
          result = await beas.get(String(p.path));
        } else {
          result = await sl.queryRaw(String(p.path));
        }
        break;
      case "login":
        // Pre-establish the B1 session after the user signs in; no payload, side-effect only.
        await sl.ensureSession();
        result = { ok: true };
        break;
      default:
        throw new Error(`Unknown request kind '${req.kind}'`);
    }
    await cloud.fulfill({ id: req.id, result });
  } catch (err) {
    await cloud.fail({ id: req.id, error: msg(err) });
  }
}
