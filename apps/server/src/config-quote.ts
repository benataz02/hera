import { createHash } from "node:crypto";
import { ORPCError } from "@orpc/server";
import { and, eq } from "drizzle-orm";
import { db, configProject, type ConfigCandidate, type ConfigSelection } from "@hera/db";
import { computeOutputs, DslError, type ModelDef, type ResolvedLookups } from "@hera/config-engine";

export type ConfigProjectRow = typeof configProject.$inferSelect;

/** UDF on OQUT carrying configDocumentCommandId, so a retried createQuote finds the quotation it
 *  already posted instead of posting a second one. Must exist in the customer's B1 — the install
 *  step is one alphanumeric UDF of length 64 on Sales Quotation (Title). */
export const DEDUP_UDF = "U_HERA_DedupKey";

/** Deterministic create command id / SAP dedup UDF value for a project's current selection.
 *  Keyed on what is being quoted, not a version counter: the same picks retried yield the same id
 *  (a retry must never create a second SAP document), a changed selection yields a new one.
 *
 *  It hashes each pick's *assignment*, not its `candidateIdx`. Indices are only meaningful against
 *  the candidate list that produced them, and a recalculate replaces that list — so hashing the
 *  index would let "candidate 0" of a fresh calculation collide with a quotation posted for a
 *  different configuration whose response never arrived. */
export function configDocumentCommandId(input: {
  tenantId: string;
  projectId: string;
  candidates: ConfigCandidate[];
  selection: ConfigSelection[];
}): string {
  // Sorted so a pure reorder of the same picks keeps the same id.
  const sel = [...input.selection]
    .sort((a, b) => a.candidateIdx - b.candidateIdx || a.batchQty - b.batchQty)
    .map((s) => ({
      assignment: input.candidates[s.candidateIdx]?.assignment ?? null,
      batchQty: s.batchQty,
      overrides: s.overrides,
    }));
  const raw = `${input.tenantId}|${input.projectId}|${canonicalJson(sel)}`;
  return createHash("sha256").update(raw).digest("hex");
}

/** JSON with object keys sorted. Plain JSON.stringify will not do: Postgres reorders jsonb object
 *  keys, so a selection read back from config_project would hash differently from the one written. */
function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (v && typeof v === "object") {
    const entries = Object.entries(v as Record<string, unknown>)
      .filter(([, x]) => x !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : 1));
    return `{${entries.map(([k, x]) => `${JSON.stringify(k)}:${canonicalJson(x)}`).join(",")}}`;
  }
  return JSON.stringify(v ?? null);
}

/** Canonical Quotations draft from the persisted project and the model's live lookups (the server
 *  recomputes every price; the browser's figures are never trusted). */
export function buildQuoteSeed(
  project: ConfigProjectRow, model: ModelDef, lookups: ResolvedLookups,
): Record<string, unknown> {
  if (!project.customer) {
    throw new ORPCError("BAD_REQUEST", { message: "Customer is required before quoting" });
  }
  if (!project.selection?.length) {
    throw new ORPCError("BAD_REQUEST", { message: "Select at least one candidate before quoting" });
  }

  const lines = project.selection.map((s) => {
    const cand = project.candidates[s.candidateIdx];
    if (!cand) {
      throw new ORPCError("BAD_REQUEST", { message: `No candidate at index ${s.candidateIdx}` });
    }
    let unitPrice: number;
    try {
      unitPrice = computeOutputs(model, lookups, cand.assignment, s.batchQty, s.overrides).unitPrice;
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
      ItemCode: model.pricing.quoteItemCode,
      ItemDescription: desc,
      Quantity: s.batchQty,
      UnitPrice: unitPrice,
    };
  });

  const seed: Record<string, unknown> = {
    CardCode: project.customer.cardCode,
    CardName: project.customer.cardName,
    DocumentLines: lines,
  };
  const currency = model.pricing.currency;
  if (currency) seed.DocCurrency = currency;
  return seed;
}

/** Engineered value and cost of the selected candidates, using the same computation
 *  buildQuoteSeed prices from — so the stored margin matches the quotation that was sent. */
export function quotedTotals(
  model: ModelDef, lookups: ResolvedLookups,
  candidates: ConfigCandidate[], selection: ConfigSelection[] | null,
): { value: number; cost: number } {
  let value = 0;
  let cost = 0;
  for (const s of selection ?? []) {
    const cand = candidates[s.candidateIdx];
    if (!cand) continue;
    const out = computeOutputs(model, lookups, cand.assignment, s.batchQty, s.overrides);
    value += out.unitPrice * s.batchQty;
    cost += out.unitCost * s.batchQty;
  }
  return { value, cost };
}

/** Selection pairs must exist in the calculation and must not duplicate. */
export function validateSelectionPairs(
  candidates: ConfigCandidate[],
  selection: ConfigSelection[],
): void {
  const seen = new Set<string>();
  for (const s of selection) {
    const cand = candidates[s.candidateIdx];
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

/** Reject update/calculate/select while quoted. */
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
}
