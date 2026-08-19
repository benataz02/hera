import { ORPCError } from "@orpc/server";
import { and, eq, sql } from "drizzle-orm";
import {
  db,
  agentRequest,
  type EnabledEntity,
  type EntityProfile,
} from "@hera/db";
import { outboxChannel } from "@hera/db/listener";

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
    selectionVersion: number;
  };
};

/** True when a write carries a configurator quotation origin (completed in sync.ack). */
export function isConfigDocumentOrigin(
  origin: WritePayload["origin"],
): origin is NonNullable<WritePayload["origin"]> {
  return origin?.kind === "config-document";
}

export type WriteState = {
  requestId: string;
  status: "pending" | "in_flight" | "done" | "failed";
  result?: unknown;
  docEntry?: string;
  error?: string;
};

export type WriteResult = {
  key: string;
  record: Record<string, unknown>;
};

const UI_ONLY = new Set(["priceSource", "__draftKey"]);

/**
 * Drop keys that are never writable document fields: local UI state, and the OData annotations
 * (`@odata.etag`, `Field@odata.type`) that ride along on every Service Layer read and land in the
 * draft. B1 field names are `[A-Za-z0-9_]`, so an `@` anywhere is unambiguously an annotation.
 */
function skipField(k: string): boolean {
  return UI_ONLY.has(k) || k.includes("@");
}

export type NormalizeWriteInput = {
  operation: "create" | "update";
  entity: string;
  key?: string;
  data: Record<string, unknown>;
  commandId: string;
  /** Server-only; never accepted from the browser. */
  origin?: WritePayload["origin"];
  schema: EnabledEntity;
  profile: EntityProfile;
  canCreate: boolean;
};

/** Profile-filter a write draft. Browser never chooses idempotency.field or trusted origin. */
export function normalizeWriteInput(input: NormalizeWriteInput): WritePayload {
  if (input.operation === "create" && !input.canCreate) {
    throw new ORPCError("FORBIDDEN", {
      message: "Create is disabled: no fresh matching create capability for this entity",
    });
  }
  if (input.operation === "update") {
    if (!input.key) {
      throw new ORPCError("BAD_REQUEST", { message: "Update requires key" });
    }
  }

  const editableHeader = new Set(input.profile.fields.editableHeader);
  const readOnly = new Set(input.profile.fields.readOnly);
  const schemaProps = new Set([
    ...input.schema.keys,
    ...input.schema.properties.map((p) => p.name),
  ]);
  const schemaColls = new Set(input.schema.collections.map((c) => c.name));
  const data: Record<string, unknown> = {};

  for (const [k, v] of Object.entries(input.data)) {
    if (skipField(k)) continue;
    if (k in input.profile.collections || schemaColls.has(k)) continue; // collections below
    if (readOnly.has(k)) continue; // form echo of computed/read-only — strip
    if (editableHeader.has(k)) {
      data[k] = v;
      continue;
    }
    if (schemaProps.has(k)) {
      throw new ORPCError("BAD_REQUEST", { message: `Field '${k}' is write-protected` });
    }
    throw new ORPCError("BAD_REQUEST", { message: `Unknown field '${k}'` });
  }

  for (const [name, collProfile] of Object.entries(input.profile.collections)) {
    const raw = input.data[name];
    if (raw === undefined) continue;
    if (!collProfile.editable) {
      throw new ORPCError("BAD_REQUEST", { message: `Collection '${name}' is write-protected` });
    }
    if (!Array.isArray(raw)) {
      throw new ORPCError("BAD_REQUEST", { message: `Collection '${name}' must be an array` });
    }
    const allowed = new Set(input.profile.fields.collectionEditable[name] ?? []);
    if (collProfile.rowKey) allowed.add(collProfile.rowKey);
    data[name] = raw.map((row) => {
      if (!row || typeof row !== "object" || Array.isArray(row)) {
        throw new ORPCError("BAD_REQUEST", { message: `Invalid row in '${name}'` });
      }
      const out: Record<string, unknown> = {};
      for (const [fk, fv] of Object.entries(row as Record<string, unknown>)) {
        if (skipField(fk)) continue;
        if (!allowed.has(fk)) continue; // strip non-editable line fields (LineTotal etc.)
        out[fk] = fv;
      }
      return out;
    });
  }

  for (const k of Object.keys(input.data)) {
    if (skipField(k) || readOnly.has(k) || editableHeader.has(k)) continue;
    if (k in input.profile.collections) continue;
    if (schemaColls.has(k)) {
      throw new ORPCError("BAD_REQUEST", { message: `Collection '${k}' is write-protected` });
    }
  }

  const payload: WritePayload = {
    operation: input.operation,
    entity: input.entity,
    commandId: input.commandId,
    data,
  };
  if (input.operation === "update") payload.key = input.key;
  if (input.origin) payload.origin = input.origin;

  if (input.operation === "create") {
    const create = input.profile.create;
    if (!create) {
      throw new ORPCError("FORBIDDEN", { message: "Entity profile does not support create" });
    }
    payload.idempotency = { field: create.dedupField, value: input.commandId };
    data[create.dedupField] = input.commandId;
  }

  return payload;
}

export function writeDedupKey(entity: string, commandId: string): string {
  return `write:${entity}:${commandId}`;
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

async function enqueueWriteInTx(
  tx: Tx,
  tenantId: string,
  payload: WritePayload,
): Promise<string> {
  const dedupKey = writeDedupKey(payload.entity, payload.commandId);
  const inserted = await tx
    .insert(agentRequest)
    .values({
      tenantId,
      kind: "write",
      payload: payload as unknown as Record<string, unknown>,
      dedupKey,
      status: "pending",
    })
    .onConflictDoNothing({ target: [agentRequest.tenantId, agentRequest.dedupKey] })
    .returning({ id: agentRequest.id });

  let id = inserted[0]?.id;
  if (!id) {
    const [existing] = await tx
      .select({ id: agentRequest.id })
      .from(agentRequest)
      .where(and(eq(agentRequest.tenantId, tenantId), eq(agentRequest.dedupKey, dedupKey)))
      .limit(1);
    if (!existing) throw new ORPCError("INTERNAL_SERVER_ERROR", { message: "Write enqueue race" });
    id = existing.id;
  }

  await tx.execute(sql`select pg_notify(${outboxChannel(tenantId)}, '')`);
  return id;
}

/** Insert-or-select the durable write row and ring the agent doorbell. Never parks / runRequest. */
export async function enqueueWrite(
  tenantId: string,
  payload: WritePayload,
  tx?: Tx,
): Promise<{ requestId: string }> {
  if (tx) {
    return { requestId: await enqueueWriteInTx(tx, tenantId, payload) };
  }
  const requestId = await db.transaction((inner) => enqueueWriteInTx(inner, tenantId, payload));
  return { requestId };
}

export async function loadWriteState(
  tenantId: string,
  requestId: string,
): Promise<WriteState> {
  const [row] = await db
    .select({
      id: agentRequest.id,
      status: agentRequest.status,
      result: agentRequest.result,
      docEntry: agentRequest.docEntry,
      lastError: agentRequest.lastError,
      kind: agentRequest.kind,
    })
    .from(agentRequest)
    .where(and(eq(agentRequest.id, requestId), eq(agentRequest.tenantId, tenantId)))
    .limit(1);
  if (!row || row.kind !== "write") {
    throw new ORPCError("NOT_FOUND", { message: "Write request not found" });
  }
  const state: WriteState = { requestId: row.id, status: row.status };
  if (row.result != null) state.result = row.result;
  if (row.docEntry != null) state.docEntry = row.docEntry;
  if (row.lastError != null) state.error = row.lastError;
  return state;
}
