import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import {
  DynamicPage, DynamicPageHeader, DynamicPageTitle,
  FilterBar, FilterGroupItem, VariantManagement, VariantItem,
  AnalyticalTable, Bar, Title, Input, Select, Option, DatePicker,
  Button, Dialog, CheckBox,
  Table, TableHeaderRow, TableHeaderCell, TableRow, TableCell,
  MessageStrip, BusyIndicator, Card,
} from "@ui5/webcomponents-react";
import type { AnalyticalTableInstance } from "@ui5/webcomponents-react";
import { orpc } from "../orpc.ts";
import { useVariants, sameDef, truthy, type ListVariantDef, type FilterCond } from "../variants.ts";

const cell = (v: unknown) => (v == null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v));
const isNumeric = (t: string) => /int|double|decimal|single|byte/i.test(t);

// The one abstract list page for every autodiscovered B1 entity: a Fiori list-report floorplan
// (DynamicPage + VariantManagement + FilterBar) over a server-paginated, infinite-scroll table.
// A saved view (variant) IS the OData call — select/filter/orderby/search are sent to the agent;
// the table does NO client-side processing (manualSortBy/manualFilters). Growing mode rides on B1
// server pagination ($top/$skip/$count/@odata.nextLink) ↔ TanStack useInfiniteQuery.
export function EntityListPage({ entity }: { entity: string }) {
  const navigate = useNavigate();
  const enabled = useQuery(orpc.entities.getEnabled.queryOptions());
  const schema = (enabled.data ?? []).find((e) => e.name === entity);
  const { variants, isAdmin, isLoading: variantsLoading, save, remove, setWidths } = useVariants("list", entity);

  // liveSpec = the applied view; it drives the query, the dirty marker and what a Save persists.
  // Null only for the brief window before the init effect below picks a real row (Standard is
  // always one of `variants`, so it's the guaranteed fallback — no client-side synthesizing).
  const [liveSpec, setLiveSpec] = useState<ListVariantDef | null>(null);
  const [selectedName, setSelectedName] = useState("");
  const [selectedCount, setSelectedCount] = useState(0);
  const [colsOpen, setColsOpen] = useState(false);
  // Column-picker draft: checkbox/drag/rename mutate ONLY this; Confirm commits it to liveSpec once.
  const [draft, setDraft] = useState<{ name: string; visible: boolean; label: string }[] | null>(null);
  // Column widths live in react-table's internal reducer; read back on pointer release (see below).
  const tableInstanceRef = useRef<AnalyticalTableInstance | null>(null);
  const lastWidthsRef = useRef<Record<string, number>>({});
  const widthsSaveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // Apply the user's default view once per entity: a personal default wins over the shared Standard.
  const initedFor = useRef<string>("");
  useEffect(() => {
    if (!schema || variantsLoading || initedFor.current === entity) return;
    initedFor.current = entity;
    const personal = variants.find((v) => v.isDefault && !v.shared && truthy(v.applyAutomatically));
    const def = personal ?? variants.find((v) => v.isDefault && truthy(v.applyAutomatically));
    setSelectedName(def?.name ?? "");
    setLiveSpec(def ? (def.definition as ListVariantDef) : null);
  }, [schema, variantsLoading, entity, variants]);

  const allProps = useMemo(() => schema?.properties ?? [], [schema]);
  // The view's rendered column set = its explicit columns, or every scalar schema property when it
  // pins none (Standard). SINGLE source of truth for both the OData $select sent to B1 and the table
  // columns — the list is always projected server-side, never fetched whole and hidden.
  const visibleCols = useMemo(
    () => (liveSpec?.select.length ? liveSpec.select : allProps.map((p) => p.name)),
    [liveSpec, allProps],
  );

  const list = useInfiniteQuery(
    orpc.entities.list.infiniteOptions({
      input: (skip: number) => ({
        entity,
        top: 501,
        skip,
        q: liveSpec?.search || undefined,
        select: [...visibleCols].sort(),
        filter: liveSpec?.filter.length ? liveSpec.filter : undefined,
        orderby: liveSpec?.orderby.length ? liveSpec.orderby : undefined,
      }),
      initialPageParam: 0,
      // Next page starts after the rows we already have; stop when B1 returns no nextLink.
      getNextPageParam: (lastPage, pages) =>
        lastPage.hasMore ? pages.reduce((n, p) => n + (p.rows?.length ?? 0), 0) : undefined,
      enabled: !!schema && !!liveSpec,
    }),
  );

  const rows = useMemo(() => (list.data?.pages ?? []).flatMap((p) => p.rows ?? []), [list.data]);
  const total = list.data?.pages?.[0]?.count ?? rows.length;

  const columns = useMemo(
    () =>
      visibleCols
        .map((n) => allProps.find((p) => p.name === n))
        .filter((p): p is NonNullable<typeof p> => !!p)
        .map((p) => ({
          id: p.name,
          Header: liveSpec?.labels?.[p.name] ?? p.name,
          accessor: (row: Record<string, unknown>) => cell(row[p.name]),
          ...(liveSpec?.widths?.[p.name] ? { width: liveSpec.widths[p.name] } : {}),
        })),
    [visibleCols, liveSpec, allProps],
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

  if (enabled.isPending) return <BusyIndicator active />;
  if (!schema) return <MessageStrip design="Negative" hideCloseButton style={{ margin: "1rem" }}>Entity “{entity}” is not enabled.</MessageStrip>;
  if (!liveSpec) return <BusyIndicator active />;

  const selectedDef = (variants.find((v) => v.name === selectedName)?.definition as ListVariantDef) ?? null;
  const dirty = !sameDef(liveSpec, selectedDef);

  const applyVariant = (name: string) => {
    setSelectedName(name);
    setLiveSpec((variants.find((v) => v.name === name)?.definition as ListVariantDef) ?? null);
  };

  const setCond = (field: string, op: FilterCond["op"], value: FilterCond["value"] | "") =>
    setLiveSpec((s) => {
      const rest = s!.filter.filter((c) => c.field !== field);
      const empty = value === "" || value == null;
      return { ...s!, filter: empty ? rest : [...rest, { field, op, value }] };
    });

  // ---- Column picker: a draft copy of visibility/order/labels; only Confirm touches liveSpec. ----
  const openColumns = () => {
    const hidden = allProps.map((p) => p.name).filter((n) => !visibleCols.includes(n));
    setDraft([...visibleCols, ...hidden].map((name) => ({ name, visible: visibleCols.includes(name), label: liveSpec.labels?.[name] ?? name })));
    setColsOpen(true);
  };
  const closeColumns = () => { setDraft(null); setColsOpen(false); };
  const confirmColumns = () => {
    if (!draft) return closeColumns();
    const order = draft.filter((d) => d.visible).map((d) => d.name);
    const schemaOrder = allProps.map((p) => p.name);
    const isDefaultOrder = order.length === schemaOrder.length && order.every((n, i) => n === schemaOrder[i]);
    const labels = Object.fromEntries(draft.filter((d) => d.label !== d.name).map((d) => [d.name, d.label]));
    setLiveSpec({ ...liveSpec, select: isDefaultOrder ? [] : order, labels });
    closeColumns();
  };

  // ponytail: no resize event; read react-table state on pointer release, debounce the save.
  const onColumnResizeEnd = () => {
    setTimeout(() => {
      const widths = tableInstanceRef.current?.state?.columnResizing?.columnWidths as Record<string, number> | undefined;
      if (!widths || sameDef(widths, lastWidthsRef.current)) return;
      lastWidthsRef.current = widths;
      setLiveSpec({ ...liveSpec, widths });
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
      onSelect={(e) => applyVariant(String(e.detail.selectedVariant.children))}
      onSaveAs={(e) => {
        const d = e.detail;
        const name = String(d.children);
        save.mutate(
          { page: "list", entity, name, definition: liveSpec, shared: truthy(d.global), isDefault: truthy(d.isDefault), applyAutomatically: truthy(d.applyAutomatically) },
          { onSuccess: () => setSelectedName(name) },
        );
      }}
      onSave={() => {
        const row = variants.find((v) => v.name === selectedName);
        if (row) save.mutate({ id: row.id, page: "list", entity, name: row.name, definition: liveSpec, shared: row.shared, isDefault: row.isDefault, applyAutomatically: truthy(row.applyAutomatically) });
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
          if (r && !r.isStandard) save.mutate({ id: r.id, page: "list", entity, name: String(up.children), definition: r.definition as ListVariantDef, shared: truthy(up.global), isDefault: truthy(up.isDefault), applyAutomatically: truthy(up.applyAutomatically) });
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
          applyAutomatically={truthy(v.applyAutomatically)}
          readOnly={!v.canManage || v.isStandard}
          hideDelete={!v.canManage || v.isStandard}
        >
          {v.name}
        </VariantItem>
      ))}
    </VariantManagement>
  );

  // One FilterGroupItem per field. String/key fields are shown in the bar; the rest live in the
  // "Adapt Filters" dialog (hiddenInFilterBar) so the bar isn't a wall of inputs.
  const filterItems = allProps.map((p) => {
    const cond = liveSpec.filter.find((c) => c.field === p.name);
    const isBool = /bool/i.test(p.type);
    const isDate = /date/i.test(p.type);
    const isNum = isNumeric(p.type);
    // Visibility is part of the view: an explicit filterBar set wins; else a default heuristic.
    // An active filter is always shown so its value can't hide off-screen.
    const bar = liveSpec.filterBar ?? [];
    const inBar = (bar.length ? bar.includes(p.name) : schema.keys.includes(p.name) || /string|char|memo/i.test(p.type)) || !!cond;
    const hiddenInFilterBar = !inBar;
    let control;
    if (isBool) {
      control = (
        <Select
          onChange={(e) => {
            const val = e.detail.selectedOption.getAttribute("data-val") ?? "";
            setCond(p.name, "eq", val === "" ? "" : val === "true");
          }}
        >
          <Option data-val="" selected={!cond}>Any</Option>
          <Option data-val="true" selected={cond?.value === true}>Yes</Option>
          <Option data-val="false" selected={cond?.value === false}>No</Option>
        </Select>
      );
    } else if (isDate) {
      // ISO so the server-side OData $filter literal is valid (B1 dates are unquoted ISO).
      control = <DatePicker formatPattern="yyyy-MM-dd" value={cond ? String(cond.value) : ""} onChange={(e) => setCond(p.name, "eq", e.detail.value)} />;
    } else {
      control = (
        <Input
          type={isNum ? "Number" : "Text"}
          value={cond ? String(cond.value) : ""}
          onChange={(e) => setCond(p.name, isNum ? "eq" : "contains", isNum ? Number(e.target.value) : e.target.value)}
        />
      );
    }
    return (
      <FilterGroupItem key={p.name} filterKey={p.name} label={p.name} active={!!cond} hiddenInFilterBar={hiddenInFilterBar}>
        {control}
      </FilterGroupItem>
    );
  });

  const countBar = (
    <Bar
      startContent={<Title level="H5">{entity} ({selectedCount}/{total})</Title>}
      endContent={<Button icon="action-settings" design="Transparent" onClick={() => (colsOpen ? closeColumns() : openColumns())}>Columns</Button>}
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
          heading={variantManagement}
          snappedHeading={variantManagement}
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
            onClear={() => setLiveSpec((s) => ({ ...s!, filter: [], search: "" }))}
            // Adapt Filters: the visible-filter set is part of the view, so persist it into liveSpec
            // (which makes it tracked + dirty). Filter VALUES edited in the dialog flow via onChange.
            onFiltersDialogSave={(e) => {
              const keys = e.detail.selectedFilterKeys;
              if (Array.isArray(keys)) setLiveSpec((s) => ({ ...s!, filterBar: keys as string[] }));
            }}
            // Restore = discard unsaved changes, revert to the selected view.
            onRestore={() => applyVariant(selectedName)}
            search={<Input placeholder="Search" value={liveSpec.search ?? ""} onChange={(e) => setLiveSpec((s) => ({ ...s!, search: e.target.value }))} />}
          >
            {filterItems}
          </FilterBar>
        </DynamicPageHeader>
      }
    >
      {list.error ? <MessageStrip design="Negative" hideCloseButton style={{ marginBottom: "0.5rem" }}>{list.error.message}</MessageStrip> : null}
      <Card style={{ height: "100%", marginBottom: "1rem" }} onPointerUp={onColumnResizeEnd}>
        <AnalyticalTable
          columns={columns}
          data={rows}
          reactTableOptions={reactTableOptions}
          extension={countBar}
          loading={list.isFetching && !list.isFetchingNextPage}
          minRows={1}
          visibleRows={15}
          visibleRowCountMode="AutoWithEmptyRows"
          infiniteScroll
          tableInstance={tableInstanceRef}
          retainColumnWidth
          onLoadMore={() => { if (list.hasNextPage && !list.isFetchingNextPage) list.fetchNextPage(); }}
          onRowSelect={(e) => setSelectedCount(Object.values(e.detail.selectedRowIds).filter(Boolean).length)}
          onRowClick={(e) => navigate({ to: "/$entity/$id", params: { entity, id: String(e.detail.row.original[schema.keys[0]!]) } })}
          // Sort routes to the server query, not client-side (manualSortBy). Single-column for v1.
          // ponytail: multi-sort -> push each into orderby instead of replacing.
          onSort={(e) => {
            const col = (e.detail.column as { id?: string }).id;
            const dir = e.detail.sortDirection;
            if (!col) return;
            setLiveSpec((s) => ({ ...s!, orderby: dir === "asc" || dir === "desc" ? [{ field: col, dir }] : [] }));
          }}
          onColumnsReorder={(e) => {
            const order = e.detail.columnsNewOrder.map((c) => (c as { id?: string }).id).filter((id): id is string => !!id);
            if (order.length) setLiveSpec((s) => ({ ...s!, select: order }));
          }}
          selectionBehavior="Row"
          selectionMode="Multiple"
          sortable
        />
      </Card>
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
