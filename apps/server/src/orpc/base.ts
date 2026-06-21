import { os, ORPCError } from "@orpc/server";
import { and, eq } from "drizzle-orm";
import { db, tenantIntegration, member, organization } from "@hera/db";
import { auth } from "../auth.ts";
import { hashToken } from "../crypto.ts";
import { tenantSlugFromHost } from "../tenant.ts";

const baseDomain = process.env.APP_BASE_DOMAIN ?? "localhost";

// Initial context provided by the Hono adapter on every request.
export interface InitialContext {
  headers: Headers;
}

export const base = os.$context<InitialContext>();

// --- Layer 1: human user via Better Auth session ---
const requireSession = base.middleware(async ({ context, next }) => {
  const data = await auth.api.getSession({ headers: context.headers });
  if (!data) throw new ORPCError("UNAUTHORIZED");
  return next({ context: { session: data.session, user: data.user } });
});

/**
 * Procedures a signed-in user calls, scoped to the tenant in the request host
 * (`<slug>.<baseDomain>`). The membership join is the tenant boundary: a forged host
 * can only ever select an org the user already belongs to.
 */
export const userProcedure = base.use(requireSession).use(async ({ context, next }) => {
  // Caddy preserves Host; the dev proxy and e2e set X-Forwarded-Host. Prefer the latter.
  const host = context.headers.get("x-forwarded-host") ?? context.headers.get("host");
  const slug = tenantSlugFromHost(host, baseDomain);
  if (!slug) throw new ORPCError("BAD_REQUEST", { message: "No tenant subdomain" });
  const [row] = await db
    .select({ tenantId: organization.id, role: member.role })
    .from(organization)
    .innerJoin(member, eq(member.organizationId, organization.id))
    .where(and(eq(organization.slug, slug), eq(member.userId, context.user.id)))
    .limit(1);
  if (!row) throw new ORPCError("FORBIDDEN", { message: "Not a member of this workspace" });
  return next({ context: { tenantId: row.tenantId, role: row.role } });
});

/** Like userProcedure, but only org admins/owners — gates the entity-config panel. */
export const adminProcedure = userProcedure.use(({ context, next }) => {
  if (context.role !== "admin" && context.role !== "owner") {
    throw new ORPCError("FORBIDDEN", { message: "Admins only" });
  }
  return next({});
});

// --- Layer 2: on-prem agent via per-tenant bearer token (NOT a user session) ---
const requireAgent = base.middleware(async ({ context, next }) => {
  const header = context.headers.get("authorization");
  const token = header?.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) throw new ORPCError("UNAUTHORIZED");
  const [row] = await db
    .select({ tenantId: tenantIntegration.tenantId })
    .from(tenantIntegration)
    .where(eq(tenantIntegration.agentTokenHash, hashToken(token)))
    .limit(1);
  if (!row) throw new ORPCError("UNAUTHORIZED");
  return next({ context: { tenantId: row.tenantId } });
});

/** Procedures the on-prem agent calls; tenant resolved from its token, never an IP. */
export const agentProcedure = base.use(requireAgent);
