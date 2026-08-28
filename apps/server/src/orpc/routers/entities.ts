import { ORPCError } from "@orpc/server";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { db, b1NavPin, ListVariantDefZ, type B1NavPin } from "@hera/db";
import { categoriesOf, categoryNames, coerceKey, countOf, rowsOf, type Key } from "@hera/b1";
import { adminProcedure } from "../base.ts";
import { tenantConnector, viaB1 } from "../../b1.ts";
import { assertEntity, entityList, entitySchema } from "../../entity-meta.ts";
import { compileList } from "../../entity-list.ts";
import { missingRequired, pickEditable, profileOf } from "../../entity-profiles.ts";
import { buildCopy, COPY_SELECT, findFlow, flowsFrom } from "../../doc-copy.ts";

// The B1 entity surface: list what B1 exposes, read a schema, page rows, open one row — for any
// entity set. Writing is different: update/create/copy work only on the curated entities in
// entity-profiles.ts, and only on the fields those profiles name. That rule lives in `curated()`
// below, not in whether a page happened to draw a button.
//
// adminProcedure: entity discovery (catalog, pins, generic browse) is admin/owner only. Live
// configurator lookups do not go through this router.

const EntityZ = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "must be an entity set name");
const KeyZ = z.union([z.string(), z.number(), z.record(z.string(), z.union([z.string(), z.number()]))]);

const b1Of = async (tenantId: string) => (await tenantConnector(tenantId)).b1;

/** Writes are curated-only, and the rule lives here rather than in whether the UI drew a button. */
const curated = (entity: string) => {
  const p = profileOf(entity);
  if (!p) throw new ORPCError("FORBIDDEN", { message: `${entity} is read-only in HERA` });
  return p;
};

const bad = (e: unknown): never => {
  throw e instanceof ORPCError
    ? e
    : new ORPCError("BAD_REQUEST", { message: e instanceof Error ? e.message : String(e) });
};

/** Schema decides string vs integer quoting — a digit-looking ItemCode is not an Int32 key. */
const keyed = async (tenantId: string, entity: string, raw: Key) => {
  const b1 = await b1Of(tenantId);
  const schema = await viaB1(() => entitySchema(tenantId, b1, entity)).catch(bad);
  try {
    return { b1, key: coerceKey(schema, raw) };
  } catch (e) {
    return bad(e);
  }
};

const PIN_CAP = 20;

const pinsOf = async (tenantId: string, userId: string): Promise<B1NavPin[]> => {
  const [row] = await db
    .select({ entities: b1NavPin.entities })
    .from(b1NavPin)
    .where(and(eq(b1NavPin.tenantId, tenantId), eq(b1NavPin.userId, userId)))
    .limit(1);
  return row?.entities ?? [];
};

export const entitiesRouter = {
  /** Every entity set B1 exposes, with its business categories for navigation. */
  list: adminProcedure
    .input(z.object({ category: z.string().optional(), search: z.string().optional(), refresh: z.boolean().optional() }).optional())
    .handler(async ({ input, context }) => {
      const b1 = await b1Of(context.tenantId);
      const all = await viaB1(() => entityList(context.tenantId, b1, input?.refresh));
      const q = input?.search?.trim().toLowerCase();
      const entities = all
        .map((e) => ({ ...e, categories: categoriesOf.get(e.name) ?? [e.entityClass === "standard" ? "other" : `user-defined-${e.entityClass === "udt" ? "table" : "object"}`] }))
        .filter((e) => !input?.category || e.categories.includes(input.category))
        .filter((e) => !q || e.name.toLowerCase().includes(q) || e.label.toLowerCase().includes(q) || e.table.toLowerCase().includes(q))
        .sort((a, b) => a.label.localeCompare(b.label));
      return { entities, categories: categoryNames() };
    }),

  /** One entity's fields, keys and lookups. Cached with a TTL; `refresh` re-reads $metadata. */
  schema: adminProcedure
    .input(z.object({ entity: EntityZ, refresh: z.boolean().optional() }))
    .handler(async ({ input, context }) => {
      const b1 = await b1Of(context.tenantId);
      return viaB1(() => entitySchema(context.tenantId, b1, input.entity, input.refresh)).catch(bad);
    }),

  /** One page of rows for a saved list view. The spec is compiled to OData here — the browser
   *  never sends a filter string. */
  rows: adminProcedure
    .input(z.object({
      entity: EntityZ,
      spec: ListVariantDefZ,
      top: z.number().int().min(1).max(500).default(50),
      skip: z.number().int().min(0).optional(),
      /** ask B1 for the total in the same read; only worth it on the first page */
      count: z.boolean().optional(),
    }))
    .handler(async ({ input, context }) => {
      const b1 = await b1Of(context.tenantId);
      const schema = await viaB1(() => entitySchema(context.tenantId, b1, input.entity)).catch(bad);
      let query;
      try {
        query = compileList(schema, input.spec, { top: input.top, skip: input.skip, count: input.count });
      } catch (e) {
        return bad(e);
      }
      const res = await viaB1(() => b1.readEntitySet(input.entity, query));
      const rows = rowsOf(res.data);
      return {
        rows,
        keys: schema.keys,
        total: countOf(res.data),
        // A full page probably means another one; one empty read at the end beats $count per page.
        nextSkip: rows.length === input.top ? (input.skip ?? 0) + rows.length : undefined,
      };
    }),

  /** One row, with its ETag — which is what makes a curated edit safe in Phase 3. */
  one: adminProcedure
    .input(z.object({ entity: EntityZ, key: KeyZ }))
    .handler(async ({ input, context }) => {
      const { b1, key } = await keyed(context.tenantId, input.entity, input.key);
      const res = await viaB1(() => b1.readEntity(input.entity, key));
      return { row: res.data as Record<string, unknown>, etag: res.etag ?? null };
    }),

  /** What a user may change here, if anything. Absent = a read-only generic entity. */
  profile: adminProcedure
    .input(z.object({ entity: EntityZ }))
    .handler(({ input }) => ({
      profile: profileOf(input.entity) ?? null,
      flows: flowsFrom(input.entity),
    })),

  /** Curated update. Requires the ETag read back with the row: without If-Match a concurrent
   *  edit is a silent overwrite, and B1 answers a stale one with 412 -> CONFLICT. */
  update: adminProcedure
    .input(z.object({
      entity: EntityZ,
      key: KeyZ,
      etag: z.string().min(1),
      data: z.record(z.string(), z.unknown()),
    }))
    .handler(async ({ input, context }) => {
      const profile = curated(input.entity);
      const { payload, rejected } = pickEditable(profile, input.data, { create: false });
      if (rejected.length)
        throw new ORPCError("BAD_REQUEST", { message: `Not editable on ${input.entity}: ${rejected.join(", ")}` });
      if (!Object.keys(payload).length)
        throw new ORPCError("BAD_REQUEST", { message: "Nothing to update" });

      const { b1, key } = await keyed(context.tenantId, input.entity, input.key);
      await viaB1(() => b1.updateEntity(input.entity, key, payload, { etag: input.etag }));
      // B1's PATCH answers 204; re-read so the caller gets the new ETag rather than a stale one.
      const fresh = await viaB1(() => b1.readEntity(input.entity, key));
      return { row: fresh.data as Record<string, unknown>, etag: fresh.etag ?? null };
    }),

  /** Curated create. `prefer: representation` means the created document comes back in one call. */
  create: adminProcedure
    .input(z.object({ entity: EntityZ, data: z.record(z.string(), z.unknown()) }))
    .handler(async ({ input, context }) => {
      const profile = curated(input.entity);
      const missing = missingRequired(profile, input.data);
      if (missing.length)
        throw new ORPCError("BAD_REQUEST", { message: `${input.entity} needs ${missing.join(", ")}` });
      const { payload, rejected } = pickEditable(profile, input.data, { create: true });
      if (rejected.length)
        throw new ORPCError("BAD_REQUEST", { message: `Not settable on ${input.entity}: ${rejected.join(", ")}` });

      const b1 = await b1Of(context.tenantId);
      await viaB1(() => assertEntity(context.tenantId, b1, input.entity)).catch(bad);
      const res = await viaB1(() => b1.createEntity(input.entity, payload, { prefer: "representation" }));
      return { row: res.data as Record<string, unknown>, etag: res.etag ?? null };
    }),

  /** Order -> Delivery -> Invoice and friends. The target lines carry BaseType/BaseEntry/BaseLine,
   *  which is what makes B1 close the source lines instead of creating an unlinked document. */
  copy: adminProcedure
    .input(z.object({
      sourceEntity: EntityZ,
      targetEntity: EntityZ,
      docEntry: z.number().int(),
      /** source line indexes; omitted copies every line */
      lines: z.array(z.number().int().min(0)).optional(),
      comments: z.string().max(2000).optional(),
    }))
    .handler(async ({ input, context }) => {
      const flow = findFlow(input.sourceEntity, input.targetEntity);
      if (!flow)
        throw new ORPCError("BAD_REQUEST", { message: `No document flow from ${input.sourceEntity} to ${input.targetEntity}` });

      const b1 = await b1Of(context.tenantId);
      const source = await viaB1(() => b1.readEntity(flow.source, input.docEntry, { select: COPY_SELECT }));
      let payload;
      try {
        payload = buildCopy(flow, source.data as Record<string, unknown>, { lines: input.lines, comments: input.comments });
      } catch (e) {
        return bad(e);
      }
      const res = await viaB1(() => b1.createEntity(flow.target, payload, { prefer: "representation" }));
      const row = res.data as Record<string, unknown>;
      return { entity: flow.target, docEntry: Number(row.DocEntry), docNum: row.DocNum ?? null, row };
    }),

  /** Entity sets this admin pinned onto the SAP sidenav group. Empty until the first pin. */
  navPins: adminProcedure.handler(async ({ context }) => ({
    entities: await pinsOf(context.tenantId, context.userId),
  })),

  /** Add or remove one pin. Names only — labels are a snapshot from the catalog at pin time. */
  setNavPin: adminProcedure
    .input(z.object({ name: EntityZ, label: z.string().min(1).max(200), pinned: z.boolean() }))
    .handler(async ({ input, context }) => {
      let entities = await pinsOf(context.tenantId, context.userId);
      const i = entities.findIndex((e) => e.name === input.name);
      if (input.pinned) {
        const next = { name: input.name, label: input.label };
        if (i >= 0) entities = entities.map((e, j) => (j === i ? next : e));
        else {
          if (entities.length >= PIN_CAP)
            throw new ORPCError("BAD_REQUEST", { message: `At most ${PIN_CAP} entities on the menu` });
          entities = [...entities, next];
        }
      } else if (i >= 0) {
        entities = entities.filter((e) => e.name !== input.name);
      }
      await db
        .insert(b1NavPin)
        .values({ tenantId: context.tenantId, userId: context.userId, entities, updatedAt: new Date() })
        .onConflictDoUpdate({
          target: [b1NavPin.tenantId, b1NavPin.userId],
          set: { entities, updatedAt: new Date() },
        });
      return { entities };
    }),
};
