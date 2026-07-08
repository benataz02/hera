import { ORPCError } from "@orpc/server";
import { z } from "zod";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import {
  db, configModel, configProject, configRun, member, organization, portalClient, user,
  type ProjectEvent, type RunCandidate,
} from "@hera/db";
import { EntriesZ, type Entries, type ModelDef } from "@hera/config-engine";
import { adminProcedure, baseDomain, clientProcedure, sessionProcedure } from "../base.ts";
import { hashToken } from "../../crypto.ts";
import { tenantSlugFromHost } from "../../tenant.ts";
import { applySelection, cachedLookups, executeRun, freshLookups, loadModel, needsAgent, pushEvent } from "./configs.ts";
import { assertAgentReady } from "./entities.ts";
import { agentFetcher } from "./models.ts";
import { ExtractFileZ, extractSuggestions } from "./extraction.ts";

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
        .orderBy(desc(configRun.createdAt))
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
        .orderBy(desc(configRun.createdAt))
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
  quotedResult: clientProcedure.input(z.object({ projectId: z.uuid() })).handler(async ({ input, context }) => {
    const p = await loadOwnProject(input.projectId, context);
    if (p.status !== "quoted") throw new ORPCError("NOT_FOUND");
    const [run] = await db
      .select()
      .from(configRun)
      .where(and(eq(configRun.projectId, p.id), eq(configRun.tenantId, context.tenantId), sql`${configRun.selection} is not null`))
      .orderBy(desc(configRun.createdAt))
      .limit(1);
    if (!run || !run.selection) throw new ORPCError("NOT_FOUND");
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
    if (needsAgent(model.definition)) await assertAgentReady(context.tenantId);
    return executeRun(context.tenantId, p.id, agentFetcher(context.tenantId));
  }),

  // Resolved lookups for live propagation in the portal wizard (same cache as configs.lookups).
  // ponytail: lookup tables ship whole for propagate(), same as internal; revisit if a tenant
  //           ever puts secrets in a lookup table the model references.
  lookups: clientProcedure.input(z.object({ modelId: z.uuid() })).handler(async ({ input, context }) => {
    const model = await loadModel(context.tenantId, input.modelId);
    if (!model.portal) throw new ORPCError("BAD_REQUEST", { message: UNAVAILABLE });
    return cachedLookups(context.tenantId, model);
  }),

  // Drawing extraction for published models — one code path with the internal procedure.
  extract: clientProcedure
    .input(z.object({ modelId: z.uuid(), file: ExtractFileZ }))
    .handler(async ({ input, context }) => {
      const model = await loadModel(context.tenantId, input.modelId);
      if (!model.portal) throw new ORPCError("BAD_REQUEST", { message: UNAVAILABLE });
      if (needsAgent(model.definition)) await assertAgentReady(context.tenantId);
      const lookups = await freshLookups(context.tenantId, model.definition, agentFetcher(context.tenantId));
      return extractSuggestions(model, lookups, input.file);
    }),
};
