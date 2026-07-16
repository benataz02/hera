// Exact help: latest Orders/Quotations for the configured item and/or the project customer,
// fetched live through the agent's read-only "query" channel. Pure helpers here (testable);
// the oRPC handler in configs.ts wires runRequest.
// OData: b1s/v2 (v4) lambda — DocumentLines/any(). If a B1 patch level rejects it, swap
// docHistoryPath's item clause for a $crossjoin (see sap-b1-service-layer skill) — callers
// only see the path string.

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
  if (opts.cardCode) clauses.push(`CardCode eq '${esc(opts.cardCode)}'`);
  if (opts.itemCode) clauses.push(`DocumentLines/any(d: d/ItemCode eq '${esc(opts.itemCode)}')`);
  if (!clauses.length) throw new Error("docHistoryPath needs an itemCode or a cardCode");
  return (
    `/${entity}?$select=DocNum,DocDate,CardCode,CardName` +
    `&$expand=DocumentLines($select=ItemCode,ItemDescription,Quantity,UnitPrice)` +
    `&$filter=${encodeURIComponent(clauses.join(" or "))}` +
    `&$orderby=${encodeURIComponent("DocDate desc")}&$top=${opts.top ?? 10}`
  );
}

export function flattenDocs(
  docType: "order" | "quotation",
  json: unknown,
  opts: { itemCode?: string; cardCode?: string },
): DocRow[] {
  const docs = Array.isArray(json) ? json : ((json as { value?: unknown } | null)?.value ?? []);
  if (!Array.isArray(docs)) return [];
  const out: DocRow[] = [];
  for (const d of docs as Record<string, unknown>[]) {
    const custMatch = !!opts.cardCode && d.CardCode === opts.cardCode;
    const lines = Array.isArray(d.DocumentLines) ? (d.DocumentLines as Record<string, unknown>[]) : [];
    for (const l of lines) {
      const itemMatch = !!opts.itemCode && l.ItemCode === opts.itemCode;
      if (!itemMatch && !custMatch) continue; // item-matched doc: only its matching lines are relevant
      out.push({
        docType,
        docNum: Number(d.DocNum ?? 0), docDate: String(d.DocDate ?? ""),
        cardCode: String(d.CardCode ?? ""), cardName: String(d.CardName ?? ""),
        itemCode: String(l.ItemCode ?? ""), itemDescription: String(l.ItemDescription ?? ""),
        quantity: Number(l.Quantity ?? 0), unitPrice: Number(l.UnitPrice ?? 0),
        matched: itemMatch && custMatch ? "both" : itemMatch ? "item" : "customer",
      });
    }
  }
  return out;
}

/** Both-matches first, then newest first. */
export function sortDocRows(rows: DocRow[]): DocRow[] {
  return [...rows].sort(
    (a, b) => (a.matched === "both" ? 0 : 1) - (b.matched === "both" ? 0 : 1) || b.docDate.localeCompare(a.docDate),
  );
}
