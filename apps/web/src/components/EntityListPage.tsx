import { useMemo, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import {
  DynamicPage, DynamicPageHeader, DynamicPageTitle,
  FilterBar, VariantManagement, VariantItem,
  AnalyticalTable, Bar, Title, Input,
  MessageStrip, BusyIndicator,
  Card,
} from "@ui5/webcomponents-react";
import { orpc } from "../orpc.ts";

const cell = (v: unknown) => (v == null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v));

// The one abstract list page for every autodiscovered B1 entity: a Fiori list-report floorplan
// (DynamicPage + VariantManagement + FilterBar) over a server-paginated, infinite-scroll table.
// Schema (columns/keys/editable) comes from entities.getEnabled; rows stream from entities.list.
export function EntityListPage({ entity }: { entity: string }) {
  const navigate = useNavigate();
  const enabled = useQuery(orpc.entities.getEnabled.queryOptions());
  const schema = (enabled.data ?? []).find((e) => e.name === entity);

  const [search, setSearch] = useState("");
  const [selectedCount, setSelectedCount] = useState(0);

  const list = useInfiniteQuery(
    orpc.entities.list.infiniteOptions({
      input: (skip: number) => ({ entity, top: 100, skip, q: search || undefined }),
      initialPageParam: 0,
      // Next page starts after the rows we already have; stop when B1 returns no nextLink.
      getNextPageParam: (lastPage, pages) =>
        lastPage.hasMore ? pages.reduce((n, p) => n + (p.rows?.length ?? 0), 0) : undefined,
      enabled: !!schema,
    }),
  );

  // `?? []` guards against a row-less page reaching react-table (undefined rows -> "subRows" crash).
  const rows = useMemo(() => (list.data?.pages ?? []).flatMap((p) => p.rows ?? []), [list.data]);
  // Server total ($count) when B1 returns it; otherwise the rows we've loaded so far.
  const total = list.data?.pages?.[0]?.count ?? rows.length;

  const columns = useMemo(
    () => (schema?.properties ?? []).map((p) => ({ id: p.name, Header: p.name, accessor: (row: Record<string, unknown>) => cell(row[p.name]) })),
    [schema],
  );
  // Rows append as you scroll — keep table state instead of resetting it on every data change.
  const reactTableOptions = useMemo(
    () => ({ autoResetSortBy: false, autoResetFilters: false, autoResetSelectedRows: false, autoResetPage: false }),
    [],
  );

  if (enabled.isPending) return <BusyIndicator active />;
  if (!schema) return <MessageStrip design="Negative" hideCloseButton style={{ margin: "1rem" }}>Entity “{entity}” is not enabled.</MessageStrip>;

  const countBar = (
    <Bar
      startContent={
        <Title level="H5">{entity} ({selectedCount}/{total})</Title>
      }
    />
  );

  return (
    <DynamicPage
      hidePinButton
      titleArea={
        <DynamicPageTitle
          // ponytail: single static variant — wire VariantManagement onSaveAs/onSelect to persisted views later.
          heading={
            <VariantManagement>
              <VariantItem selected>Standard</VariantItem>
            </VariantManagement>
          }
        />
      }
      headerArea={
        <DynamicPageHeader>
          <FilterBar
            hideToolbar 
            enableReordering
            showGoOnFB
            showClearOnFB
            search={<Input placeholder="Search" onChange={(e) => setSearch(e.target.value)} />}>
            {/* ponytail: global $filter search only — add per-column FilterGroupItem children here when needed. */}
          </FilterBar>
        </DynamicPageHeader>
      }
    >
      {list.error ? <MessageStrip design="Negative" hideCloseButton style={{ marginBottom: "0.5rem" }}>{list.error.message}</MessageStrip> : null}
      <Card style={{ height: "100%", marginBottom: "1rem" }}>
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
          onLoadMore={() => { if (list.hasNextPage && !list.isFetchingNextPage) list.fetchNextPage(); }}
          // Selection (checkbox) feeds the count bar; selectedRowIds is the only reliable source —
          // onRowSelect.detail.row is undefined on select-all.
          onRowSelect={(e) => setSelectedCount(Object.values(e.detail.selectedRowIds).filter(Boolean).length)}
          // Body click opens the object page (single-key entities only; entities.get takes one key).
          // onRowClick.detail.row is always defined, unlike onRowSelect's.
          // ponytail: composite-key entities aren't navigable — same constraint as before.
          onRowClick={(e) => navigate({ to: "/$entity/$id", params: { entity, id: String(e.detail.row.original[schema.keys[0]!]) } })}
          selectionBehavior="Row"
          selectionMode="Multiple"
          sortable
          filterable
        />
      </Card>
    </DynamicPage>
  );
}
