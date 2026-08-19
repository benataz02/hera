/** UI-only price provenance for DocumentLines. */
export type PriceSource = "sap" | "config" | "manual";

type DocFamily = "sales-document" | "purchase-document";

const REPRICE_PATHS = new Set([
  "ItemCode",
  "CardCode",
  "Quantity",
  "UoMEntry",
  "UoMCode",
  "UoMQuantity",
  "DocDate",
  "DocCurrency",
  "Currency",
  "PriceList",
]);

function isBlankPrice(v: unknown): boolean {
  return v == null || v === "" || (typeof v === "number" && Number.isNaN(v));
}

/**
 * Merge item defaults into a line without mutating. Skips dirtyPaths (prefix + field).
 * Never overwrites config/manual UnitPrice/DiscountPercent from SAP defaults.
 */
export function applyItemDefaults(
  line: Record<string, unknown>,
  defaults: Record<string, unknown>,
  _family: DocFamily,
  dirtyPaths: Set<string>,
  pathPrefix = "",
): Record<string, unknown> {
  const next = { ...line };
  const priceSource = (next.priceSource as PriceSource | undefined) ?? "sap";
  const protectPrice = priceSource === "config" || priceSource === "manual";

  for (const [field, value] of Object.entries(defaults)) {
    if (value === undefined) continue;
    const path = pathPrefix ? `${pathPrefix}.${field}` : field;
    if (dirtyPaths.has(path)) continue;
    if (protectPrice && (field === "UnitPrice" || field === "DiscountPercent")) continue;
    next[field] = value;
  }

  if (priceSource === "sap" && defaults.UnitPrice != null && isBlankPrice(line.UnitPrice)) {
    next.priceSource = "sap";
  }
  return next;
}

/** LineTotal = Quantity * UnitPrice * (1 - DiscountPercent/100). Immutable. */
export function recalcLine(line: Record<string, unknown>): Record<string, unknown> {
  const qty = Number(line.Quantity ?? 0);
  const price = Number(line.UnitPrice ?? 0);
  const disc = Number(line.DiscountPercent ?? 0);
  const LineTotal = qty * price * (1 - disc / 100);
  return { ...line, LineTotal };
}

/** Recalc each DocumentLines row, then DocTotal = sum(LineTotal). Preview only. */
export function recalcDocumentTotals(document: Record<string, unknown>): Record<string, unknown> {
  const lines = Array.isArray(document.DocumentLines)
    ? (document.DocumentLines as Record<string, unknown>[]).map(recalcLine)
    : [];
  const DocTotal = lines.reduce((sum, l) => sum + Number(l.LineTotal ?? 0), 0);
  return { ...document, DocumentLines: lines, DocTotal };
}

/** Auto-reprice only for sap lines when a pricing context path changes. */
export function shouldReprice(priceSource: PriceSource, changedPath: string): boolean {
  if (priceSource !== "sap") return false;
  const leaf = changedPath.includes(".") ? changedPath.slice(changedPath.lastIndexOf(".") + 1) : changedPath;
  return REPRICE_PATHS.has(leaf);
}
