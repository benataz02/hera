import type { B1Transport, CrossJoinSpec } from "@hera/b1";

// The forward document walk: from the quotation HERA wrote (config_run.b1DocEntry — the only B1
// link HERA stores) to whatever SAP has since made of it. Written in the same style as
// doc-history.ts and reusing the same machinery, for the same reason: B1's $filter has no lambda
// operators, so a document cannot be filtered by its lines except through $crossjoin.
//
// The BaseType codes are DOCUMENT_FLOWS' (doc-copy.ts) — the same table the forward copy writes,
// so the walk and the write agree by construction:
//   Quotation(23) -> Orders     Order(17) -> DeliveryNotes, Invoices     Delivery(15) -> Invoices

export type ChainEntity = "Quotations" | "Orders" | "DeliveryNotes" | "Invoices";

export type ChainDoc = {
  entity: ChainEntity;
  docEntry: number;
  docNum: number;
  docDate: string;
  docTotal: number;
  docStatus: string;
};

const SELECT = ["DocEntry", "DocNum", "DocDate", "DocTotal", "DocumentStatus"];

/** `lines/BaseType eq T and (lines/BaseEntry eq a or lines/BaseEntry eq b …)` — B1's $filter has
 *  no `in` operator either, so a set of parents is an OR group. */
export function baseClause(entity: string, baseType: number, baseEntries: number[]): string {
  const ors = baseEntries.map((e) => `${entity}/DocumentLines/BaseEntry eq ${e}`).join(" or ");
  return `${entity}/DocumentLines/BaseType eq ${baseType} and (${ors})`;
}

/** One hop. The DocEntry equality IS the join — without it the crossjoin pairs every document
 *  with every line in the company. */
export function chainQuery(entity: ChainEntity, clauses: string[], top = 50): CrossJoinSpec {
  return {
    entities: [entity, `${entity}/DocumentLines`],
    expand: [
      { entity, select: SELECT },
      { entity: `${entity}/DocumentLines`, select: ["BaseType", "BaseEntry"] },
    ],
    filter: `${entity}/DocEntry eq ${entity}/DocumentLines/DocEntry and (${clauses.join(" or ")})`,
    orderby: `${entity}/DocDate desc`,
    // ponytail: $top counts (doc, line) pairs, not documents — same caveat as doc-history.ts.
    //           A quotation copied into more than ~50 order lines would truncate; raise it then.
    top,
  };
}

/** Crossjoin pairs -> documents, deduped by DocEntry (one pair per matching line). */
export function flattenChain(entity: ChainEntity, json: unknown): ChainDoc[] {
  const pairs = Array.isArray(json) ? json : ((json as { value?: unknown } | null)?.value ?? []);
  if (!Array.isArray(pairs)) return [];
  const seen = new Map<number, ChainDoc>();
  for (const p of pairs as Record<string, unknown>[]) {
    const d = (p[entity] ?? {}) as Record<string, unknown>;
    const docEntry = Number(d.DocEntry ?? 0);
    if (!docEntry || seen.has(docEntry)) continue;
    seen.set(docEntry, {
      entity,
      docEntry,
      docNum: Number(d.DocNum ?? 0),
      docDate: String(d.DocDate ?? ""),
      docTotal: Number(d.DocTotal ?? 0),
      docStatus: String(d.DocumentStatus ?? ""),
    });
  }
  return [...seen.values()];
}

/**
 * The whole chain for one quotation, oldest hop first. Three sequential crossjoins: each hop
 * needs the previous hop's DocEntries to filter on, so they cannot be parallelised.
 * A hop whose source set is empty is skipped entirely rather than sent as `BaseEntry eq ()`.
 *
 * // ponytail: 3 sequential crossjoins per open project; cache the result on config_run if it
 * //           ever shows up in a trace.
 */
export async function documentChain(b1: B1Transport, quotationDocEntry: number): Promise<ChainDoc[]> {
  const hop = async (entity: ChainEntity, clauses: string[]) =>
    clauses.length ? flattenChain(entity, (await b1.crossJoin(chainQuery(entity, clauses))).data) : [];

  const orders = await hop("Orders", [baseClause("Orders", 23, [quotationDocEntry])]);
  const orderEntries = orders.map((o) => o.docEntry);

  const deliveries = await hop("DeliveryNotes", orderEntries.length ? [baseClause("DeliveryNotes", 17, orderEntries)] : []);
  const deliveryEntries = deliveries.map((d) => d.docEntry);

  // An invoice can be raised straight from the order OR from the delivery — both, in one read.
  const invoices = await hop("Invoices", [
    ...(orderEntries.length ? [baseClause("Invoices", 17, orderEntries)] : []),
    ...(deliveryEntries.length ? [baseClause("Invoices", 15, deliveryEntries)] : []),
  ]);

  return [...orders, ...deliveries, ...invoices];
}
