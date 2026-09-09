import { createHash } from "node:crypto";
import { ORPCError } from "@orpc/server";
import { and, eq } from "drizzle-orm";
import { db, configProject, type ConfigCandidate, type ConfigSelection } from "@hera/db";
import {
  bindings,
  computeOutputs,
  DslError,
  evalTableRows,
  splitShares,
  type ModelDef,
  type ResolvedLookups,
  type TableDef,
  type TableRows,
  type Val,
} from "@hera/config-engine";

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
  /** row data: it decides how many lines the quotation has and what is on them, so editing the
   *  item matrix has to yield a new id — otherwise the SAP pre-check finds the old quotation and
   *  createQuote reports `reused: true` for a document that no longer matches. */
  tables: TableRows;
}): string {
  // Sorted so a pure reorder of the same picks keeps the same id.
  const sel = [...input.selection]
    .sort((a, b) => a.candidateIdx - b.candidateIdx || a.batchQty - b.batchQty)
    .map((s) => ({
      assignment: input.candidates[s.candidateIdx]?.assignment ?? null,
      batchQty: s.batchQty,
      overrides: s.overrides,
    }));
  const raw = `${input.tenantId}|${input.projectId}|${canonicalJson({ sel, tables: input.tables })}`;
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

type ItemsTable = Extract<TableDef, { role: "items" }>;

/** The one items table a model may declare, if it declared one. checkModel caps it at one. */
const itemsTableOf = (model: ModelDef): ItemsTable | undefined =>
  (model.tables ?? []).find((t): t is ItemsTable => t.role === "items");

/**
 * The quotation's DocumentLines and the engineered totals behind them, from the persisted project
 * and the model's live lookups. The server recomputes every price; the browser's figures are never
 * trusted.
 *
 * One selected (candidate, batch) pair is normally one line. With an items table it is n lines —
 * merge production yields several different items from one run, so the cost is joint and can only
 * be *split*, never computed per item. `value` is the sum of the lines actually built, which is
 * what makes the stored `quotedValue` and the posted document agree by construction.
 */
export function buildQuoteLines(
  project: ConfigProjectRow, model: ModelDef, lookups: ResolvedLookups,
): { lines: Record<string, unknown>[]; value: number; cost: number } {
  const items = itemsTableOf(model);
  const lines: Record<string, unknown>[] = [];
  let value = 0;
  let cost = 0;

  for (const s of project.selection ?? []) {
    const cand = project.candidates[s.candidateIdx];
    if (!cand) continue;
    let out;
    try {
      out = computeOutputs(model, lookups, cand.assignment, s.batchQty, s.overrides, project.tables);
    } catch (e) {
      if (e instanceof DslError || e instanceof RangeError) {
        throw new ORPCError("BAD_REQUEST", { message: e.message });
      }
      throw e;
    }
    cost += out.unitCost * s.batchQty;

    const desc =
      Object.entries(cand.assignment)
        .slice(0, 3)
        .map(([k, v]) => `${k}: ${v}`)
        .join(", ") || "Configuration";

    // a row that ships nothing must not be given a share, or the shares would not sum to the total
    const rows = !items
      ? []
      : evalTableRows(
          items,
          project.tables[items.key] ?? [],
          { ...bindings(model, lookups, cand.assignment, project.tables).values, qty: s.batchQty },
          lookups.tables,
        ).filter((r) => typeof r[items.qtyCol] === "number" && (r[items.qtyCol] as number) > 0);

    if (!items || rows.length === 0) {
      lines.push({
        ItemCode: model.pricing.quoteItemCode,
        ItemDescription: desc,
        Quantity: s.batchQty,
        UnitPrice: out.unitPrice,
      });
      value += out.unitPrice * s.batchQty;
      continue;
    }

    const total = out.unitPrice * s.batchQty;
    const shares = splitShares(rows, items.qtyCol, items.basisCol, total);
    rows.forEach((row, i) => {
      const quantity = (row[items.qtyCol] as number) * s.batchQty;
      const lineTotal = shares[i]!;
      const line: Record<string, unknown> = {
        // the configurator's generic item stays the B1 item; the customer-facing code rides along
        // in a mapped UDF, so no article master has to be created per configuration.
        ItemCode: model.pricing.quoteItemCode,
        ItemDescription: desc,
        Quantity: quantity,
        // ponytail: B1 re-derives LineTotal as round(Quantity * UnitPrice); lineTotal is already
        // whole cents so that round-trips exactly. Post LineTotal instead if a tenant's DocTotal
        // ever drifts from quotedValue.
        UnitPrice: lineTotal / quantity,
      };
      for (const [col, field] of Object.entries(items.map ?? {})) {
        const v: Val | undefined = row[col];
        if (v !== undefined && v !== null) line[field] = v;
      }
      lines.push(line);
      value += lineTotal;
    });
  }
  return { lines, value, cost };
}

/** Canonical Quotations draft: the lines above, plus the customer header. */
export function buildQuoteSeed(
  project: ConfigProjectRow, model: ModelDef, lookups: ResolvedLookups,
): Record<string, unknown> {
  if (!project.customer) {
    throw new ORPCError("BAD_REQUEST", { message: "Customer is required before quoting" });
  }
  if (!project.selection?.length) {
    throw new ORPCError("BAD_REQUEST", { message: "Select at least one candidate before quoting" });
  }
  for (const s of project.selection) {
    if (!project.candidates[s.candidateIdx])
      throw new ORPCError("BAD_REQUEST", { message: `No candidate at index ${s.candidateIdx}` });
  }

  const seed: Record<string, unknown> = {
    CardCode: project.customer.cardCode,
    CardName: project.customer.cardName,
    DocumentLines: buildQuoteLines(project, model, lookups).lines,
  };
  const currency = model.pricing.currency;
  if (currency) seed.DocCurrency = currency;
  return seed;
}

/** Engineered value and cost of the selected candidates. Same builder as the lines, so the stored
 *  margin matches the quotation that was sent to the cent. */
export function quotedTotals(
  project: ConfigProjectRow, model: ModelDef, lookups: ResolvedLookups,
): { value: number; cost: number } {
  const { value, cost } = buildQuoteLines(project, model, lookups);
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
