import { z } from "zod";
import { and, desc, eq } from "drizzle-orm";
import { ORPCError } from "@orpc/server";
import { db, agentRequest, configProject, configRun, dashboardSnapshot, tenantIntegration } from "@hera/db";
import { adminProcedure, userProcedure } from "../base.ts";
import { buildOverview, type ExceptionRow, type ProjectRow } from "../../dashboard.ts";
import { refreshB1Snapshot } from "../../dashboard-snapshot.ts";
import { assertAgentReady, runRequest } from "./entities.ts";

const REFRESH_COOLDOWN_MS = 2 * 60_000;
const FAILED_LIMIT = 20;

async function loadProjects(tenantId: string, userId: string | null): Promise<ProjectRow[]> {
  const rows = await db
    .select({
      id: configProject.id, name: configProject.name, status: configProject.status,
      source: configProject.source, createdBy: configProject.createdBy,
      createdAt: configProject.createdAt, customer: configProject.customer,
      quotedAt: configRun.quotedAt, b1DocEntry: configRun.b1DocEntry,
      quotedValue: configRun.quotedValue, quotedCost: configRun.quotedCost,
    })
    .from(configProject)
    .leftJoin(configRun, eq(configRun.projectId, configProject.id))
    .where(
      userId
        ? and(eq(configProject.tenantId, tenantId), eq(configProject.createdBy, userId))
        : eq(configProject.tenantId, tenantId),
    );
  // numeric comes back as string; a project with several runs keeps the quoted one.
  const byProject = new Map<string, ProjectRow>();
  for (const r of rows) {
    const row: ProjectRow = {
      id: r.id, name: r.name, status: r.status, source: r.source,
      createdBy: r.createdBy, createdAt: r.createdAt,
      customerName: r.customer?.cardName ?? null,
      quotedAt: r.quotedAt, b1DocEntry: r.b1DocEntry,
      quotedValue: r.quotedValue === null ? null : Number(r.quotedValue),
      quotedCost: r.quotedCost === null ? null : Number(r.quotedCost),
    };
    const prev = byProject.get(r.id);
    if (!prev || (row.quotedAt && !prev.quotedAt)) byProject.set(r.id, row);
  }
  return [...byProject.values()];
}

export const dashboardRouter = {
  overview: userProcedure
    .input(z.object({
      window: z.enum(["month", "quarter", "year12"]).default("month"),
      scope: z.enum(["mine", "tenant"]).default("tenant"),
    }))
    .handler(async ({ input, context }) => {
      const { tenantId, userId } = context;
      const [ti] = await db
        .select({ salesReps: tenantIntegration.salesReps, lastSeenAt: tenantIntegration.lastSeenAt })
        .from(tenantIntegration)
        .where(eq(tenantIntegration.tenantId, tenantId))
        .limit(1);
      const salesPersonCode = ti?.salesReps?.[userId] ?? null;
      // Unmapped users get tenant numbers rather than a half-scoped page.
      const scope = input.scope === "mine" && salesPersonCode !== null ? "mine" : "tenant";

      const [snap] = await db
        .select({ payload: dashboardSnapshot.payload, computedAt: dashboardSnapshot.computedAt, lastError: dashboardSnapshot.lastError })
        .from(dashboardSnapshot)
        .where(eq(dashboardSnapshot.tenantId, tenantId))
        .limit(1);

      const failed: ExceptionRow[] = await db
        .select({ id: agentRequest.id, kind: agentRequest.kind, lastError: agentRequest.lastError, updatedAt: agentRequest.updatedAt })
        .from(agentRequest)
        .where(and(eq(agentRequest.tenantId, tenantId), eq(agentRequest.status, "failed")))
        .orderBy(desc(agentRequest.updatedAt))
        .limit(FAILED_LIMIT);

      return buildOverview({
        window: input.window, scope, now: new Date(),
        snapshot: snap ?? null,
        salesPersonCode,
        projects: await loadProjects(tenantId, scope === "mine" ? userId : null),
        failed,
        agentLastSeen: ti?.lastSeenAt ?? null,
      });
    }),

  refresh: userProcedure.handler(async ({ context }) => {
    const { tenantId } = context;
    const [snap] = await db
      .select({ computedAt: dashboardSnapshot.computedAt })
      .from(dashboardSnapshot)
      .where(eq(dashboardSnapshot.tenantId, tenantId))
      .limit(1);
    if (snap && Date.now() - snap.computedAt.getTime() < REFRESH_COOLDOWN_MS) return { refreshed: false };
    await assertAgentReady(tenantId);
    await refreshB1Snapshot(tenantId, (path) => runRequest(tenantId, "query", { target: "b1", path }));
    return { refreshed: true };
  }),

  salesReps: {
    get: userProcedure.handler(async ({ context }) => {
      const [ti] = await db
        .select({ salesReps: tenantIntegration.salesReps })
        .from(tenantIntegration)
        .where(eq(tenantIntegration.tenantId, context.tenantId))
        .limit(1);
      return { reps: ti?.salesReps ?? {} };
    }),

    set: adminProcedure
      .input(z.object({ userId: z.string().min(1), salesPersonCode: z.number().int().positive().nullable() }))
      .handler(async ({ input, context }) => {
        const [ti] = await db
          .select({ salesReps: tenantIntegration.salesReps })
          .from(tenantIntegration)
          .where(eq(tenantIntegration.tenantId, context.tenantId))
          .limit(1);
        if (!ti) throw new ORPCError("NOT_FOUND", { message: "No integration is configured for this workspace" });
        const reps = { ...ti.salesReps };
        if (input.salesPersonCode === null) delete reps[input.userId];
        else reps[input.userId] = input.salesPersonCode;
        await db.update(tenantIntegration).set({ salesReps: reps })
          .where(eq(tenantIntegration.tenantId, context.tenantId));
        return { reps };
      }),
  },
};
