import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import {
  DynamicPage, DynamicPageHeader, DynamicPageTitle,
  FilterBar, FilterGroupItem, VariantManagement, VariantItem,
  AnalyticalTable, Bar, Title, Input, Select, Option, DatePicker,
  Button, Dialog, CheckBox,
  Table, TableHeaderRow, TableHeaderCell, TableRow, TableCell,
  MessageStrip,
} from "@ui5/webcomponents-react";
import type { AnalyticalTableInstance, UI5WCSlotsNode } from "@ui5/webcomponents-react";
import {
  sameDef, truthy, visibleColumns, formatCell, isTextType, boolFilterState, nextBoolFilter,
  type FilterCond, type FilterOp, type ListColumn, type ListSpec, type ListVariantDef,
} from "../variants.ts";

type Row = Record<string, unknown>;

export type ListReportProps = {
  listSpec: ListSpec;
  /** shown in the count bar, e.g. "Configurations" */
  title: string;
  columns: ListColumn[];
  /** field holding the row's identity, used for the row-click callback */
  keyField: string;
  rows: Row[];
  /** B1: server-side count. Local: rows.length after applySpec, so the bar reflects the filter. */
  total: number;
  loading?: boolean;
  error?: { message: string } | null;
  hasMore?: boolean;
  onLoadMore?: () => void;
  onRowClick: (row: Row) => void;
  /** page-level actions (New …) rendered in the title bar */
  actions?: UI5WCSlotsNode;
  /** enables the bulk Delete button in the count bar. Return false to keep the selection (cancel). */
  onDelete?: (rows: Row[]) => Promise<boolean | void> | boolean | void;
  /** Extra count-bar actions driven by the current selection. Rendered left of Delete; return
   *  null to draw nothing. ListReport never learns what these actions are.
   *  This cashes in the old `// ponytail: one bulk action; swap for a render-prop slot`. */
  selectionActions?: (rows: Row[]) => ReactNode;
  /** must be a stable reference */
  noData?: (reason: "Empty" | "Filtered") => ReactNode;
};

const NO_SELECTION: { ids: Record<string, boolean>; rows: Row[] } = { ids: {}, rows: [] };

// Select matches its `value` against `option.getAttribute("value") || option.textContent`, so an
// empty value silently matches on the label instead. The "no filter" entry needs a real sentinel.
const NO_FILTER = "__none__";

const tableStyle: CSSProperties = {
  maxHeight: "100%",
  boxSizing: "border-box",
  overflow: "hidden",
  borderRadius: "var(--sapElement_BorderCornerRadius)",
};

// The one list-report floorplan: DynamicPage + VariantManagement + FilterBar over an AnalyticalTable.
// A saved view (variant) IS the query — select/filter/orderby/search are executed by the caller
// (OData for B1 entities, applySpec for local arrays) and this component does NO client-side
// processing (manualSortBy/manualFilters), so both sources behave identically.
export function ListReport({
  listSpec, title, columns: cols, keyField, rows, total,
  loading, error, hasMore, onLoadMore, onRowClick, actions, onDelete, selectionActions, noData,
}: ListReportProps) {
  const { entity, spec, setSpec, variants, selectedName, setSelectedName, applyVariant, dirty, isAdmin, readOnly, save, remove, setWidths } = listSpec;

  const [selected, setSelected] = useState(NO_SELECTION);
  const [deleting, setDeleting] = useState(false);
  const [colsOpen, setColsOpen] = useState(false);
  // FilterBar has no liveMode: values live here until Go. spec.filter/search stay the applied query.
  const [filterDraft, setFilterDraft] = useState<{ filter: FilterCond[]; search: string }>(
    () => ({ filter: spec.filter, search: spec.search ?? "" }),
  );
  const filterDraftRef = useRef(filterDraft);
  filterDraftRef.current = filterDraft;
  // Column-picker draft: checkbox/drag/rename mutate ONLY this; Confirm commits it to spec once.
  const [draft, setDraft] = useState<{ name: string; visible: boolean; label: string }[] | null>(null);
  // Column widths live in react-table's internal reducer; read back on pointer release (see below).
  const tableInstanceRef = useRef<AnalyticalTableInstance | null>(null);
  const lastWidthsRef = useRef<Record<string, number>>({});
  const widthsSaveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // Variant / Restore rewrite spec.filter|search; copy that into the bar so the fields match the query.
  useEffect(() => {
    setFilterDraft({ filter: spec.filter, search: spec.search ?? "" });
  }, [spec.filter, spec.search]);

  const setDraftCond = (field: string, op: FilterOp, value: FilterCond["value"] | "") =>
    setFilterDraft((d) => {
      const rest = d.filter.filter((c) => c.field !== field);
      const empty = value === "" || value == null;
      return { ...d, filter: empty ? rest : [...rest, { field, op, value }] };
    });

  const applyFilters = (over: Partial<ListVariantDef> = {}) => {
    const { filter, search } = filterDraftRef.current;
    setSpec((s) => ({ ...s, filter, search, ...over }));
  };

  const visibleCols = useMemo(() => visibleColumns(spec, cols), [spec, cols]);

  const columns = useMemo(
    () =>
      visibleCols
        .map((n) => cols.find((c) => c.name === n))
        .filter((c): c is ListColumn => !!c)
        .map((c) => ({
          id: c.name,
          Header: spec.labels?.[c.name] ?? c.label ?? c.name,
          // A custom Cell wants the raw value; everything else is pre-formatted to a string.
          accessor: c.Cell ? c.name : (row: Row) => formatCell(row[c.name], c.type),
          ...(c.Cell ? { Cell: c.Cell } : {}),
          ...(spec.widths?.[c.name] ? { width: spec.widths[c.name] } : {}),
        })),
    [visibleCols, spec, cols],
  );

  // Server-side everything: no client sort/filter, and don't reset table state as rows append.
  const reactTableOptions = useMemo(
    () => ({
      autoResetSortBy: false, autoResetFilters: false, autoResetSelectedRows: false,
      autoResetPage: false, autoResetHiddenColumns: false,
      manualSortBy: true, manualFilters: true, manualGlobalFilter: true,
    }),
    [],
  );

  // ponytail: identity changes remount the (stateless) illustration; not worth a stable wrapper.
  const NoDataComponent = useMemo(
    () => (noData ? ({ noDataReason }: { noDataReason: "Empty" | "Filtered" }) => <>{noData(noDataReason)}</> : undefined),
    [noData],
  );

  const runDelete = async () => {
    if (!onDelete || !selected.rows.length) return;
    setDeleting(true);
    try {
      if ((await onDelete(selected.rows)) !== false) setSelected(NO_SELECTION);
    } finally {
      setDeleting(false);
    }
  };

  // ---- Column picker: a draft copy of visibility/order/labels; only Confirm touches spec. ----
  const openColumns = () => {
    const hidden = cols.map((c) => c.name).filter((n) => !visibleCols.includes(n));
    setDraft(
      [...visibleCols, ...hidden].map((name) => ({
        name,
        visible: visibleCols.includes(name),
        label: spec.labels?.[name] ?? cols.find((c) => c.name === name)?.label ?? name,
      })),
    );
    setColsOpen(true);
  };
  const closeColumns = () => { setDraft(null); setColsOpen(false); };
  const confirmColumns = () => {
    if (!draft) return closeColumns();
    const order = draft.filter((d) => d.visible).map((d) => d.name);
    const schemaOrder = cols.map((c) => c.name);
    const isDefaultOrder = order.length === schemaOrder.length && order.every((n, i) => n === schemaOrder[i]);
    const labels = Object.fromEntries(
      draft.filter((d) => d.label !== (cols.find((c) => c.name === d.name)?.label ?? d.name)).map((d) => [d.name, d.label]),
    );
    setSpec((s) => ({ ...s, select: isDefaultOrder ? [] : order, labels }));
    closeColumns();
  };

  // ponytail: no resize event; read react-table state on pointer release, debounce the save.
  const onColumnResizeEnd = () => {
    setTimeout(() => {
      const widths = tableInstanceRef.current?.state?.columnResizing?.columnWidths as Record<string, number> | undefined;
      if (!widths || sameDef(widths, lastWidthsRef.current)) return;
      lastWidthsRef.current = widths;
      setSpec((s) => ({ ...s, widths }));
      // variants.setWidths is userProcedure; a portal client would only ever get a FORBIDDEN.
      if (readOnly) return;
      const row = variants.find((v) => v.name === selectedName);
      if (!row) return;
      clearTimeout(widthsSaveTimer.current);
      widthsSaveTimer.current = setTimeout(() => setWidths.mutate({ id: row.id, widths }), 400);
    }, 0);
  };

  const variantManagement = (
    <VariantManagement
      dirtyState={dirty}
      hideShare={!isAdmin}
      hideApplyAutomatically
      onSelect={(e) => applyVariant(String(e.detail.selectedVariant.children))}
      onSaveAs={(e) => {
        const d = e.detail;
        const name = String(d.children);
        save.mutate(
          { page: "list", entity, name, definition: spec, shared: truthy(d.global), isDefault: truthy(d.isDefault) },
          { onSuccess: () => setSelectedName(name) },
        );
      }}
      onSave={() => {
        const row = variants.find((v) => v.name === selectedName);
        if (row) save.mutate({ id: row.id, page: "list", entity, name: row.name, definition: spec, shared: row.shared, isDefault: row.isDefault });
      }}
      onSaveManageViews={(e) => {
        for (const del of e.detail.deletedVariants) {
          const r = variants.find((v) => v.name === String(del.children));
          if (r) remove.mutate({ id: r.id });
        }
        for (const up of e.detail.updatedVariants) {
          const prevName = up.prevVariant?.children ? String(up.prevVariant.children) : String(up.children);
          const r = variants.find((v) => v.name === prevName);
          // Belt-and-suspenders: readOnly already blocks this in the dialog, but never rename Standard.
          if (r && !r.isStandard) save.mutate({ id: r.id, page: "list", entity, name: String(up.children), definition: r.definition as ListVariantDef, shared: truthy(up.global), isDefault: truthy(up.isDefault) });
        }
      }}
    >
      {variants.map((v) => (
        <VariantItem
          key={v.id}
          selected={selectedName === v.name}
          isDefault={v.isDefault}
          global={v.shared}
          author={v.author}
          readOnly={!v.canManage || v.isStandard}
          hideDelete={!v.canManage || v.isStandard}
        >
          {v.name}
        </VariantItem>
      ))}
    </VariantManagement>
  );

  // No save, no Save As, no Manage Views for a user who cannot own a view — a variant switcher
  // with one entry and every action disabled is worse than a plain title.
  const heading = readOnly ? <Title level="H4">{title}</Title> : variantManagement;

  // One FilterGroupItem per column. Text/key columns are shown in the bar; the rest live in the
  // "Adapt Filters" dialog (hiddenInFilterBar) so the bar isn't a wall of inputs.
  const filterItems = cols.map((c) => {
    const cond = filterDraft.filter.find((f) => f.field === c.name);
    const isBool = /bool/i.test(c.type);
    const isDate = /date|time/i.test(c.type);
    const isNum = /int|double|decimal|single|byte|number/i.test(c.type);
    // Visibility is part of the view: an explicit filterBar set wins; else a default heuristic.
    // An active filter is always shown so its value can't hide off-screen.
    const bar = spec.filterBar ?? [];
    const inBar = (bar.length ? bar.includes(c.name) : c.name === keyField || !!c.options || isTextType(c.type)) || !!cond;
    let control;
    if (c.options) {
      control = (
        <Select
          value={cond ? String(cond.value) : NO_FILTER}
          onChange={(e) => {
            const v = e.detail.selectedOption.value ?? "";
            setDraftCond(c.name, "eq", v === NO_FILTER ? "" : v);
          }}
        >
          <Option value={NO_FILTER}>All</Option>
          {c.options.map((o) => (
            <Option key={o.value} value={o.value}>{o.text}</Option>
          ))}
        </Select>
      );
    } else if (isBool) {
      // A boolean is a checkbox here too, not a dropdown — but a filter has a third state the
      // field doesn't: unfiltered. Hence indeterminate, cycling Any -> Yes -> No, with the text
      // saying which one you are on.
      const on = boolFilterState(cond);
      control = (
        <CheckBox
          checked={on === true}
          indeterminate={on === undefined}
          text={on === undefined ? "Any" : on ? "Yes" : "No"}
          onChange={() => setDraftCond(c.name, "eq", nextBoolFilter(on))}
        />
      );
    } else if (isDate) {
      // ISO so the server-side OData $filter literal is valid (B1 dates are unquoted ISO).
      control = <DatePicker displayFormat="yyyy-MM-dd" value={cond ? String(cond.value) : ""} onChange={(e) => setDraftCond(c.name, "eq", e.detail.value)} />;
    } else {
      control = (
        <Input
          type={isNum ? "Number" : "Text"}
          value={cond ? String(cond.value) : ""}
          onInput={(e) => setDraftCond(c.name, isNum ? "eq" : "contains", isNum ? Number(e.target.value) : e.target.value)}
        />
      );
    }
    return (
      <FilterGroupItem key={c.name} filterKey={c.name} label={c.label ?? c.name} active={!!cond} hiddenInFilterBar={!inBar}>
        {control}
      </FilterGroupItem>
    );
  });

  const countBar = (
    <Bar
      startContent={<Title level="H5">{title} ({selected.rows.length}/{total})</Title>}
      endContent={
        <>
          {selectionActions?.(selected.rows)}
          {onDelete ? (
            <Button icon="delete" design="Transparent" disabled={!selected.rows.length || deleting} onClick={runDelete}>
              Delete
            </Button>
          ) : null}
          <Button icon="action-settings" design="Transparent" onClick={() => (colsOpen ? closeColumns() : openColumns())}>Columns</Button>
        </>
      }
    />
  );

  return (
    <DynamicPage
      hidePinButton
      // `heading` is unslotted when the page snaps (UI5 swaps to the `snappedHeading` slot), so feed
      // both to keep VariantManagement visible after the filter header collapses. Inline vars trim the
      // title padding (0.5rem→0.25rem). // ponytail: private theme vars, revisit if they get renamed.
      titleArea={
        <DynamicPageTitle
          heading={heading}
          snappedHeading={heading}
          actionsBar={actions}
          style={{ "--_ui5_dynamic_page_title_padding_top": "0.25rem", "--_ui5_dynamic_page_title_padding_bottom": "0.25rem" } as CSSProperties}
        />
      }
      headerArea={
        <DynamicPageHeader>
          <FilterBar
            hideToolbar
            enableReordering
            showGoOnFB
            showClearOnFB
            onGo={() => applyFilters()}
            onClear={() => setFilterDraft({ filter: [], search: "" })}
            // Adapt Filters Go: persist which filters are in the bar, and apply values like the bar Go.
            onFiltersDialogSave={(e) => {
              const keys = e.detail.selectedFilterKeys;
              applyFilters(Array.isArray(keys) ? { filterBar: keys as string[] } : {});
            }}
            // Restore = discard unsaved changes, revert to the selected view.
            onRestore={() => applyVariant(selectedName)}
            search={<Input placeholder="Search" value={filterDraft.search} onInput={(e) => setFilterDraft((d) => ({ ...d, search: e.target.value }))} />}
          >
            {filterItems}
          </FilterBar>
        </DynamicPageHeader>
      }
    >
      {/* Flex column so the table gets exactly the leftover height and the page never scrolls.
          DynamicPage's content padding is `1rem 1rem 0`, so the bottom gap is ours to add — as
          padding here, not a margin below the table, which would overflow the 100% again. */}
      <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem", height: "100%", paddingBottom: "1rem", boxSizing: "border-box" }}>
        {error ? <MessageStrip design="Negative" hideCloseButton>{error.message}</MessageStrip> : null}
        {/* Plain div, not a Card: AutoWithEmptyRows measures this element and the table ends up a
            whole number of rows short of it, so the frame goes on the table itself — otherwise the
            rounded bottom floats below the last row. This box only supplies the height. */}
        <div style={{ flex: 1, minHeight: 0 }} onPointerUp={onColumnResizeEnd}>
        <AnalyticalTable
          columns={columns}
          data={rows}
          reactTableOptions={reactTableOptions}
          // What Card gave us: --_ui5_card_border + rounded corners, clipped so the header/last row
          // don't square them off. maxHeight absorbs the 2px the border adds to the measured fit.
          style={tableStyle}
          extension={countBar}
          loading={loading}
          minRows={1}
          visibleRows={15}
          visibleRowCountMode="AutoWithEmptyRows"
          infiniteScroll
          tableInstance={tableInstanceRef}
          retainColumnWidth
          NoDataComponent={NoDataComponent}
          onLoadMore={() => { if (hasMore) onLoadMore?.(); }}
          selectedRowIds={selected.ids}
          onRowSelect={(e) => {
            const ids = e.detail.selectedRowIds ?? {};
            const byId = e.detail.rowsById ?? {};
            // rowsById carries the originals, so bulk actions never re-derive ids from the DOM.
            setSelected({ ids, rows: Object.keys(ids).filter((k) => ids[k]).map((k) => byId[k]?.original as Row).filter(Boolean) });
          }}
          // UI5 only suppresses onRowClick when the checkbox itself is hit; the padding around it
          // is the cell div, which still navigates. Walk up to the cell instead.
          onRowClick={(e) => {
            if ((e.target as HTMLElement | null)?.closest?.('[data-selection-cell="true"]')) return;
            onRowClick(e.detail.row.original as Row);
          }}
          // Sort routes to the caller's query, not client-side (manualSortBy). Single-column for v1.
          // ponytail: multi-sort -> push each into orderby instead of replacing.
          onSort={(e) => {
            const col = (e.detail.column as { id?: string }).id;
            const dir = e.detail.sortDirection;
            if (!col) return;
            setSpec((s) => ({ ...s, orderby: dir === "asc" || dir === "desc" ? [{ field: col, dir }] : [] }));
          }}
          onColumnsReorder={(e) => {
            const order = e.detail.columnsNewOrder.map((c) => (c as { id?: string }).id).filter((id): id is string => !!id);
            if (order.length) setSpec((s) => ({ ...s, select: order }));
          }}
          selectionBehavior="Row"
          selectionMode="Multiple"
          sortable
          />
        </div>
      </div>
      <Dialog
        open={colsOpen}
        onClose={closeColumns}
        headerText="Columns"
        style={{ width: 480 }}
        footer={
          <Bar
            endContent={
              <>
                <Button design="Emphasized" onClick={confirmColumns}>Confirm</Button>
                <Button design="Transparent" onClick={closeColumns}>Cancel</Button>
              </>
            }
          />
        }
      >
        {draft ? (
          <Table
            headerRow={
              <TableHeaderRow>
                <TableHeaderCell>Visible</TableHeaderCell>
                <TableHeaderCell>Label</TableHeaderCell>
              </TableHeaderRow>
            }
            onMoveOver={(e) => e.preventDefault()}
            onMove={(e) => {
              const src = (e.detail.source.element as unknown as { rowKey?: string } | null)?.rowKey;
              const dst = (e.detail.destination.element as unknown as { rowKey?: string } | null)?.rowKey;
              if (!src || !dst || src === dst) return;
              setDraft((cur) => {
                if (!cur) return cur;
                const next = [...cur];
                const from = next.findIndex((d) => d.name === src);
                if (from < 0) return cur;
                const moved = next.splice(from, 1)[0]!;
                let to = next.findIndex((d) => d.name === dst);
                if (to < 0) return cur;
                if (e.detail.destination.placement === "After") to += 1;
                next.splice(to, 0, moved);
                return next;
              });
            }}
          >
            {draft.map((d) => (
              <TableRow key={d.name} rowKey={d.name} movable>
                <TableCell>
                  <CheckBox checked={d.visible} onChange={() => setDraft((cur) => cur!.map((x) => (x.name === d.name ? { ...x, visible: !x.visible } : x)))} />
                </TableCell>
                <TableCell>
                  <Input
                    value={d.label}
                    onInput={(e) => {
                      const v = e.target.value;
                      setDraft((cur) => cur!.map((x) => (x.name === d.name ? { ...x, label: v } : x)));
                    }}
                  />
                </TableCell>
              </TableRow>
            ))}
          </Table>
        ) : null}
      </Dialog>
    </DynamicPage>
  );
}
