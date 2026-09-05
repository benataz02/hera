// Document copy: Quotation -> Order -> Delivery -> Invoice, and the purchase equivalents.
// Ported from b1-mcp-server's b1-document-service.ts (MIT): the flow table, the object-type codes
// and the line allowlist. B1 does the actual linking — a target line carrying
// {BaseType, BaseEntry, BaseLine} is what closes the source line and keeps the document flow
// intact. Everything else on the source line is either recalculated by B1 or must not be copied,
// which is why this is an allowlist and not a blocklist.

export type DocumentFlow = {
  source: string;
  target: string;
  /** B1 object type of the SOURCE — that is what BaseType names. */
  baseType: number;
  label: string;
};

export const DOCUMENT_FLOWS: DocumentFlow[] = [
  { source: "Quotations", target: "Orders", baseType: 23, label: "Sales Quotation to Sales Order" },
  { source: "Orders", target: "DeliveryNotes", baseType: 17, label: "Sales Order to Delivery" },
  { source: "Orders", target: "Invoices", baseType: 17, label: "Sales Order to Invoice" },
  { source: "DeliveryNotes", target: "Invoices", baseType: 15, label: "Delivery to A/R Invoice" },
  { source: "PurchaseOrders", target: "PurchaseDeliveryNotes", baseType: 22, label: "Purchase Order to Goods Receipt" },
  { source: "PurchaseDeliveryNotes", target: "PurchaseInvoices", baseType: 20, label: "Goods Receipt to A/P Invoice" },
];

export const flowsFrom = (source: string): DocumentFlow[] => DOCUMENT_FLOWS.filter((f) => f.source === source);

export const findFlow = (source: string, target: string): DocumentFlow | undefined =>
  DOCUMENT_FLOWS.find((f) => f.source === source && f.target === target);

/** Safe business fields on a line. Excludes system-managed, calculated and accounting fields;
 *  every U_ UDF rides along, which is what keeps a tenant's own columns through a conversion. */
const LINE_FIELDS = new Set([
  "ItemCode", "ItemDescription", "Quantity", "Price", "UnitPrice", "Currency", "DiscountPercent",
  "WarehouseCode", "TaxCode", "TaxOnly", "CostingCode", "CostingCode2", "CostingCode3",
  "CostingCode4", "CostingCode5", "ProjectCode", "VatGroup", "UoMCode", "UoMEntry", "MeasureUnit",
  "UnitsOfMeasurment", "FreeText", "Text", "LineVendor",
]);

export type SourceDocument = {
  DocEntry?: unknown;
  DocNum?: unknown;
  CardCode?: unknown;
  DocDate?: unknown;
  DocDueDate?: unknown;
  DocumentLines?: unknown;
};

/**
 * Build the target document from a source document read out of B1.
 * `lines` selects source line indexes; omitted copies them all.
 */
export function buildCopy(
  flow: DocumentFlow,
  source: SourceDocument,
  opts: { lines?: number[]; comments?: string } = {},
): Record<string, unknown> {
  const docEntry = Number(source.DocEntry);
  if (!Number.isFinite(docEntry)) throw new Error("Source document has no DocEntry");
  const sourceLines = Array.isArray(source.DocumentLines) ? (source.DocumentLines as Record<string, unknown>[]) : [];
  if (!sourceLines.length) throw new Error("Source document has no lines");

  const indexes = opts.lines ?? sourceLines.map((_, i) => i);
  const bad = indexes.find((i) => !Number.isInteger(i) || i < 0 || i >= sourceLines.length);
  if (bad !== undefined) throw new Error(`Line ${bad} is not on the source document`);

  const DocumentLines = indexes.map((i) => {
    const src = sourceLines[i]!;
    // BaseLine is the source line's LineNum, not its array position — they diverge as soon as a
    // line is deleted from the source document.
    const baseLine = Number(src.LineNum ?? i);
    const line: Record<string, unknown> = { BaseType: flow.baseType, BaseEntry: docEntry, BaseLine: baseLine };
    for (const [k, v] of Object.entries(src)) {
      if (v === null || v === undefined) continue;
      if (LINE_FIELDS.has(k) || k.startsWith("U_")) line[k] = v;
    }
    return line;
  });

  return {
    CardCode: source.CardCode,
    ...(source.DocDate ? { DocDate: source.DocDate } : {}),
    ...(source.DocDueDate ? { DocDueDate: source.DocDueDate } : {}),
    Comments: opts.comments ?? `Created from ${flow.source} ${String(source.DocNum ?? docEntry)} in HERA`,
    DocumentLines,
  };
}

/** Fields the copy needs off the source; keeps the read narrow. */
export const COPY_SELECT = ["DocEntry", "DocNum", "CardCode", "DocDate", "DocDueDate", "DocumentLines"];
