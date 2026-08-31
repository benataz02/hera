import { ORPCError } from "@orpc/server";
import { z } from "zod";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import {
  db, configModel, configProject, configRun, ListVariantDefZ, member, organization, portalClient, uiVariant, user,
  type ProjectEvent, type RunCandidate,
} from "@hera/db";
import { EntriesZ, type Entries, type ModelDef } from "@hera/config-engine";
import { escapeLiteral, type B1EntitySchema } from "@hera/b1";
import { adminProcedure, baseDomain, clientProcedure, sessionProcedure } from "../base.ts";
import { hashToken } from "../../crypto.ts";
import { tenantSlugFromHost } from "../../tenant.ts";
import { tenantConnector, viaB1 } from "../../b1.ts";
import { entitySchema } from "../../entity-meta.ts";
import { bad, readOne, readRows } from "../../entity-read.ts";
import { printDocument } from "../../print.ts";
import {
  applySelection, cachedLookups, executeRun, loadModel, modelRunner, pushEvent,
  QueryPageZ, queryTablePage,
} from "./configs.ts";

import { ExtractFileZ, extractSuggestions } from "./extraction.ts";
import { enrichLookups } from "../../lookups.ts";

// The client portal API. Trust model: every clientProcedure handler is scoped by
// tenantId + the client's bound CardCode + source='portal'; responses pass through
// mappers that NAME the allowed fields, so schema growth can't leak cost data.

const INVITE_TTL_MS = 7 * 24 * 3600 * 1000;

// --- Admin side: invites are rows in portal_client (invite and binding are one row) ---
export const portalClientsRouter = {
  invite: adminProcedure
    .input(z.object({ email: z.email(), cardCode: z.string().min(1), cardName: z.string().min(1) }))
    .handler(async ({ input, context }) => {
      const email = input.email.toLowerCase();
      const [existing] = await db
        .select({ role: member.role })
        .from(member)
        .innerJoin(user, eq(user.id, member.userId))
        .where(and(eq(member.organizationId, context.tenantId), eq(user.email, email)))
        .limit(1);
      if (existing)
        throw new ORPCError("BAD_REQUEST", { message: `${email} already has access to this workspace` });
      const token = randomBytes(32).toString("hex");
      await db.insert(portalClient).values({
        tenantId: context.tenantId, email,
        cardCode: input.cardCode, cardName: input.cardName,
        inviteTokenHash: hashToken(token),
      });
      // ponytail: copy-link invites; email provider when onboarding volume demands
      return { token }; // shown once — the web client builds the accept URL from its own origin
    }),

  list: adminProcedure.handler(({ context }) =>
    db
      .select({
        id: portalClient.id, email: portalClient.email,
        cardCode: portalClient.cardCode, cardName: portalClient.cardName,
        invitedAt: portalClient.invitedAt, acceptedAt: portalClient.acceptedAt,
      })
      .from(portalClient)
      .where(eq(portalClient.tenantId, context.tenantId))
      .orderBy(desc(portalClient.invitedAt)),
  ),

  // Pending invite: delete the row. Active client: also delete the member row (access gone at once).
  revoke: adminProcedure.input(z.object({ id: z.uuid() })).handler(async ({ input, context }) => {
    await db.transaction(async (tx) => {
      const [row] = await tx
        .delete(portalClient)
        .where(and(eq(portalClient.id, input.id), eq(portalClient.tenantId, context.tenantId)))
        .returning({ userId: portalClient.userId });
      if (row?.userId) {
        await tx
          .delete(member)
          .where(and(eq(member.organizationId, context.tenantId), eq(member.userId, row.userId)));
      }
    });
    return { ok: true };
  }),
};

// Every portal read/write is fenced by tenant + the client's CardCode + source='portal'.
const ownProject = (id: string, ctx: { tenantId: string; cardCode: string }) =>
  and(
    eq(configProject.id, id),
    eq(configProject.tenantId, ctx.tenantId),
    eq(configProject.source, "portal"),
    sql`${configProject.customer}->>'cardCode' = ${ctx.cardCode}`,
  );

const EDITABLE = ["draft", "calculated"] as const;

const event = (kind: ProjectEvent["kind"], note?: string): ProjectEvent =>
  ({ at: new Date().toISOString(), kind, ...(note ? { note } : {}) });

const UNAVAILABLE = "This product is no longer available — contact your supplier.";

// Explicit allow-list mapper: future Outputs fields can't leak by default.
export type PortalCandidate = {
  assignment: Entries;
  perBatch: { batchQty: number; unitPrice: number; total: number }[];
};
const toPortalCandidate = (c: RunCandidate): PortalCandidate => ({
  assignment: c.assignment,
  perBatch: c.perBatch.map((b) => ({ batchQty: b.batchQty, unitPrice: b.outputs.unitPrice, total: b.outputs.batchTotal })),
});

// The form/propagate need parameters/structure/computed/constraints — never cost expressions.
// Explicit allow-list (no `...d` spread): a future ModelDef field defaults to excluded, not leaked.
const toPortalModelDef = (d: ModelDef): ModelDef => ({
  name: d.name,
  parameters: d.parameters,
  structure: d.structure,
  computed: d.computed,
  constraints: d.constraints,
  queryTables: d.queryTables,
  batchDefaults: d.batchDefaults,
  extraction: d.extraction,
  bom: [],
  routing: [],
  pricing: { priceExpr: "0", quoteItemCode: "portal" },
});

/** Load a project through the CardCode fence, or NOT_FOUND. */
async function loadOwnProject(id: string, ctx: { tenantId: string; cardCode: string }) {
  const [p] = await db.select().from(configProject).where(ownProject(id, ctx)).limit(1);
  if (!p) throw new ORPCError("NOT_FOUND");
  return p;
}

// --- The client's own SAP documents ------------------------------------------------------------
// Four entity sets, read-only, always fenced to the caller's CardCode.
//
// The fence is this list, not the seeded variant. A variant is UI; this is the boundary.
export const PORTAL_ENTITIES = new Set(["Quotations", "Orders", "DeliveryNotes", "Invoices"]);

// DocumentLines is on the header list because it is a field of the document; its own columns are
// PORTAL_LINE. CardCode is deliberately absent: the client IS the card, and leaving it out of the
// schema is what makes it impossible for a client to filter, sort or select on it.
export const PORTAL_DOC = [
  "DocEntry", "DocNum", "DocDate", "DocDueDate", "DocumentStatus",
  "DocTotal", "DocCurrency", "NumAtCard", "Comments", "DocumentLines",
] as const;
export const PORTAL_LINE = [
  "LineNum", "ItemCode", "ItemDescription", "Quantity", "UnitPrice", "LineTotal",
] as const;

/**
 * The client's view of a sales document, as a schema.
 *
 * Making the allowlist *be* the schema means compileList's existing rules do the fencing and
 * there is no second policy to keep in step: a `select` naming a hidden field is silently
 * dropped (a saved view outliving a field should still open), a `filter` naming one throws
 * (dropping it would show MORE rows than were asked for), and free-text search only reaches
 * allowed string columns.
 */
export function portalSchema(schema: B1EntitySchema): B1EntitySchema {
  const doc = new Set<string>(PORTAL_DOC);
  const line = new Set<string>(PORTAL_LINE);
  return {
    ...schema,
    fields: schema.fields
      .filter((f) => doc.has(f.name))
      .map((f) => (f.kind === "collection" && f.fields ? { ...f, fields: f.fields.filter((x) => line.has(x.name)) } : f)),
  };
}

/** Explicit allow-list projection of one document. Mirrors portalSchema for the response body:
 *  a read that came back wide (readEntity takes no $select here — see docs.one) still leaves
 *  narrow. A new B1 field defaults to excluded, not leaked. */
function projectDoc(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of PORTAL_DOC) {
    if (!(k in row)) continue;
    if (k === "DocumentLines" && Array.isArray(row[k])) {
      out[k] = (row[k] as Record<string, unknown>[]).map((l) =>
        Object.fromEntries(PORTAL_LINE.filter((f) => f in l).map((f) => [f, l[f]])));
    } else {
      out[k] = row[k];
    }
  }
  return out;
}

const PortalEntityZ = z.string().refine((e) => PORTAL_ENTITIES.has(e), "Not a portal document");

/** Transport + the filtered schema for one portal entity. */
async function portalEntity(tenantId: string, entity: string) {
  const { b1 } = await tenantConnector(tenantId);
  const full = await viaB1(() => entitySchema(tenantId, b1, entity)).catch(bad);
  return { b1, schema: portalSchema(full) };
}

/** `CardCode eq '…'`, appended to the COMPILED filter. Not to the spec: CardCode is not in the
 *  portal schema, so a client cannot name it, and compileList never sees this clause. */
const cardFence = (cardCode: string) => `CardCode eq '${escapeLiteral(cardCode)}'`;

// --- Client side ---
export const portalRouter = {
  // Session-only: the invitee has no membership yet. Tenant comes from the host subdomain.
  acceptInvite: sessionProcedure.input(z.object({ token: z.string().min(1) })).handler(async ({ input, context }) => {
    const host = context.headers.get("x-forwarded-host") ?? context.headers.get("host");
    const slug = tenantSlugFromHost(host, baseDomain);
    if (!slug) throw new ORPCError("BAD_REQUEST", { message: "No tenant subdomain" });
    const [org] = await db.select({ id: organization.id }).from(organization).where(eq(organization.slug, slug)).limit(1);
    if (!org) throw new ORPCError("NOT_FOUND", { message: "This invite link is invalid." });

    const [inv] = await db
      .select()
      .from(portalClient)
      .where(and(eq(portalClient.inviteTokenHash, hashToken(input.token)), eq(portalClient.tenantId, org.id)))
      .limit(1);
    if (!inv) throw new ORPCError("NOT_FOUND", { message: "This invite link is invalid or was revoked." });
    if (inv.acceptedAt) throw new ORPCError("BAD_REQUEST", { message: "This invite link was already used." });
    if (Date.now() - inv.invitedAt.getTime() > INVITE_TTL_MS)
      throw new ORPCError("BAD_REQUEST", { message: "This invite link has expired — ask your supplier for a new one." });

    const [m] = await db
      .select({ role: member.role })
      .from(member)
      .where(and(eq(member.organizationId, org.id), eq(member.userId, context.user.id)))
      .limit(1);
    if (m)
      throw new ORPCError("BAD_REQUEST", {
        message: m.role === "client" ? "This account already has portal access." : "This account is already a member of this workspace.",
      });

    await db.transaction(async (tx) => {
      // Guarded claim: only the first concurrent acceptInvite for this token wins.
      // A loser's UPDATE affects 0 rows once the winner commits, so we never create
      // an orphaned member row for a token that was already claimed.
      const claimed = await tx
        .update(portalClient)
        .set({ userId: context.user.id, acceptedAt: new Date() })
        .where(and(eq(portalClient.id, inv.id), isNull(portalClient.acceptedAt)))
        .returning({ id: portalClient.id });
      if (!claimed.length) throw new ORPCError("BAD_REQUEST", { message: "This invite link was already used." });
      await tx.insert(member).values({
        id: crypto.randomUUID(), organizationId: org.id, userId: context.user.id, role: "client", createdAt: new Date(),
      });
    });
    return { ok: true };
  }),

  models: {
    // The client's catalog: published models only.
    list: clientProcedure.handler(({ context }) =>
      db
        .select({ id: configModel.id, name: configModel.name, portalDescription: configModel.portalDescription })
        .from(configModel)
        .where(and(eq(configModel.tenantId, context.tenantId), eq(configModel.portal, true)))
        .orderBy(configModel.name),
    ),
  },

  projects: {
    list: clientProcedure.handler(({ context }) =>
      db
        .select({
          id: configProject.id, name: configProject.name, status: configProject.status,
          modelName: configModel.name, updatedAt: configProject.updatedAt,
        })
        .from(configProject)
        .innerJoin(configModel, eq(configModel.id, configProject.modelId))
        .where(and(
          eq(configProject.tenantId, context.tenantId),
          eq(configProject.source, "portal"),
          sql`${configProject.customer}->>'cardCode' = ${context.cardCode}`,
        ))
        .orderBy(desc(configProject.updatedAt)),
    ),

    get: clientProcedure.input(z.object({ id: z.uuid() })).handler(async ({ input, context }) => {
      const p = await loadOwnProject(input.id, context);
      const model = await loadModel(context.tenantId, p.modelId);
      const [run] = await db
        .select()
        .from(configRun)
        .where(and(eq(configRun.projectId, p.id), eq(configRun.tenantId, context.tenantId)))
        .limit(1);
      return {
        project: {
          id: p.id, name: p.name, status: p.status, entries: p.entries, batches: p.batches,
          rejectionNote: p.rejectionNote, events: p.events, modelId: p.modelId,
        },
        model: { id: model.id, name: model.name, definition: toPortalModelDef(model.definition), available: model.portal },
        latestRun: run
          ? {
              id: run.id, entries: run.entries,
              candidates: run.candidates.map(toPortalCandidate),
              selection: run.selection?.map((s) => ({ candidateIdx: s.candidateIdx, batchQty: s.batchQty })) ?? null,
              createdAt: run.createdAt,
            }
          : null,
      };
    }),

    create: clientProcedure
      .input(z.object({ modelId: z.uuid(), name: z.string().min(1) }))
      .handler(async ({ input, context }) => {
        const [m] = await db
          .select({ id: configModel.id, definition: configModel.definition })
          .from(configModel)
          .where(and(
            eq(configModel.id, input.modelId), eq(configModel.tenantId, context.tenantId),
            eq(configModel.portal, true),
          ))
          .limit(1);
        if (!m) throw new ORPCError("NOT_FOUND", { message: "This product is no longer available — contact your supplier." });
        const [ins] = await db
          .insert(configProject)
          .values({
            tenantId: context.tenantId, modelId: m.id, name: input.name,
            source: "portal",
            customer: { cardCode: context.cardCode, cardName: context.cardName }, // forced server-side
            batches: m.definition.batchDefaults,
            createdBy: context.userId,
            events: [event("created")],
          })
          .returning({ id: configProject.id });
        return { id: ins!.id };
      }),

    update: clientProcedure
      .input(z.object({
        id: z.uuid(),
        name: z.string().min(1).optional(),
        entries: EntriesZ.optional(),
        batches: z.array(z.number().int().min(1)).optional(),
      }))
      .handler(async ({ input, context }) => {
        const { id, ...rest } = input;
        const fields: Partial<typeof configProject.$inferInsert> = { ...rest, updatedAt: new Date() };
        if (input.entries !== undefined || input.batches !== undefined) fields.status = "draft";
        const updated = await db
          .update(configProject)
          .set(fields)
          .where(and(ownProject(id, context), inArray(configProject.status, [...EDITABLE])))
          .returning({ id: configProject.id });
        if (!updated.length) {
          const [exists] = await db.select({ id: configProject.id }).from(configProject)
            .where(ownProject(id, context)).limit(1);
          if (exists) throw new ORPCError("BAD_REQUEST", { message: "A submitted request is locked — withdraw it to make changes." });
          throw new ORPCError("NOT_FOUND");
        }
        return { ok: true };
      }),

    remove: clientProcedure.input(z.object({ id: z.uuid() })).handler(async ({ input, context }) => {
      await db.transaction(async (tx) => {
        const del = await tx
          .delete(configProject)
          .where(and(ownProject(input.id, context), inArray(configProject.status, [...EDITABLE])))
          .returning({ id: configProject.id });
        if (!del.length) throw new ORPCError("NOT_FOUND");
        await tx.delete(configRun).where(and(eq(configRun.projectId, input.id), eq(configRun.tenantId, context.tenantId)));
      });
      return { ok: true };
    }),
  },

  // Read-only SAP documents for this client's business partner. Every procedure here is
  // clientProcedure + the CardCode fence + the PORTAL_DOC/PORTAL_LINE allowlist; the underlying
  // reads are literally the same functions entities.* uses.
  docs: {
    /** One entity's fields, already narrowed to what a client may see. Same $metadata cache as
     *  entities.schema — the filtering happens after the cache, not inside it. */
    schema: clientProcedure
      .input(z.object({ entity: PortalEntityZ }))
      .handler(async ({ input, context }) => (await portalEntity(context.tenantId, input.entity)).schema),

    rows: clientProcedure
      .input(z.object({
        entity: PortalEntityZ,
        spec: ListVariantDefZ,
        top: z.number().int().min(1).max(200).default(50),
        skip: z.number().int().min(0).optional(),
        count: z.boolean().optional(),
      }))
      .handler(async ({ input, context }) => {
        const { b1, schema } = await portalEntity(context.tenantId, input.entity);
        return readRows(b1, schema, input.entity, input, cardFence(context.cardCode));
      }),

    /** One document. Read wide and projected here rather than $select-ed: a complex collection in
     *  $select is a shape B1 has no need to accept, and the allowlist is the same either way. */
    one: clientProcedure
      .input(z.object({ entity: PortalEntityZ, key: z.union([z.string(), z.number()]) }))
      .handler(async ({ input, context }) => {
        const { b1, schema } = await portalEntity(context.tenantId, input.entity);
        const { row } = await readOne(b1, schema, input.entity, input.key);
        if (row.CardCode !== context.cardCode) throw new ORPCError("NOT_FOUND");
        // No ETag: nothing on the portal writes to SAP, and an ETag is only useful to a writer.
        return { row: projectDoc(row), etag: null as string | null };
      }),

    print: clientProcedure
      .input(z.object({ entity: PortalEntityZ, docEntry: z.number().int() }))
      .handler(async ({ input, context }) => {
        const { b1, schema } = await portalEntity(context.tenantId, input.entity);
        const { row } = await readOne(b1, schema, input.entity, input.docEntry);
        if (row.CardCode !== context.cardCode) throw new ORPCError("NOT_FOUND");
        return printDocument(context.tenantId, input.entity, input.docEntry);
      }),
  },

  /** The seeded `portal:` views, read-only. variants.list is userProcedure (it fences clients
   *  out), so this is the client's door to the same rows: shared ones only, never personal ones,
   *  and never writable — there is no portal counterpart to variants.save. */
  variants: clientProcedure
    .input(z.object({ page: z.enum(["list", "object"]), entity: z.string() }))
    .handler(async ({ input, context }) => {
      if (!input.entity.startsWith("portal:"))
        throw new ORPCError("FORBIDDEN", { message: "Not a portal view" });
      const rows = await db
        .select({
          id: uiVariant.id,
          name: uiVariant.name,
          shared: uiVariant.shared,
          isDefault: uiVariant.isDefault,
          isStandard: uiVariant.isStandard,
          definition: uiVariant.definition,
        })
        .from(uiVariant)
        .where(and(
          eq(uiVariant.tenantId, context.tenantId),
          eq(uiVariant.page, input.page),
          eq(uiVariant.entity, input.entity),
          eq(uiVariant.shared, true),
        ));
      // Same field set as variants.list so the web hook's two branches stay one type. userId and
      // author are blanked rather than joined: the internal user who seeded the view is not the
      // client's business.
      return {
        variants: rows.map((r) => ({ ...r, userId: "", author: "", canManage: false })),
        isAdmin: false,
      };
    }),

  // calculated → requested. Selection is validated against the latest run and stored on it;
  // never ack a submit without the guarded UPDATE landing.
  submit: clientProcedure
    .input(z.object({
      projectId: z.uuid(),
      selection: z.array(z.object({ candidateIdx: z.number().int().min(0), batchQty: z.number().int().min(1) })).min(1),
    }))
    .handler(async ({ input, context }) => {
      const p = await loadOwnProject(input.projectId, context);
      const [run] = await db
        .select()
        .from(configRun)
        .where(and(eq(configRun.projectId, p.id), eq(configRun.tenantId, context.tenantId)))
        .limit(1);
      if (!run) throw new ORPCError("BAD_REQUEST", { message: "Calculate prices before submitting." });
      for (const s of input.selection) {
        const cand = run.candidates[s.candidateIdx];
        if (!cand || !cand.perBatch.some((b) => b.batchQty === s.batchQty))
          throw new ORPCError("BAD_REQUEST", { message: "Your selection no longer matches the calculated options — recalculate and pick again." });
      }
      await db.transaction(async (tx) => {
        const updated = await tx
          .update(configProject)
          .set({ status: "requested", events: pushEvent("submitted"), updatedAt: new Date() })
          .where(and(ownProject(p.id, context), eq(configProject.status, "calculated")))
          .returning({ id: configProject.id });
        if (!updated.length)
          throw new ORPCError("BAD_REQUEST", { message: "This request changed since prices were calculated — recalculate and try again." });
        await tx.update(configRun).set({ selection: input.selection }).where(eq(configRun.id, run.id));
      });
      return { ok: true };
    }),

  // requested → draft. Racing the internal quote: the status guard lets exactly one side win.
  withdraw: clientProcedure.input(z.object({ projectId: z.uuid() })).handler(async ({ input, context }) => {
    const updated = await db
      .update(configProject)
      .set({ status: "draft", events: pushEvent("withdrawn"), updatedAt: new Date() })
      .where(and(ownProject(input.projectId, context), eq(configProject.status, "requested")))
      .returning({ id: configProject.id });
    if (!updated.length) throw new ORPCError("BAD_REQUEST", { message: "This request can no longer be withdrawn." });
    return { ok: true };
  }),

  // rejected → draft (no event kind for reopen in the spec — the next submit tells the story).
  reopen: clientProcedure.input(z.object({ projectId: z.uuid() })).handler(async ({ input, context }) => {
    const updated = await db
      .update(configProject)
      .set({ status: "draft", updatedAt: new Date() })
      .where(and(ownProject(input.projectId, context), eq(configProject.status, "rejected")))
      .returning({ id: configProject.id });
    if (!updated.length) throw new ORPCError("BAD_REQUEST", { message: "Only a rejected request can be reopened." });
    return { ok: true };
  }),

  // Final line prices for a quoted project. No DocNum, no PDF, no cost breakdown.
  // The project has one run; it must be the acknowledged one (b1DocEntry set).
  quotedResult: clientProcedure.input(z.object({ projectId: z.uuid() })).handler(async ({ input, context }) => {
    const p = await loadOwnProject(input.projectId, context);
    if (p.status !== "quoted") throw new ORPCError("NOT_FOUND");
    const [run] = await db
      .select()
      .from(configRun)
      .where(and(eq(configRun.projectId, p.id), eq(configRun.tenantId, context.tenantId)))
      .limit(1);
    if (!run || !run.selection || run.b1DocEntry == null) throw new ORPCError("NOT_FOUND");
    const lines = applySelection(run, run.selection).map((r) => ({
      assignment: run.candidates[r.candidateIdx]!.assignment,
      batchQty: r.batchQty, unitPrice: r.outputs.unitPrice, total: r.outputs.batchTotal,
    }));
    return { lines };
  }),

  // Same engine path as configs.run; response is counts only — candidates come from projects.get, sanitized.
  run: clientProcedure.input(z.object({ projectId: z.uuid() })).handler(async ({ input, context }) => {
    const p = await loadOwnProject(input.projectId, context);
    if (p.status !== "draft" && p.status !== "calculated")
      throw new ORPCError("BAD_REQUEST", { message: "A submitted request is locked — withdraw it to make changes." });
    const model = await loadModel(context.tenantId, p.modelId);
    if (!model.portal) throw new ORPCError("BAD_REQUEST", { message: UNAVAILABLE });
    return executeRun(context.tenantId, p.id, await modelRunner(context.tenantId, model.definition));
  }),

  // Resolved lookups for live propagation in the portal wizard (same cache as configs.lookups).
  // ponytail: config tables ship whole for propagate(), same as internal; revisit if a tenant
  //           ever puts secrets in a lookup table the model references.
  lookups: clientProcedure
    .input(z.object({ modelId: z.uuid(), entries: EntriesZ.optional() }))
    .handler(async ({ input, context }) => {
      const model = await loadModel(context.tenantId, input.modelId);
      if (!model.portal) throw new ORPCError("BAD_REQUEST", { message: UNAVAILABLE });
      const run = await modelRunner(context.tenantId, model.definition);
      return enrichLookups(model.definition, input.entries ?? {}, await cachedLookups(context.tenantId, model, run), run);
    }),

  // Value help paging, model-scoped exactly like the internal one: a portal client names a query
  // table of a published model, never an OData path.
  queryPage: clientProcedure.input(QueryPageZ).handler(async ({ input, context }) => {
    const model = await loadModel(context.tenantId, input.modelId);
    if (!model.portal) throw new ORPCError("BAD_REQUEST", { message: UNAVAILABLE });
    return queryTablePage(context.tenantId, model.definition, input);
  }),

  // Drawing extraction for published models — one code path with the internal procedure.
  extract: clientProcedure
    .input(z.object({ modelId: z.uuid(), file: ExtractFileZ }))
    .handler(async ({ input, context }) => {
      const model = await loadModel(context.tenantId, input.modelId);
      if (!model.portal) throw new ORPCError("BAD_REQUEST", { message: UNAVAILABLE });
      const lookups = await cachedLookups(context.tenantId, model);
      return extractSuggestions(model, lookups, input.file);
    }),
};
