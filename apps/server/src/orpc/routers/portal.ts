import { ORPCError } from "@orpc/server";
import { z } from "zod";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import { db, configModel, configProject, configRun, member, organization, portalClient, user, type ProjectEvent } from "@hera/db";
import { EntriesZ } from "@hera/config-engine";
import { adminProcedure, baseDomain, clientProcedure, sessionProcedure } from "../base.ts";
import { hashToken } from "../../crypto.ts";
import { tenantSlugFromHost } from "../../tenant.ts";

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
};
