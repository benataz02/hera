import { useMemo } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { BusyIndicator, MessageStrip } from "@ui5/webcomponents-react";
import { orpc } from "../orpc.ts";
import { useListSpec, visibleColumns, type ListColumn } from "../variants.ts";
import { ListReport } from "./ListReport.tsx";

// The B1 half of the list report: an autodiscovered entity schema supplies the columns, and the
// applied view compiles to the OData call the agent runs ($select/$filter/$orderby/$top/$skip).
// Growing mode rides on B1 server pagination (@odata.nextLink) ↔ TanStack useInfiniteQuery.
export function EntityListPage({ entity }: { entity: string }) {
  const navigate = useNavigate();
  const enabled = useQuery(orpc.entities.getEnabled.queryOptions());
  const schema = (enabled.data ?? []).find((e) => e.name === entity);
  const listSpec = useListSpec(entity);
  const { spec, ready } = listSpec;

  const columns = useMemo<ListColumn[]>(() => schema?.properties ?? [], [schema]);
  const visibleCols = useMemo(() => visibleColumns(spec, columns), [spec, columns]);

  const list = useInfiniteQuery(
    orpc.entities.list.infiniteOptions({
      input: (skip: number) => ({
        entity,
        top: 501,
        skip,
        q: spec.search || undefined,
        select: [...visibleCols].sort(),
        filter: spec.filter.length ? spec.filter : undefined,
        orderby: spec.orderby.length ? spec.orderby : undefined,
      }),
      initialPageParam: 0,
      // Next page starts after the rows we already have; stop when B1 returns no nextLink.
      getNextPageParam: (lastPage, pages) =>
        lastPage.hasMore ? pages.reduce((n, p) => n + (p.rows?.length ?? 0), 0) : undefined,
      enabled: !!schema && ready,
    }),
  );

  const rows = useMemo(() => (list.data?.pages ?? []).flatMap((p) => p.rows ?? []), [list.data]);

  if (enabled.isPending) return <BusyIndicator active />;
  if (!schema) return <MessageStrip design="Negative" hideCloseButton style={{ margin: "1rem" }}>Entity “{entity}” is not enabled.</MessageStrip>;

  return (
    <ListReport
      listSpec={listSpec}
      title={entity}
      columns={columns}
      keyField={schema.keys[0] ?? ""}
      rows={rows}
      total={list.data?.pages?.[0]?.count ?? rows.length}
      loading={list.isFetching && !list.isFetchingNextPage}
      error={list.error}
      hasMore={list.hasNextPage && !list.isFetchingNextPage}
      onLoadMore={() => list.fetchNextPage()}
      onRowClick={(row) => navigate({ to: "/$entity/$id", params: { entity, id: String(row[schema.keys[0]!]) } })}
    />
  );
}
