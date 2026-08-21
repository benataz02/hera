// Durable write delivery: POST/PATCH SAP, confirm by GET, ack only after confirmation.
// Attempts fence first-create vs GET-before-POST. Never uses fulfill/fail.
import type { RequestRow } from "./sync.ts";
import { SlError } from "./service-layer-client.ts";

export type WritePayload = {
  operation: "create" | "update";
  entity: string;
  key?: string;
  data: Record<string, unknown>;
  commandId: string;
  idempotency?: { field: string; value: string };
  origin?: {
    kind: "config-document";
    projectId: string;
    runId: string;
  };
};

export type DedupLookup =
  | { status: "found"; record: Record<string, unknown> }
  | { status: "absent" };

export interface WriteServiceLayerPort {
  createEntity(entity: string, data: Record<string, unknown>): Promise<Record<string, unknown>>;
  updateEntity(
    entity: string,
    key: string,
    keyQuoted: boolean,
    data: Record<string, unknown>,
    opts?: { replaceCollections?: boolean },
  ): Promise<unknown>;
  getEntity(entity: string, key: string, keyQuoted: boolean): Promise<Record<string, unknown>>;
  findByDedup(
    entity: string,
    field: string,
    value: string,
    resultKey: string,
  ): Promise<DedupLookup>;
}

export interface WriteCloudPort {
  ack(input: {
    id: string;
    attempt: number;
    result?: unknown;
    docEntry?: string;
  }): Promise<unknown>;
  nack(input: {
    id: string;
    attempt: number;
    kind: "transient" | "permanent";
    error?: string;
  }): Promise<unknown>;
}

/** Document creates always resolve DocEntry (profile create.resultKey). */
const CREATE_RESULT_KEY = "DocEntry";

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Numeric DocEntry-style keys stay unquoted; string keys are quoted. */
export function keyQuotedFor(key: string): boolean {
  return !/^-?\d+$/.test(key);
}

function hasCollectionChange(data: Record<string, unknown>): boolean {
  return Object.values(data).some(Array.isArray);
}

function isUniqueConflict(err: unknown): boolean {
  return err instanceof SlError && err.status === 409;
}

/** Confirmed client/validation rejection — not ambiguous network failure. */
function isPermanentRejection(err: unknown): boolean {
  if (!(err instanceof SlError)) return false;
  if (err.status === 409) return false;
  return err.status >= 400 && err.status < 500;
}

function recordKey(record: Record<string, unknown>, resultKey: string, fallback?: string): string {
  const v = record[resultKey] ?? fallback;
  if (v == null || v === "") throw new Error(`Confirmed record missing key '${resultKey}'`);
  return String(v);
}

async function ackConfirmed(
  cloud: WriteCloudPort,
  id: string,
  attempt: number,
  record: Record<string, unknown>,
  resultKey: string,
  fallbackKey?: string,
): Promise<void> {
  const key = recordKey(record, resultKey, fallbackKey);
  await cloud.ack({
    id,
    attempt,
    result: { key, record },
    docEntry: key,
  });
}

async function confirmGet(
  sl: WriteServiceLayerPort,
  entity: string,
  key: string,
): Promise<Record<string, unknown>> {
  return sl.getEntity(entity, key, keyQuotedFor(key));
}

async function resolveUniqueConflict(
  req: RequestRow & { attempts: number },
  payload: WritePayload,
  sl: WriteServiceLayerPort,
  cloud: WriteCloudPort,
): Promise<void> {
  const idemp = payload.idempotency;
  if (!idemp) {
    await cloud.nack({
      id: req.id,
      attempt: req.attempts,
      kind: "permanent",
      error: "Unique conflict without idempotency anchor",
    });
    return;
  }
  try {
    const found = await sl.findByDedup(
      payload.entity,
      idemp.field,
      idemp.value,
      CREATE_RESULT_KEY,
    );
    if (found.status === "found") {
      await ackConfirmed(cloud, req.id, req.attempts, found.record, CREATE_RESULT_KEY);
      return;
    }
    await cloud.nack({
      id: req.id,
      attempt: req.attempts,
      kind: "permanent",
      error: "Unique conflict but dedup lookup found no record",
    });
  } catch (err) {
    // Multiple matches = invariant failure (permanent). Lookup transport/5xx = transient.
    if (err instanceof SlError && err.code === "DEDUP_AMBIGUOUS") {
      await cloud.nack({ id: req.id, attempt: req.attempts, kind: "permanent", error: msg(err) });
      return;
    }
    if (isPermanentRejection(err)) {
      await cloud.nack({ id: req.id, attempt: req.attempts, kind: "permanent", error: msg(err) });
      return;
    }
    await cloud.nack({ id: req.id, attempt: req.attempts, kind: "transient", error: msg(err) });
  }
}

async function postAndConfirm(
  req: RequestRow & { attempts: number },
  payload: WritePayload,
  sl: WriteServiceLayerPort,
  cloud: WriteCloudPort,
): Promise<void> {
  let created: Record<string, unknown>;
  try {
    created = await sl.createEntity(payload.entity, payload.data);
  } catch (err) {
    if (isUniqueConflict(err)) {
      await resolveUniqueConflict(req, payload, sl, cloud);
      return;
    }
    if (isPermanentRejection(err)) {
      await cloud.nack({ id: req.id, attempt: req.attempts, kind: "permanent", error: msg(err) });
      return;
    }
    await cloud.nack({ id: req.id, attempt: req.attempts, kind: "transient", error: msg(err) });
    return;
  }

  let key: string;
  try {
    key = recordKey(created, CREATE_RESULT_KEY);
  } catch (err) {
    await cloud.nack({ id: req.id, attempt: req.attempts, kind: "transient", error: msg(err) });
    return;
  }

  try {
    const confirmed = await confirmGet(sl, payload.entity, key);
    await ackConfirmed(cloud, req.id, req.attempts, confirmed, CREATE_RESULT_KEY, key);
  } catch (err) {
    // Confirm GET failure: never ack.
    await cloud.nack({ id: req.id, attempt: req.attempts, kind: "transient", error: msg(err) });
  }
}

async function processCreate(
  req: RequestRow & { attempts: number },
  payload: WritePayload,
  sl: WriteServiceLayerPort,
  cloud: WriteCloudPort,
): Promise<void> {
  const idemp = payload.idempotency;
  if (!idemp) {
    await cloud.nack({
      id: req.id,
      attempt: req.attempts,
      kind: "permanent",
      error: "Create write missing idempotency anchor",
    });
    return;
  }

  if (req.attempts === 1) {
    await postAndConfirm(req, payload, sl, cloud);
    return;
  }

  // GET-before-POST on every redelivery.
  let lookup: DedupLookup;
  try {
    lookup = await sl.findByDedup(payload.entity, idemp.field, idemp.value, CREATE_RESULT_KEY);
  } catch (err) {
    if (err instanceof SlError && err.code === "DEDUP_AMBIGUOUS") {
      await cloud.nack({ id: req.id, attempt: req.attempts, kind: "permanent", error: msg(err) });
      return;
    }
    await cloud.nack({ id: req.id, attempt: req.attempts, kind: "transient", error: msg(err) });
    return;
  }

  if (lookup.status === "found") {
    await ackConfirmed(cloud, req.id, req.attempts, lookup.record, CREATE_RESULT_KEY);
    return;
  }

  await postAndConfirm(req, payload, sl, cloud);
}

async function processUpdate(
  req: RequestRow & { attempts: number },
  payload: WritePayload,
  sl: WriteServiceLayerPort,
  cloud: WriteCloudPort,
): Promise<void> {
  const key = payload.key;
  if (!key) {
    await cloud.nack({
      id: req.id,
      attempt: req.attempts,
      kind: "permanent",
      error: "Update write missing key",
    });
    return;
  }

  const replaceCollections = hasCollectionChange(payload.data);
  try {
    await sl.updateEntity(payload.entity, key, keyQuotedFor(key), payload.data, {
      replaceCollections,
    });
  } catch (err) {
    if (isPermanentRejection(err)) {
      await cloud.nack({ id: req.id, attempt: req.attempts, kind: "permanent", error: msg(err) });
      return;
    }
    await cloud.nack({ id: req.id, attempt: req.attempts, kind: "transient", error: msg(err) });
    return;
  }

  try {
    const confirmed = await confirmGet(sl, payload.entity, key);
    await ackConfirmed(cloud, req.id, req.attempts, confirmed, CREATE_RESULT_KEY, key);
  } catch (err) {
    await cloud.nack({ id: req.id, attempt: req.attempts, kind: "transient", error: msg(err) });
  }
}

export async function processWrite(
  request: RequestRow & { attempts: number; dedupKey: string },
  sl: WriteServiceLayerPort,
  cloud: WriteCloudPort,
): Promise<void> {
  const payload = request.payload as unknown as WritePayload;
  if (payload.operation === "create") {
    await processCreate(request, payload, sl, cloud);
    return;
  }
  if (payload.operation === "update") {
    await processUpdate(request, payload, sl, cloud);
    return;
  }
  await cloud.nack({
    id: request.id,
    attempt: request.attempts,
    kind: "permanent",
    error: `Unknown write operation '${String((payload as { operation?: string }).operation)}'`,
  });
}
