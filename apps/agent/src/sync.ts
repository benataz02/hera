// The agent's delivery decision, isolated from transport/env so it can be unit-tested
// with a mock B1. This is where the "effectively once" guarantee is enforced.
import { SlError } from "./service-layer-client.ts";

// B1 CardCode is the natural unique key and our idempotency anchor. It maxes at 15 chars,
// so derive a deterministic short code from the (uuid) dedup key.
// ponytail: 14 hex chars = negligible collision risk for <50k records; for real documents
//           use a U_CpqExtId UDF + unique index instead of a natural key.
export const cardCodeFromDedup = (dedupKey: string): string =>
  ("Q" + dedupKey.replace(/-/g, "")).slice(0, 15).toUpperCase();

export type Kind = "transient" | "permanent" | "conflict";

export function classify(err: unknown): Kind {
  if (err instanceof SlError) {
    if (err.status === 401 || err.status >= 500) return "transient";
    if (err.status === 400 && /exist|already|-2035/i.test(err.message)) return "conflict";
    if (err.status >= 400) return "permanent"; // confirmed business rejection
    return "transient";
  }
  return "transient"; // network/timeout/unknown = in-doubt = transient
}

export interface Item {
  id: string;
  kind: string;
  payload: Record<string, unknown>;
  dedupKey: string;
  attempts: number;
}

export interface SlPort {
  getBusinessPartner(code: string): Promise<string | null>;
  createBusinessPartner(bp: { CardCode: string; CardName: string }): Promise<string>;
}

export interface CloudPort {
  ack(input: { id: string; docEntry: string }): Promise<unknown>;
  nack(input: { id: string; kind: "transient" | "permanent"; error?: string }): Promise<unknown>;
}

// --- On-demand request/reply (reads + generic writes for autodiscovered entities) ---

export interface RequestRow {
  id: string;
  kind: string; // metadata | list | get | create | update
  payload: Record<string, unknown>;
}

export interface SlReadPort {
  metadata(): Promise<unknown>;
  listEntity(entity: string, top: number): Promise<unknown>;
  getEntity(entity: string, key: string, keyQuoted: boolean): Promise<unknown>;
  createEntity(entity: string, data: Record<string, unknown>): Promise<unknown>;
  updateEntity(entity: string, key: string, keyQuoted: boolean, data: Record<string, unknown>): Promise<unknown>;
}

export interface RequestCloudPort {
  fulfill(input: { id: string; result: unknown }): Promise<unknown>;
  fail(input: { id: string; error: string }): Promise<unknown>;
}

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

export async function processItem(item: Item, sl: SlPort, cloud: CloudPort): Promise<void> {
  const code = cardCodeFromDedup(item.dedupKey);

  try {
    // attempts > 1 means a prior attempt didn't cleanly ack -> duplicate possible.
    // GET first; if it's already there, just ack. (attempts == 1 -> POST directly, skip GET.)
    if (item.attempts > 1) {
      const existing = await sl.getBusinessPartner(code);
      if (existing) return void (await cloud.ack({ id: item.id, docEntry: existing }));
    }

    const data = (item.payload.data ?? {}) as Record<string, unknown>;
    const cardName = String(data.name ?? data.cardName ?? `Quote ${code}`);
    await sl.createBusinessPartner({ CardCode: code, CardName: cardName });
    await cloud.ack({ id: item.id, docEntry: code });
  } catch (err) {
    const kind = classify(err);
    if (kind === "conflict") {
      // Unique-violation race: never blindly re-POST — GET to confirm, then ack.
      try {
        const existing = await sl.getBusinessPartner(code);
        if (existing) return void (await cloud.ack({ id: item.id, docEntry: existing }));
      } catch {
        return void (await cloud.nack({ id: item.id, kind: "transient", error: msg(err) }));
      }
      return void (await cloud.nack({ id: item.id, kind: "permanent", error: msg(err) }));
    }
    await cloud.nack({ id: item.id, kind, error: msg(err) });
  }
}

// Reads are idempotent and the user is waiting: just run it and report the result/error.
// No GET-before-POST/dedup — that machinery is reserved for the 'quote' write kind.
// ponytail: generic writes (create/update) are at-least-once-via-user-retry; give an entity a
//           dedup_key + the ack/nack path if it ever needs the quote kind's exactly-once guarantee.
export async function processRequest(req: RequestRow, sl: SlReadPort, cloud: RequestCloudPort): Promise<void> {
  try {
    const p = req.payload;
    let result: unknown;
    switch (req.kind) {
      case "metadata":
        result = await sl.metadata();
        break;
      case "list":
        result = await sl.listEntity(String(p.entity), Number(p.top ?? 50));
        break;
      case "get":
        result = await sl.getEntity(String(p.entity), String(p.key), Boolean(p.keyQuoted));
        break;
      case "create":
        result = await sl.createEntity(String(p.entity), (p.data ?? {}) as Record<string, unknown>);
        break;
      case "update":
        result = await sl.updateEntity(String(p.entity), String(p.key), Boolean(p.keyQuoted), (p.data ?? {}) as Record<string, unknown>);
        break;
      default:
        throw new Error(`Unknown request kind '${req.kind}'`);
    }
    await cloud.fulfill({ id: req.id, result });
  } catch (err) {
    await cloud.fail({ id: req.id, error: msg(err) });
  }
}
