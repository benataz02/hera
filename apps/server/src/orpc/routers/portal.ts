import { ORPCError } from "@orpc/server";
import { z } from "zod";
import { and, desc, eq, isNull } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import { db, configModel, member, organization, portalClient, user } from "@hera/db";
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
};
