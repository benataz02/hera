import { useEffect, useMemo, useRef, useState } from "react";
import type { EntityProperty, ObjectVariantDef } from "@hera/db";
import {
  Button,
  Table,
  TableCell,
  TableHeaderCell,
  TableHeaderRow,
  TableRow,
  TableRowAction,
  Text,
} from "@ui5/webcomponents-react";
import {
  applyItemDefaults,
  recalcLine,
  shouldReprice,
  type PriceSource,
} from "../b1Lines.ts";
import { formatCell } from "../listSpec.ts";
import { autoColumnWidths, createUi5TextMeasure } from "../objectSpec.ts";
import { EntityField } from "./EntityField.tsx";
import type { ValueHelpRow } from "./EntityValueHelp.tsx";
import {
  createItemContextSequencerMap,
  ensureLineDraftKeys,
  findRowByKey,
  lineRowKey,
  pickFlexMinWidth,
  type ItemContextRequest,
  type ItemContextResult,
} from "./objectLinesLogic.ts";

type FieldDef = ObjectVariantDef["header"][number];

const ITEM_CONTEXT_DEBOUNCE_MS = 350;

export type DocumentPriceContext = {
  cardCode?: string;
  docDate?: string;
  currency?: string;
  priceList?: number;
};

export type ObjectLinesTableProps = {
  fields: FieldDef[];
  properties: EntityProperty[];
  rows: Record<string, unknown>[];
  mode: "display" | "edit";
  /** Profile collectionEditable set — fields writable in edit mode. */
  editableFields?: string[];
  /** Absolute dirty paths, e.g. `DocumentLines.0.TaxCode`. */
  dirtyPaths?: Set<string>;
  /** Path prefix for dirty/merge, e.g. `DocumentLines`. */
  pathPrefix?: string;
  family?: "sales-document" | "purchase-document";
  documentContext?: DocumentPriceContext;
  onRowsChange?: (rows: Record<string, unknown>[]) => void;
  /** Fetch item defaults + price (parent wires oRPC). */
  fetchItemContext?: (
    req: ItemContextRequest,
    signal: AbortSignal,
  ) => Promise<ItemContextResult>;
  /** Remote value help for lookup columns. */
  fetchValueHelp?: (field: string, search: string) => Promise<ValueHelpRow[]>;
  onAddRow?: () => void;
  onRemoveRow?: (rowIndex: number) => void;
};

function fieldLabel(f: FieldDef): string {
  return f.label?.trim() || f.name;
}

function rowPath(prefix: string, index: number, field: string): string {
  return prefix ? `${prefix}.${index}.${field}` : `${index}.${field}`;
}

/**
 * One nested collection table (UI5 v2 Table). Content-aware widths, EntityField cells,
 * debounced item-context merge, and edit-only row actions.
 */
export function ObjectLinesTable({
  fields,
  properties,
  rows: rawRows,
  mode,
  editableFields,
  dirtyPaths = new Set(),
  pathPrefix = "",
  family = "sales-document",
  documentContext,
  onRowsChange,
  fetchItemContext,
  fetchValueHelp,
  onAddRow,
  onRemoveRow,
}: ObjectLinesTableProps) {
  const visibleFields = useMemo(() => fields.filter((f) => f.visible), [fields]);
  const propBy = useMemo(() => new Map(properties.map((p) => [p.name, p])), [properties]);
  const editable = useMemo(() => new Set(editableFields ?? []), [editableFields]);

  const rows = useMemo(() => ensureLineDraftKeys(rawRows), [rawRows]);
  const rowsRef = useRef(rows);
  rowsRef.current = rows;

  const docCtxRef = useRef(documentContext);
  docCtxRef.current = documentContext;

  const [measure, setMeasure] = useState<(text: string) => number>(
    () => (t: string) => t.length * 8,
  );
  const tableRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    const run = () => {
      if (cancelled) return;
      setMeasure(() => createUi5TextMeasure(tableRef.current ?? undefined));
    };
    run();
    void document.fonts?.ready.then(run);
    const onTheme = () => run();
    window.addEventListener("ui5-theme-effective", onTheme);
    return () => {
      cancelled = true;
      window.removeEventListener("ui5-theme-effective", onTheme);
    };
  }, [visibleFields, rows, mode]);

  const widths = useMemo(
    () =>
      autoColumnWidths({
        fields: visibleFields,
        properties,
        rows,
        mode,
        measure,
      }),
    [visibleFields, properties, rows, mode, measure],
  );

  const sequencers = useMemo(() => createItemContextSequencerMap(), []);
  useEffect(() => () => sequencers.abortAll(), [sequencers]);

  const debounceTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  useEffect(
    () => () => {
      for (const t of debounceTimers.current.values()) clearTimeout(t);
      debounceTimers.current.clear();
    },
    [],
  );

  const [vhRows, setVhRows] = useState<Record<string, ValueHelpRow[]>>({});
  const [vhLabels, setVhLabels] = useState<Record<string, string>>({});

  const scheduleItemContext = (rowKey: string, forcePrice: boolean) => {
    if (!fetchItemContext || !onRowsChange) return;
    const start = findRowByKey(rowsRef.current, rowKey);
    if (!start) return;
    const itemCode = String(start.row.ItemCode ?? "").trim();
    if (!itemCode) return;

    const prev = debounceTimers.current.get(rowKey);
    if (prev) clearTimeout(prev);

    debounceTimers.current.set(
      rowKey,
      setTimeout(() => {
        debounceTimers.current.delete(rowKey);
        const current = findRowByKey(rowsRef.current, rowKey);
        if (!current || String(current.row.ItemCode ?? "").trim() !== itemCode) return;

        const priceSource = (current.row.priceSource as PriceSource | undefined) ?? "sap";
        const qty = Number(current.row.Quantity);
        const uomEntry = current.row.UoMEntry != null ? Number(current.row.UoMEntry) : undefined;
        const uomQty = current.row.UoMQuantity != null ? Number(current.row.UoMQuantity) : undefined;
        const ctx = docCtxRef.current;

        void sequencers
          .forKey(rowKey)
          .run(fetchItemContext, {
            itemCode,
            cardCode: ctx?.cardCode,
            inventoryQuantity: Number.isFinite(qty) ? qty : undefined,
            uomEntry: Number.isFinite(uomEntry!) ? uomEntry : undefined,
            uomQuantity: Number.isFinite(uomQty!) ? uomQty : undefined,
            date: ctx?.docDate,
            currency: ctx?.currency,
            priceList: ctx?.priceList,
          })
          .then((result) => {
            if (!result) return;
            const live = findRowByKey(rowsRef.current, rowKey);
            if (!live || String(live.row.ItemCode ?? "").trim() !== itemCode) return;

            const prefix = pathPrefix ? `${pathPrefix}.${live.index}` : String(live.index);
            let defaults = { ...result.defaults };
            if (result.price?.value != null) {
              defaults.UnitPrice = result.price.value;
              if (result.price.discount != null) defaults.DiscountPercent = result.price.discount;
            }

            // Preserve config/manual prices unless Refresh SAP Price forced the update.
            if (!forcePrice && (priceSource === "config" || priceSource === "manual")) {
              const { UnitPrice: _u, DiscountPercent: _d, ...rest } = defaults;
              defaults = rest;
            }

            let merged = applyItemDefaults(live.row, defaults, family, dirtyPaths, prefix);
            if (forcePrice) {
              merged = {
                ...merged,
                priceSource: "sap",
                ...(result.price?.value != null ? { UnitPrice: result.price.value } : {}),
                ...(result.price?.discount != null
                  ? { DiscountPercent: result.price.discount }
                  : {}),
              };
            }
            const next = rowsRef.current.map((r) =>
              lineRowKey(r) === rowKey ? recalcLine(merged) : r,
            );
            onRowsChange(next);
          });
      }, ITEM_CONTEXT_DEBOUNCE_MS),
    );
  };

  // Document price context changes → debounce item-context for sap lines with ItemCode.
  const docCtxSeen = useRef(false);
  useEffect(() => {
    if (!docCtxSeen.current) {
      docCtxSeen.current = true;
      return;
    }
    if (!fetchItemContext || !onRowsChange) return;
    for (const row of rowsRef.current) {
      const src = (row.priceSource as PriceSource | undefined) ?? "sap";
      if (src !== "sap") continue;
      if (!String(row.ItemCode ?? "").trim()) continue;
      scheduleItemContext(lineRowKey(row), false);
    }
  }, [
    documentContext?.cardCode,
    documentContext?.docDate,
    documentContext?.currency,
    documentContext?.priceList,
  ]);

  const onCellChange = (index: number, field: string, next: unknown, defaults?: Record<string, unknown>) => {
    const row = rows[index];
    if (!row) return;
    const key = lineRowKey(row);

    let patch: Record<string, unknown> = { [field]: next };
    if (field === "UnitPrice") {
      patch.priceSource = "manual";
    }
    if (defaults && field === "ItemCode") {
      const prefix = pathPrefix ? `${pathPrefix}.${index}` : String(index);
      patch = applyItemDefaults({ ...row, ...patch }, defaults, family, dirtyPaths, prefix);
    }

    const merged = recalcLine({ ...row, ...patch });
    if (!onRowsChange) return;
    const nextRows = rows.map((r, i) => (i === index ? merged : r));
    onRowsChange(nextRows);

    const priceSource = (merged.priceSource as PriceSource | undefined) ?? "sap";
    const changedPath = rowPath(pathPrefix, index, field);
    if (
      fetchItemContext &&
      (field === "ItemCode" || shouldReprice(priceSource, changedPath) || shouldReprice(priceSource, field))
    ) {
      scheduleItemContext(key, false);
    }
  };

  const refreshSapPrice = (index: number) => {
    const row = rows[index];
    if (!row) return;
    const src = (row.priceSource as PriceSource | undefined) ?? "sap";
    if (src === "config" || src === "manual") {
      const ok = window.confirm(
        "Replace the current unit price/discount with the latest SAP price?",
      );
      if (!ok) return;
    }
    scheduleItemContext(lineRowKey(row), true);
  };

  if (!visibleFields.length) {
    return <Text>No columns selected.</Text>;
  }

  return (
    <div ref={(el) => { tableRef.current = el; }}>
      {mode === "edit" && onAddRow ? (
        <div style={{ marginBottom: "0.5rem" }}>
          <Button design="Transparent" icon="add" onClick={onAddRow}>
            Add line
          </Button>
        </div>
      ) : null}
      <Table
        overflowMode="Scroll"
        noDataText="No rows."
        rowActionCount={mode === "edit" ? 2 : 0}
        headerRow={
          <TableHeaderRow sticky>
            {visibleFields.map((f) => {
              const w = widths[f.name];
              if (w === "flex") {
                return (
                  <TableHeaderCell key={f.name} minWidth={`${pickFlexMinWidth(f.name)}px`}>
                    <span>{fieldLabel(f)}</span>
                  </TableHeaderCell>
                );
              }
              return (
                <TableHeaderCell key={f.name} width={w != null ? `${w}px` : undefined}>
                  <span>{fieldLabel(f)}</span>
                </TableHeaderCell>
              );
            })}
          </TableHeaderRow>
        }
      >
        {rows.map((row, index) => {
          const rk = lineRowKey(row);
          const priceSource = (row.priceSource as PriceSource | undefined) ?? "sap";
          return (
            <TableRow
              key={rk}
              rowKey={rk}
              actions={
                mode === "edit" ? (
                  <>
                    <TableRowAction
                      icon="refresh"
                      text="Refresh SAP Price"
                      onClick={() => refreshSapPrice(index)}
                      invisible={priceSource === "sap" && !row.ItemCode}
                    />
                    {onRemoveRow ? (
                      <TableRowAction
                        icon="delete"
                        text="Delete"
                        onClick={() => onRemoveRow(index)}
                      />
                    ) : null}
                  </>
                ) : undefined
              }
            >
              {visibleFields.map((f) => {
                const prop = propBy.get(f.name) ?? {
                  name: f.name,
                  type: "Edm.String",
                  nullable: true,
                };
                const canEdit =
                  mode === "edit" && (editableFields == null || editable.has(f.name));
                const vhKey = `${rk}:${f.name}`;
                return (
                  <TableCell key={f.name}>
                    <div style={{ width: "100%", minWidth: 0 }}>
                      <EntityField
                        property={prop}
                        value={row[f.name]}
                        mode={canEdit ? "edit" : "display"}
                        readOnly={!canEdit}
                        resolveLabel={false}
                        valueHelpLabel={vhLabels[vhKey] ?? formatCell(row[f.name], prop.type)}
                        valueHelpRows={vhRows[vhKey] ?? []}
                        onValueHelpSearch={
                          fetchValueHelp && prop.lookup
                            ? (q) => {
                                void fetchValueHelp(f.name, q).then((list) =>
                                  setVhRows((cur) => ({ ...cur, [vhKey]: list })),
                                );
                              }
                            : undefined
                        }
                        onValueHelpChange={(next) => {
                          if (next) {
                            setVhLabels((cur) => ({ ...cur, [vhKey]: next.label }));
                          }
                          onCellChange(index, f.name, next?.key, next?.defaults);
                        }}
                        onChange={(next) => onCellChange(index, f.name, next)}
                      />
                    </div>
                  </TableCell>
                );
              })}
            </TableRow>
          );
        })}
      </Table>
    </div>
  );
}
