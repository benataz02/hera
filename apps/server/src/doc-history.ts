// Exact help: latest Orders/Quotations for the configured item and/or the project customer,
// fetched live through the agent's read-only "query" channel. Pure helpers here (testable);
// the oRPC handler in configs.ts wires runRequest.
// B1's $filter parser has no lambda operators, so a document can't be filtered by its lines
// directly (all verified against b1s/v2, 400 code 201):
//   DocumentLines/any(d: d/ItemCode eq 'X')  -> "Invalid symbol in the filter condition"
//   DocumentLines/ItemCode eq 'X'            -> "Property 'DocumentLines/ItemCode' is invalid"
//   $expand=DocumentLines(...)               -> not a nav property (it's a complex collection)
// $crossjoin is the way in, and it takes a plain GET — no QueryService_PostQuery, so the agent's
// GET-only query channel is enough. It returns one flat {Entity, Entity/DocumentLines} pair per
// line, which is already DocRow's grain.

export type DocRow = {
  docType: "order" | "quotation";
  docNum: number; docDate: string; cardCode: string; cardName: string;
  itemCode: string; itemDescription: string; quantity: number; unitPrice: number;
  matched: "both" | "customer" | "item";
};

const esc = (s: string) => s.replace(/'/g, "''");

export function docHistoryPath(
  entity: "Orders" | "Quotations",
  opts: { itemCode?: string; cardCode?: string; top?: number },
): string {
  const clauses: string[] = [];
  if (opts.cardCode) clauses.push(`${entity}/CardCode eq '${esc(opts.cardCode)}'`);
  if (opts.itemCode) clauses.push(`${entity}/DocumentLines/ItemCode eq '${esc(opts.itemCode)}'`);
  if (!clauses.length) throw new Error("docHistoryPath needs an itemCode or a cardCode");
  // The DocEntry equality IS the join — without it the crossjoin pairs every document with every
  // line in the company. A customer-matched doc still pairs with all its lines (the header clause
  // holds for each), so the "keep all lines of my customer's docs" behaviour survives the rewrite.
  const filter = `${entity}/DocEntry eq ${entity}/DocumentLines/DocEntry and (${clauses.join(" or ")})`;
  // ponytail: $top counts (doc,line) pairs now, not documents — fine, the pane lists rows.
  return (
    `/$crossjoin(${entity},${entity}/DocumentLines)` +
    `?$expand=${entity}($select=DocNum,DocDate,CardCode,CardName),` +
    `${entity}/DocumentLines($select=ItemCode,ItemDescription,Quantity,UnitPrice)` +
    `&$filter=${encodeURIComponent(filter)}` +
    `&$orderby=${encodeURIComponent(`${entity}/DocDate desc`)}&$top=${opts.top ?? 10}`
  );
}

export function flattenDocs(
  docType: "order" | "quotation",
  json: unknown,
  opts: { itemCode?: string; cardCode?: string },
): DocRow[] {
  const entity = docType === "order" ? "Orders" : "Quotations";
  const pairs = Array.isArray(json) ? json : ((json as { value?: unknown } | null)?.value ?? []);
  if (!Array.isArray(pairs)) return [];
  const out: DocRow[] = [];
  for (const p of pairs as Record<string, unknown>[]) {
    const d = (p[entity] ?? {}) as Record<string, unknown>;
    const l = (p[`${entity}/DocumentLines`] ?? {}) as Record<string, unknown>;
    const custMatch = !!opts.cardCode && d.CardCode === opts.cardCode;
    const itemMatch = !!opts.itemCode && l.ItemCode === opts.itemCode;
    if (!itemMatch && !custMatch) continue; // B1 already filtered; this just guards `matched`
    out.push({
      docType,
      docNum: Number(d.DocNum ?? 0), docDate: String(d.DocDate ?? ""),
      cardCode: String(d.CardCode ?? ""), cardName: String(d.CardName ?? ""),
      itemCode: String(l.ItemCode ?? ""), itemDescription: String(l.ItemDescription ?? ""),
      quantity: Number(l.Quantity ?? 0), unitPrice: Number(l.UnitPrice ?? 0),
      matched: itemMatch && custMatch ? "both" : itemMatch ? "item" : "customer",
    });
  }
  return out;
}

/** Both-matches first, then newest first. */
export function sortDocRows(rows: DocRow[]): DocRow[] {
  return [...rows].sort(
    (a, b) => (a.matched === "both" ? 0 : 1) - (b.matched === "both" ? 0 : 1) || b.docDate.localeCompare(a.docDate),
  );
}
