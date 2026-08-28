import { z } from "zod";
import { eq } from "drizzle-orm";
import { db, configProject, configRun, dashboardSnapshot } from "@hera/db";
import { userProcedure } from "../base.ts";
import { buildOverview, type ProjectRow } from "../../dashboard.ts";
import { tenantConnector, viaB1 } from "../../b1.ts";
import { refreshB1Snapshot } from "../../dashboard-snapshot.ts";

async function loadProjects(tenantId: string): Promise<ProjectRow[]> {
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
    .where(eq(configProject.tenantId, tenantId));
  return rows.map((r) => ({
    id: r.id, name: r.name, status: r.status, source: r.source,
    createdBy: r.createdBy, createdAt: r.createdAt,
    customerName: r.customer?.cardName ?? null,
    quotedAt: r.quotedAt, b1DocEntry: r.b1DocEntry,
    quotedValue: r.quotedValue === null ? null : Number(r.quotedValue),
    quotedCost: r.quotedCost === null ? null : Number(r.quotedCost),
  }));
}

export const dashboardRouter = {
  overview: userProcedure
    .input(z.object({
      window: z.enum(["month", "quarter", "year12"]).default("month"),
    }))
    .handler(async ({ input, context }) => {
      const { tenantId } = context;
      const [snap] = await db
        .select({ payload: dashboardSnapshot.payload, computedAt: dashboardSnapshot.computedAt, lastError: dashboardSnapshot.lastError })
        .from(dashboardSnapshot)
        .where(eq(dashboardSnapshot.tenantId, tenantId))
        .limit(1);

      return buildOverview({
        window: input.window, now: new Date(),
        snapshot: snap ? { payload: snap.payload, computedAt: snap.computedAt, lastError: null } : null,
        projects: await loadProjects(tenantId),
      });
    }),

  // Synchronous, capped multi-page refresh — see dashboard-snapshot.ts for the bound.
  refresh: userProcedure.handler(async ({ context }) => {
    const { b1 } = await tenantConnector(context.tenantId);
    await viaB1(() => refreshB1Snapshot(context.tenantId, b1));
    return { ok: true };
  }),
};
