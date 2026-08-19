import { createHash } from "node:crypto";
import { ORPCError } from "@orpc/server";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  db,
  agentRequest,
  configProject,
  configRun,
  type RunCandidate,
  type RunSelection,
} from "@hera/db";
import { computeOutputs, DslError } from "@hera/config-engine";
import type { WritePayload } from "./writes.ts";

export type ConfigProjectRow = typeof configProject.$inferSelect;
export type ConfigRunRow = typeof configRun.$inferSelect;

/** Deterministic create command id / SAP dedup UDF value for a fenced selection. */
export function configDocumentCommandId(input: {
  tenantId: string;
  projectId: string;
  runId: string;
  selectionVersion: number;
}): string {
  const raw = `${input.tenantId}|${input.projectId}|${input.runId}|${input.selectionVersion}`;
  return createHash("sha256").update(raw).digest("hex");
}

/** Canonical Quotations draft from persisted project + run snapshot (server recomputes prices). */
export function buildQuoteSeed(project: ConfigProjectRow, run: ConfigRunRow): Record<string, unknown> {
  if (!project.customer) {
    throw new ORPCError("BAD_REQUEST", { message: "Customer is required before quoting" });
  }
  if (!run.selection?.length) {
    throw new ORPCError("BAD_REQUEST", { message: "Select at least one candidate before quoting" });
  }

  const lines = run.selection.map((s) => {
    const cand = run.candidates[s.candidateIdx];
    if (!cand) {
      throw new ORPCError("BAD_REQUEST", { message: `No candidate at index ${s.candidateIdx}` });
    }
    let unitPrice: number;
    try {
      unitPrice = computeOutputs(
        run.modelSnapshot,
        run.lookupSnapshot,
        cand.assignment,
        s.batchQty,
        s.overrides,
      ).unitPrice;
    } catch (e) {
      if (e instanceof DslError || e instanceof RangeError) {
        throw new ORPCError("BAD_REQUEST", { message: e.message });
      }
      throw e;
    }
    const desc =
      Object.entries(cand.assignment)
        .slice(0, 3)
        .map(([k, v]) => `${k}: ${v}`)
        .join(", ") || "Configuration";
    return {
      ItemCode: run.modelSnapshot.pricing.quoteItemCode,
      ItemDescription: desc,
      Quantity: s.batchQty,
      UnitPrice: unitPrice,
      priceSource: "config",
    };
  });

  const seed: Record<string, unknown> = {
    CardCode: project.customer.cardCode,
    CardName: project.customer.cardName,
    DocumentLines: lines,
  };
  const currency = run.modelSnapshot.pricing.currency;
  if (currency) seed.DocCurrency = currency;
  return seed;
}

/** Engineered value and cost of the selected candidates, using the same computation
 *  buildQuoteSeed prices from — so the stored margin matches the quotation that was sent. */
export function quotedTotals(run: ConfigRunRow): { value: number; cost: number } {
  let value = 0;
  let cost = 0;
  for (const s of run.selection ?? []) {
    const cand = run.candidates[s.candidateIdx];
    if (!cand) continue;
    const out = computeOutputs(run.modelSnapshot, run.lookupSnapshot, cand.assignment, s.batchQty, s.overrides);
    value += out.unitPrice * s.batchQty;
    cost += out.unitCost * s.batchQty;
  }
  return { value, cost };
}

/** Selection pairs must exist on the run and must not duplicate. */
export function validateSelectionPairs(
  run: { candidates: RunCandidate[] },
  selection: RunSelection[],
): void {
  const seen = new Set<string>();
  for (const s of selection) {
    const cand = run.candidates[s.candidateIdx];
    if (!cand || !cand.perBatch.some((b) => b.batchQty === s.batchQty)) {
      throw new ORPCError("BAD_REQUEST", {
        message: "Selection does not match the calculated candidate/batch options",
      });
    }
    const key = `${s.candidateIdx}:${s.batchQty}`;
    if (seen.has(key)) {
      throw new ORPCError("BAD_REQUEST", { message: "Duplicate candidate/batch pair" });
    }
    seen.add(key);
  }
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type DbOrTx = typeof db | Tx;

/** Reject update/run/select/createQuote while quoted or while a config-document write is pending/in-flight. */
export async function assertConfigMutable(
  tenantId: string,
  projectId: string,
  client: DbOrTx = db,
): Promise<void> {
  const [project] = await client
    .select({ status: configProject.status })
    .from(configProject)
    .where(and(eq(configProject.id, projectId), eq(configProject.tenantId, tenantId)))
    .limit(1);
  if (!project) throw new ORPCError("NOT_FOUND");
  if (project.status === "quoted") {
    throw new ORPCError("CONFLICT", { message: "Configuration is quoted and locked" });
  }
  const [pending] = await client
    .select({ id: agentRequest.id })
    .from(agentRequest)
    .where(
      and(
        eq(agentRequest.tenantId, tenantId),
        eq(agentRequest.kind, "write"),
        inArray(agentRequest.status, ["pending", "in_flight"]),
        sql`${agentRequest.payload}->'origin'->>'kind' = 'config-document'`,
        sql`${agentRequest.payload}->'origin'->>'projectId' = ${projectId}`,
      ),
    )
    .limit(1);
  if (pending) {
    throw new ORPCError("CONFLICT", {
      message: "A quotation write is already in progress for this configuration",
    });
  }
}

/**
 * Configurator side effects inside the attempt-fenced ack transaction.
 * On run/version mismatch: leave the write done but record origin-conflict; do not mutate another selection.
 */
export async function completeWriteOrigin(
  tx: Tx,
  tenantId: string,
  requestId: string,
  payload: WritePayload,
  confirmed: { docEntry?: string | null; result?: unknown },
): Promise<void> {
  const origin = payload.origin;
  if (!origin || origin.kind !== "config-document") return;

  const [run] = await tx
    .select()
    .from(configRun)
    .where(and(eq(configRun.id, origin.runId), eq(configRun.tenantId, tenantId)))
    .for("update");

  const mismatch =
    !run ||
    run.projectId !== origin.projectId ||
    run.selectionVersion !== origin.selectionVersion;

  if (mismatch) {
    await tx
      .update(agentRequest)
      .set({ lastError: "origin-conflict", updatedAt: new Date() })
      .where(and(eq(agentRequest.id, requestId), eq(agentRequest.tenantId, tenantId)));
    return;
  }

  // Idempotent: already completed for this run.
  if (run.b1DocEntry != null) return;

  const docEntryRaw = confirmed.docEntry ?? extractDocEntry(confirmed.result);
  const docEntry = docEntryRaw != null ? Number(docEntryRaw) : NaN;
  if (!Number.isFinite(docEntry)) {
    await tx
      .update(agentRequest)
      .set({ lastError: "origin-conflict: missing DocEntry", updatedAt: new Date() })
      .where(and(eq(agentRequest.id, requestId), eq(agentRequest.tenantId, tenantId)));
    return;
  }

  let totals = { value: 0, cost: 0 };
  try {
    totals = quotedTotals(run);
  } catch {
    // ponytail: margin is reporting-only — never fail a confirmed SAP write over it.
    //           Nulls here just exclude the run from the margin roll-up.
  }
  await tx
    .update(configRun)
    .set({
      b1DocEntry: docEntry,
      quotedAt: new Date(),
      quotedValue: totals.value ? String(totals.value) : null,
      quotedCost: totals.cost ? String(totals.cost) : null,
    })
    .where(and(eq(configRun.id, run.id), eq(configRun.tenantId, tenantId)));

  await tx
    .update(configProject)
    .set({
      status: "quoted",
      events: sql`${configProject.events} || ${JSON.stringify([{ at: new Date().toISOString(), kind: "quoted" }])}::jsonb`,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(configProject.id, origin.projectId),
        eq(configProject.tenantId, tenantId),
        inArray(configProject.status, ["calculated", "requested"]),
      ),
    );
}

function extractDocEntry(result: unknown): string | undefined {
  if (!result || typeof result !== "object") return undefined;
  const r = result as { key?: unknown; record?: Record<string, unknown> };
  if (r.key != null) return String(r.key);
  if (r.record?.DocEntry != null) return String(r.record.DocEntry);
  return undefined;
}
