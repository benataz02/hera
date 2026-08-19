import { ORPCError, eventIterator } from "@orpc/server";
import { z } from "zod/v4";
import { and, eq, or, sql } from "drizzle-orm";
import {
  db,
  agentRequest,
  tenantIntegration,
  uiVariant,
  FilterCondZ,
  ObjectVariantDefZ,
  type EnabledEntity,
  type EntitySchema,
  type ObjectVariantDef,
} from "@hera/db";
import { outboxChannel, requestChannel, waitForNotify } from "@hera/db/listener";
import { adminProcedure, userProcedure } from "../base.ts";
import { getEntityProfile } from "../../entity-profiles.ts";
import { compileObjectFetch } from "../../entity-fetch.ts";
import { ensureStandardVariants } from "../../seed-variants.ts";
import {
  assertEditableRecord,
  resolveWriteCapabilities,
  type WriteCapability,
} from "../../write-capabilities.ts";
import {
  enqueueWrite,
  loadWriteState,
  normalizeWriteInput,
  type WriteState,
} from "../../writes.ts";

const REQUEST_TIMEOUT_MS = 30_000;
const WAIT_CHUNK_MS = 5_000;
const NAME_RE = /^[A-Za-z0-9_]+$/;
// Agent long-polls (~25s/cycle) and stamps lastSeenAt each pull; 3 missed cycles => offline.
const AGENT_STALE_MS = 90_000;
const METADATA_CACHE_TTL_MS = 60_000;

/** Short in-process cache so setEnabled after discover can reuse schemas without a second hop. */
const metadataCache = new Map<string, { at: number; schemas: EntitySchema[] }>();

function putMetadataCache(tenantId: string, schemas: EntitySchema[]): void {
  metadataCache.set(tenantId, { at: Date.now(), schemas });
}

async function loadDiscoveredSchemas(tenantId: string): Promise<EntitySchema[]> {
  const hit = metadataCache.get(tenantId);
  if (hit && Date.now() - hit.at < METADATA_CACHE_TTL_MS) return hit.schemas;
  await assertAgentReady(tenantId);
  const schemas = (await runRequest(tenantId, "metadata", {})) as EntitySchema[];
  putMetadataCache(tenantId, schemas);
  return schemas;
}

// Fail fast with a clear reason instead of waiting out the request timeout when no agent is
// configured for this tenant, or the configured one isn't connected. (A timeout can't tell
// "agent is slow" from "no agent will ever answer this tenant".)
export async function assertAgentReady(tenantId: string): Promise<void> {
  const [ti] = await db
    .select({ lastSeenAt: tenantIntegration.lastSeenAt })
    .from(tenantIntegration)
    .where(eq(tenantIntegration.tenantId, tenantId))
    .limit(1);
  if (!ti) {
    throw new ORPCError("SERVICE_UNAVAILABLE", {
      message: "No on-prem agent is configured for this tenant. Provision one (bun run seed:agent <slug>) and start it.",
    });
  }
  const age = ti.lastSeenAt ? Date.now() - ti.lastSeenAt.getTime() : Infinity;
  if (age > AGENT_STALE_MS) {
    throw new ORPCError("SERVICE_UNAVAILABLE", {
      message: ti.lastSeenAt
        ? `The on-prem agent for this tenant is offline (last seen ${Math.round(age / 1000)}s ago). Start it and retry.`
        : "The on-prem agent for this tenant has never connected. Start it and retry.",
    });
  }
}

// Enqueue an on-demand request for the agent, ring its doorbell, then park on this request's
// reply channel until the agent fulfills/fails it (or we give up). Reuses the exact LISTEN/NOTIFY
// machinery the quote backbone uses — just a different table column for the result.
export async function runRequest(tenantId: string, kind: string, payload: Record<string, unknown>): Promise<unknown> {
  const [row] = await db
    .insert(agentRequest)
    .values({ tenantId, kind, payload })
    .returning({ id: agentRequest.id });
  const id = row!.id;
  await db.execute(sql`select pg_notify(${outboxChannel(tenantId)}, '')`);

  const deadline = Date.now() + REQUEST_TIMEOUT_MS;
  for (;;) {
    const [r] = await db
      .select({ status: agentRequest.status, result: agentRequest.result, lastError: agentRequest.lastError })
      .from(agentRequest)
      .where(eq(agentRequest.id, id))
      .limit(1);
    if (!r) throw new ORPCError("NOT_FOUND");
    if (r.status === "done") return r.result;
    if (r.status === "failed") throw new ORPCError("BAD_GATEWAY", { message: r.lastError ?? "Agent error" });
    if (Date.now() >= deadline) {
      throw new ORPCError("TIMEOUT", { message: "The on-prem agent did not respond. Is it running?" });
    }
    await waitForNotify(requestChannel(id), Math.min(WAIT_CHUNK_MS, deadline - Date.now()));
  }
}

const OrderByZ = z.object({ field: z.string(), dir: z.enum(["asc", "desc"]) });

async function loadEnabled(tenantId: string, name: string): Promise<EnabledEntity> {
  const [row] = await db
    .select({ enabledEntities: tenantIntegration.enabledEntities })
    .from(tenantIntegration)
    .where(eq(tenantIntegration.tenantId, tenantId))
    .limit(1);
  const e = (row?.enabledEntities ?? []).find((x) => x.name === name);
  if (!e) throw new ORPCError("FORBIDDEN", { message: `Entity '${name}' is not enabled` });
  return e;
}

async function assertEditable(tenantId: string, name: string): Promise<EnabledEntity> {
  const e = await loadEnabled(tenantId, name);
  if (!e.editable) throw new ORPCError("FORBIDDEN", { message: `Entity '${name}' is read-only` });
  return e;
}

// B1 URL key predicate: string/guid keys are quoted — ('CODE'); numeric keys are bare — (123).
function keyQuoted(e: EnabledEntity): boolean {
  const keyProp = e.properties.find((p) => p.name === e.keys[0]);
  return !keyProp || /string|guid/i.test(keyProp.type);
}

/** Visible string columns for global `q` search — never fetch-only identity keys. */
export function buildListSearchFields(
  properties: Array<{ name: string; type: string }>,
  visibleSelect: string[] | undefined,
  q: string | undefined,
): string[] {
  if (!q) return [];
  const visible = visibleSelect?.length ? new Set(visibleSelect) : null;
  return properties
    .filter((p) => /string/i.test(p.type) && (!visible || visible.has(p.name)))
    .map((p) => p.name);
}

type DocumentFamily = "sales-document" | "purchase-document";

const ITEM_COMMON = ["ItemCode", "ItemName", "DefaultWarehouse"] as const;

const SALES_ITEM_SELECT = [
  ...ITEM_COMMON,
  "SalesUnit",
  "SalesVATGroup",
  "SalesUnitLength",
  "SalesUnitWidth",
  "SalesUnitHeight",
  "SalesUnitVolume",
  "SalesUnitWeight",
  "SalesFactor1",
  "SalesFactor2",
  "SalesFactor3",
  "SalesFactor4",
] as const;

const PURCHASE_ITEM_SELECT = [
  ...ITEM_COMMON,
  "PurchaseUnit",
  "PurchaseVATGroup",
  "PurchaseUnitLength",
  "PurchaseUnitWidth",
  "PurchaseUnitHeight",
  "PurchaseUnitVolume",
  "PurchaseUnitWeight",
  "PurchaseFactor1",
  "PurchaseFactor2",
  "PurchaseFactor3",
  "PurchaseFactor4",
] as const;

/** Profiled Item $select — browser cannot choose these. */
export function profiledItemSelect(family: DocumentFamily): string[] {
  return family === "sales-document" ? [...SALES_ITEM_SELECT] : [...PURCHASE_ITEM_SELECT];
}

type PropLookup = { entitySet: string; valueField: string; labelField?: string };

/** Resolve a validated lookup from header or collection property metadata. */
export function resolveLookupTarget(
  schema: EnabledEntity,
  field: string,
): { entitySet: string; valueField: string; labelField: string } {
  const fromHeader = schema.properties.find((p) => p.name === field);
  let lookup: PropLookup | undefined = fromHeader?.lookup;
  if (!lookup) {
    for (const col of schema.collections) {
      const p = col.properties.find((x) => x.name === field);
      if (p) {
        lookup = p.lookup;
        break;
      }
    }
  }
  if (!lookup) {
    throw new ORPCError("BAD_REQUEST", {
      message: `Field '${field}' has no authorized lookup on entity '${schema.name}'`,
    });
  }
  return {
    entitySet: lookup.entitySet,
    valueField: lookup.valueField,
    labelField: lookup.labelField ?? lookup.valueField,
  };
}

/** Map selected Item master fields onto DocumentLine defaults by family. */
export function mapItemDefaults(
  item: Record<string, unknown>,
  family: DocumentFamily,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (item.ItemCode != null) out.ItemCode = item.ItemCode;
  if (item.ItemName != null) out.ItemDescription = item.ItemName;
  if (item.DefaultWarehouse != null) out.WarehouseCode = item.DefaultWarehouse;

  if (family === "sales-document") {
    if (item.SalesUnit != null) out.UoMCode = item.SalesUnit;
    if (item.SalesVATGroup != null) out.TaxCode = item.SalesVATGroup;
    if (item.SalesUnitLength != null) out.Length1 = item.SalesUnitLength;
    if (item.SalesUnitWidth != null) out.Width1 = item.SalesUnitWidth;
    if (item.SalesUnitHeight != null) out.Height1 = item.SalesUnitHeight;
    if (item.SalesUnitVolume != null) out.Volume = item.SalesUnitVolume;
    if (item.SalesUnitWeight != null) out.Weight1 = item.SalesUnitWeight;
    if (item.SalesFactor1 != null) out.Factor1 = item.SalesFactor1;
    if (item.SalesFactor2 != null) out.Factor2 = item.SalesFactor2;
    if (item.SalesFactor3 != null) out.Factor3 = item.SalesFactor3;
    if (item.SalesFactor4 != null) out.Factor4 = item.SalesFactor4;
  } else {
    if (item.PurchaseUnit != null) out.UoMCode = item.PurchaseUnit;
    if (item.PurchaseVATGroup != null) out.TaxCode = item.PurchaseVATGroup;
    if (item.PurchaseUnitLength != null) out.Length1 = item.PurchaseUnitLength;
    if (item.PurchaseUnitWidth != null) out.Width1 = item.PurchaseUnitWidth;
    if (item.PurchaseUnitHeight != null) out.Height1 = item.PurchaseUnitHeight;
    if (item.PurchaseUnitVolume != null) out.Volume = item.PurchaseUnitVolume;
    if (item.PurchaseUnitWeight != null) out.Weight1 = item.PurchaseUnitWeight;
    if (item.PurchaseFactor1 != null) out.Factor1 = item.PurchaseFactor1;
    if (item.PurchaseFactor2 != null) out.Factor2 = item.PurchaseFactor2;
    if (item.PurchaseFactor3 != null) out.Factor3 = item.PurchaseFactor3;
    if (item.PurchaseFactor4 != null) out.Factor4 = item.PurchaseFactor4;
  }
  return out;
}

export type ItemContextClientInput = {
  family: "sales-document" | "purchase-document" | "master-data";
  itemCode: string;
  cardCode?: string;
  inventoryQuantity?: number;
  uomEntry?: number;
  uomQuantity?: number;
  date?: string;
  currency?: string;
  priceList?: number;
};

/** Fixed agent payload for item-context — select + InventoryQuantity price params. */
export function buildItemContextAgentPayload(input: ItemContextClientInput): {
  itemCode: string;
  select: string[];
  price: {
    itemCode: string;
    cardCode?: string;
    inventoryQuantity?: number;
    uomEntry?: number;
    uomQuantity?: number;
    date?: string;
    currency?: string;
    priceList?: number;
  };
} {
  if (input.family !== "sales-document" && input.family !== "purchase-document") {
    throw new ORPCError("BAD_REQUEST", {
      message: "itemContext is only available for sales/purchase document entities",
    });
  }
  return {
    itemCode: input.itemCode,
    select: profiledItemSelect(input.family),
    price: {
      itemCode: input.itemCode,
      cardCode: input.cardCode,
      inventoryQuantity: input.inventoryQuantity,
      uomEntry: input.uomEntry,
      uomQuantity: input.uomQuantity,
      date: input.date,
      currency: input.currency,
      priceList: input.priceList,
    },
  };
}

export const entitiesRouter = {
  // Any member: open the agent's B1 Service Layer session up front (once, after sign-in) so the
  // first real query skips the /Login round-trip. Fire-and-forget: the agent logs in lazily anyway,
  // so a failed pre-warm (agent offline, B1 down) returns { ok: false } instead of a 5xx that would
  // paint a bogus error in the browser console.
  login: userProcedure.handler(async ({ context }) => {
    try {
      await assertAgentReady(context.tenantId);
      await runRequest(context.tenantId, "login", {});
      return { ok: true };
    } catch {
      return { ok: false };
    }
  }),

  // Admin: ask the agent for the B1 $metadata catalog (entity sets + their field schemas).
  discover: adminProcedure.handler(async ({ context }) => {
    await assertAgentReady(context.tenantId);
    const schemas = (await runRequest(context.tenantId, "metadata", {})) as EntitySchema[];
    putMetadataCache(context.tenantId, schemas);
    return schemas;
  }),

  // Admin: persist chosen entity names + editable flags. Schemas come from a fresh (or cached)
  // discovery — never from the browser — so invented properties cannot become authorization.
  setEnabled: adminProcedure
    .input(
      z.object({
        entities: z.array(z.object({ name: z.string(), editable: z.boolean() })),
      }),
    )
    .handler(async ({ input, context }) => {
      for (const e of input.entities) {
        if (!NAME_RE.test(e.name)) throw new ORPCError("BAD_REQUEST", { message: `Bad entity name '${e.name}'` });
      }
      const discovered = await loadDiscoveredSchemas(context.tenantId);
      const byName = new Map(discovered.map((s) => [s.name, s]));
      const enabled: EnabledEntity[] = [];
      for (const sel of input.entities) {
        const schema = byName.get(sel.name);
        if (!schema) {
          throw new ORPCError("BAD_REQUEST", {
            message: `Entity '${sel.name}' was not found in Service Layer metadata`,
          });
        }
        enabled.push({ ...schema, editable: sel.editable });
      }
      await db
        .update(tenantIntegration)
        .set({ enabledEntities: enabled })
        .where(eq(tenantIntegration.tenantId, context.tenantId));
      for (const e of enabled) {
        await ensureStandardVariants(
          context.tenantId,
          context.userId,
          e.name,
          e,
          getEntityProfile(e.name),
        );
      }
      return { ok: true };
    }),

  // Any member: the enabled list drives the side-nav + form schemas. No agent hop.
  getEnabled: userProcedure.handler(async ({ context }) => {
    const [row] = await db
      .select({ enabledEntities: tenantIntegration.enabledEntities })
      .from(tenantIntegration)
      .where(eq(tenantIntegration.tenantId, context.tenantId))
      .limit(1);
    return row?.enabledEntities ?? [];
  }),

  // Create/edit gates from profile + last agent capability report (stale → create off, update ok).
  capabilities: userProcedure
    .input(z.object({ entity: z.string() }))
    .handler(async ({ input, context }) => {
      await loadEnabled(context.tenantId, input.entity);
      const [row] = await db
        .select({
          writeCapabilities: tenantIntegration.writeCapabilities,
          writeCapabilitiesCheckedAt: tenantIntegration.writeCapabilitiesCheckedAt,
          lastSeenAt: tenantIntegration.lastSeenAt,
        })
        .from(tenantIntegration)
        .where(eq(tenantIntegration.tenantId, context.tenantId))
        .limit(1);
      return resolveWriteCapabilities({
        entity: input.entity,
        profile: getEntityProfile(input.entity),
        writeCapabilities: (row?.writeCapabilities ?? null) as WriteCapability[] | null,
        checkedAt: row?.writeCapabilitiesCheckedAt ?? null,
        lastSeenAt: row?.lastSeenAt ?? null,
      });
    }),

  list: userProcedure
    .input(
      z.object({
        entity: z.string(),
        top: z.number().int().min(1).max(1000).default(100),
        skip: z.number().int().min(0).default(0),
        q: z.string().optional(),
        // The saved view's OData call. Field names are validated against the schema below — never
        // trusted raw — and each filter field's Edm type is attached so the agent encodes literals.
        select: z.array(z.string()).optional(),
        filter: z.array(FilterCondZ).optional(),
        orderby: z.array(OrderByZ).optional(),
      }),
    )
    .handler(async ({ input, context }) => {
      const e = await loadEnabled(context.tenantId, input.entity);
      const propByName = new Map(e.properties.map((p) => [p.name, p]));
      const assertField = (name: string) => {
        if (!propByName.has(name)) throw new ORPCError("BAD_REQUEST", { message: `Unknown field '${name}'` });
      };
      for (const f of input.select ?? []) assertField(f);
      for (const o of input.orderby ?? []) assertField(o.field);
      const filter = (input.filter ?? []).map((c) => {
        assertField(c.field);
        return { ...c, type: propByName.get(c.field)!.type };
      });
      // Defense in depth: always include schema keys in $select so row identity survives a
      // view that hides them. Client sends visible columns only in `select`.
      const select = input.select?.length
        ? [...new Set([...e.keys, ...input.select])]
        : undefined;
      // Search from the client's visible select (pre key-union) so hidden string keys stay non-searchable.
      const fields = buildListSearchFields(e.properties, input.select, input.q);
      return (await runRequest(context.tenantId, "list", { ...input, select, fields, filter })) as {
        rows: Record<string, unknown>[];
        count: number | null;
        hasMore: boolean;
      };
    }),

  // Load authorized object variant server-side, compile projection, send only validated fetch to agent.
  get: userProcedure
    .input(z.object({ entity: z.string(), key: z.string(), variantId: z.string().uuid() }))
    .handler(async ({ input, context }) => {
      const e = await loadEnabled(context.tenantId, input.entity);
      const [variant] = await db
        .select({
          definition: uiVariant.definition,
          entity: uiVariant.entity,
          page: uiVariant.page,
          userId: uiVariant.userId,
          shared: uiVariant.shared,
        })
        .from(uiVariant)
        .where(
          and(
            eq(uiVariant.id, input.variantId),
            eq(uiVariant.tenantId, context.tenantId),
            or(eq(uiVariant.userId, context.userId), eq(uiVariant.shared, true)),
          ),
        )
        .limit(1);
      if (!variant || variant.page !== "object" || variant.entity !== input.entity) {
        throw new ORPCError("NOT_FOUND", { message: "Object variant not found" });
      }
      const parsed = ObjectVariantDefZ.safeParse(variant.definition);
      if (!parsed.success) {
        throw new ORPCError("BAD_REQUEST", { message: "Object variant definition is invalid" });
      }
      const definition = parsed.data as ObjectVariantDef;
      const profile = getEntityProfile(input.entity);
      let compiled;
      try {
        compiled = compileObjectFetch(e, profile, definition);
      } catch (err) {
        throw new ORPCError("BAD_REQUEST", {
          message: err instanceof Error ? err.message : String(err),
        });
      }
      const record = (await runRequest(context.tenantId, "object-get", {
        entity: input.entity,
        key: input.key,
        keyQuoted: keyQuoted(e),
        ...compiled,
      })) as Record<string, unknown>;
      return { record, schema: e, profile };
    }),

  // Sealed: blind POST create/update is gone. Use entities.write (kind="write") only.
  create: userProcedure
    .input(z.object({ entity: z.string(), data: z.record(z.string(), z.unknown()) }))
    .handler(async () => {
      throw new ORPCError("FORBIDDEN", {
        message: "entities.create is removed; use entities.write with operation create",
      });
    }),

  update: userProcedure
    .input(z.object({ entity: z.string(), key: z.string(), data: z.record(z.string(), z.unknown()) }))
    .handler(async () => {
      throw new ORPCError("FORBIDDEN", {
        message: "entities.update is removed; use entities.write with operation update",
      });
    }),

  // Durable create/update. Returns immediately; browser never supplies idempotency.field or origin.
  write: userProcedure
    .input(
      z.object({
        operation: z.enum(["create", "update"]),
        entity: z.string(),
        key: z.string().optional(),
        data: z.record(z.string(), z.unknown()),
        commandId: z.string().min(1),
      }),
    )
    .handler(async ({ input, context }) => {
      const e = await assertEditable(context.tenantId, input.entity);
      const profile = getEntityProfile(input.entity);
      if (!profile) {
        throw new ORPCError("BAD_REQUEST", { message: `No profile for entity '${input.entity}'` });
      }
      const [row] = await db
        .select({
          writeCapabilities: tenantIntegration.writeCapabilities,
          writeCapabilitiesCheckedAt: tenantIntegration.writeCapabilitiesCheckedAt,
          lastSeenAt: tenantIntegration.lastSeenAt,
        })
        .from(tenantIntegration)
        .where(eq(tenantIntegration.tenantId, context.tenantId))
        .limit(1);
      const caps = resolveWriteCapabilities({
        entity: input.entity,
        profile,
        writeCapabilities: (row?.writeCapabilities ?? null) as WriteCapability[] | null,
        checkedAt: row?.writeCapabilitiesCheckedAt ?? null,
        lastSeenAt: row?.lastSeenAt ?? null,
      });
      if (input.operation === "update") {
        if (!caps.canEdit) {
          throw new ORPCError("FORBIDDEN", { message: caps.reason ?? "Edit disabled" });
        }
        // Enforce profile editWhen on submitted data (missing lock fields fail closed).
        assertEditableRecord(profile, input.data);
      }
      const payload = normalizeWriteInput({
        operation: input.operation,
        entity: input.entity,
        key: input.key,
        data: input.data,
        commandId: input.commandId,
        schema: e,
        profile,
        canCreate: caps.canCreate,
      });
      return enqueueWrite(context.tenantId, payload);
    }),

  watchWrite: userProcedure
    .input(z.object({ requestId: z.string().uuid() }))
    .output(
      eventIterator(
        z.object({
          requestId: z.string(),
          status: z.enum(["pending", "in_flight", "done", "failed"]),
          result: z.unknown().optional(),
          docEntry: z.string().optional(),
          error: z.string().optional(),
        }),
      ),
    )
    .handler(async function* ({ input, context, signal }): AsyncGenerator<WriteState> {
      for (;;) {
        const state = await loadWriteState(context.tenantId, input.requestId);
        yield state;
        if (state.status === "done" || state.status === "failed") return;
        if (signal?.aborted) return;
        // Arm LISTEN first, then re-read so an ack that raced the yield is not missed.
        const woke = waitForNotify(requestChannel(input.requestId), WAIT_CHUNK_MS);
        const latest = await loadWriteState(context.tenantId, input.requestId);
        if (latest.status !== state.status) {
          // Drop the parked waiter; next loop iteration yields the new state.
          void woke;
          continue;
        }
        await woke;
        if (signal?.aborted) return;
      }
    }),

  // Validated remote value help: source schema authorizes target entity + key/label fields.
  valueHelp: userProcedure
    .input(
      z.object({
        entity: z.string(),
        field: z.string(),
        search: z.string().default(""),
        skip: z.number().int().min(0).default(0),
      }),
    )
    .handler(async ({ input, context }) => {
      const e = await loadEnabled(context.tenantId, input.entity);
      const target = resolveLookupTarget(e, input.field);
      await assertAgentReady(context.tenantId);
      return (await runRequest(context.tenantId, "lookup", {
        entity: target.entitySet,
        keyField: target.valueField,
        labelField: target.labelField,
        search: input.search,
        skip: input.skip,
        top: 50,
      })) as {
        rows: Array<{ key: string; label: string; defaults?: Record<string, unknown> }>;
        hasMore: boolean;
      };
    }),

  // Item master defaults + GetItemPrice. Server picks select + sales/purchase mapping.
  itemContext: userProcedure
    .input(
      z.object({
        entity: z.string(),
        itemCode: z.string().min(1),
        cardCode: z.string().optional(),
        inventoryQuantity: z.number().optional(),
        uomEntry: z.number().optional(),
        uomQuantity: z.number().optional(),
        date: z.string().optional(),
        currency: z.string().optional(),
        priceList: z.number().optional(),
      }),
    )
    .handler(async ({ input, context }) => {
      await loadEnabled(context.tenantId, input.entity);
      const profile = getEntityProfile(input.entity);
      if (!profile || (profile.family !== "sales-document" && profile.family !== "purchase-document")) {
        throw new ORPCError("BAD_REQUEST", {
          message: `Entity '${input.entity}' does not support item context`,
        });
      }
      const payload = buildItemContextAgentPayload({
        family: profile.family,
        itemCode: input.itemCode,
        cardCode: input.cardCode,
        inventoryQuantity: input.inventoryQuantity,
        uomEntry: input.uomEntry,
        uomQuantity: input.uomQuantity,
        date: input.date,
        currency: input.currency,
        priceList: input.priceList,
      });
      await assertAgentReady(context.tenantId);
      const raw = (await runRequest(context.tenantId, "item-context", payload)) as {
        defaults: Record<string, unknown>;
        price?: { value: number; currency?: string; discount?: number };
      };
      const defaults = mapItemDefaults(raw.defaults ?? {}, profile.family);
      if (raw.price?.value != null) {
        defaults.UnitPrice = raw.price.value;
        if (raw.price.discount != null) defaults.DiscountPercent = raw.price.discount;
      }
      return { defaults, price: raw.price };
    }),
};
