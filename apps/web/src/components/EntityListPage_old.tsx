import { useMemo, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useInfiniteQuery, useMutation, useQuery } from "@tanstack/react-query";
import {
  DynamicPage, DynamicPageHeader, DynamicPageTitle,
  FilterBar, VariantManagement, VariantItem,
  AnalyticalTable, Bar, Title, ObjectStatus, Input, Button,
  Dialog, MessageStrip, BusyIndicator,
} from "@ui5/webcomponents-react";
import { orpc } from "../orpc.ts";
import { EntityForm } from "./EntityForm.tsx";

const cell = (v: unknown) => (v == null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v));

// The one abstract list page for every autodiscovered B1 entity: a Fiori list-report floorplan
// (DynamicPage + VariantManagement + FilterBar) over a server-paginated, infinite-scroll table.
// Schema (columns/keys/editable) comes from entities.getEnabled; rows stream from entities.list.
export function EntityListPage({ entity }: { entity: string }) {
  const navigate = useNavigate();
  const enabled = useQuery(orpc.entities.getEnabled.queryOptions());
  const schema = (enabled.data ?? []).find((e) => e.name === entity);

  const [search, setSearch] = useState("");
  const [creating, setCreating] = useState(false);

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
  const total = list.data?.pages[0]?.count ?? null;

  const columns = useMemo(
    () => (schema?.properties ?? []).map((p) => ({ id: p.name, Header: p.name, accessor: (row: Record<string, unknown>) => cell(row[p.name]) })),
    [schema],
  );
  // Rows append as you scroll — keep table state instead of resetting it on every data change.
  const reactTableOptions = useMemo(
    () => ({ autoResetSortBy: false, autoResetFilters: false, autoResetSelectedRows: false, autoResetPage: false }),
    [],
  );

  const editable = !!schema?.editable;
  const singleKey = (schema?.keys.length ?? 0) === 1;

  const create = useMutation(orpc.entities.create.mutationOptions());
  const submit = (formData: Record<string, unknown>) =>
    create.mutate({ entity, data: formData }, { onSuccess: () => { setCreating(false); list.refetch(); } });

  if (enabled.isPending) return <BusyIndicator active />;
  if (!schema) return <MessageStrip design="Negative" hideCloseButton style={{ margin: "1rem" }}>Entity “{entity}” is not enabled.</MessageStrip>;

  const countBar = (
    <Bar
      startContent={
          <Title level="H5">${entity} (${total ?? "…"})</Title>
      }
    />
  );

  return (
    <DynamicPage
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
          <FilterBar hideToolbar search={<Input placeholder="Search" onChange={(e) => setSearch(e.target.value)} />}>
            {/* ponytail: global $filter search only — add per-column FilterGroupItem children here when needed. */}
            <></>
          </FilterBar>
        </DynamicPageHeader>
      }
    >
      {list.error ? <MessageStrip design="Negative" hideCloseButton style={{ marginBottom: "0.5rem" }}>{list.error.message}</MessageStrip> : null}

      <AnalyticalTable
        columns={columns}
        data={rows}
        reactTableOptions={reactTableOptions}
        extension={countBar}
        loading={list.isFetching && !list.isFetchingNextPage}
        minRows={1}
        visibleRows={15}
        infiniteScroll
        onLoadMore={() => { if (list.hasNextPage && !list.isFetchingNextPage) list.fetchNextPage(); }}
        // Row click opens the object page (single-key entities only; entities.get takes one key).
        // ponytail: composite-key entities aren't navigable — same constraint as before.
        onRowClick={singleKey ? (e) => navigate({ to: "/$entity/$id", params: { entity, id: String(e.detail.row.original[schema.keys[0]!]) } }) : undefined}
      />

      {creating ? (
        <Dialog
          open
          headerText={`New ${entity}`}
          onClose={() => setCreating(false)}
          footer={<Bar endContent={<Button design="Transparent" onClick={() => setCreating(false)}>Cancel</Button>} />}
        >
          {create.error ? <MessageStrip design="Negative" hideCloseButton>{create.error.message}</MessageStrip> : null}
          <EntityForm
            properties={schema.properties}
            keys={schema.keys}
            initial={{}}
            busy={create.isPending}
            submitLabel="Create"
            onSubmit={submit}
          />
        </Dialog>
      ) : null}
    </DynamicPage>
  );
}
