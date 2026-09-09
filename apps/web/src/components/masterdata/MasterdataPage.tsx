import { useCallback, useMemo } from "react";
import { useNavigate } from "@tanstack/react-router";
import { keepPreviousData, useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { IllustratedMessage, Toolbar, ToolbarButton } from "@ui5/webcomponents-react";
import "@ui5/webcomponents-fiori/dist/illustrations/AddColumn.js";
import { orpc } from "../../orpc.ts";
import { listQuery, useListSpec, type ListColumn } from "../../variants.ts";
import { ListReport } from "../ListReport.tsx";
import { confirm } from "../confirm.ts";
import { toast } from "../toast.ts";

// Tenant masterdata: one list for both kinds. A "table" keeps its values here, a "query" reads
// them live from SAP — models reference either by name and never hold the definition.

const COLUMNS: ListColumn[] = [
  { name: "name", type: "string", label: "Name" },
  { name: "kind", type: "string", label: "Kind", options: [{ value: "Table", text: "Table" }, { value: "Query", text: "Query" }] },
  { name: "source", type: "string", label: "Source" },
  { name: "columnCount", type: "number", label: "Columns" },
  { name: "rowCount", type: "string", label: "Rows" },
  { name: "updatedAt", type: "date", label: "Last changed" },
];

const noData = () => (
  <IllustratedMessage name="AddColumn" design="Auto" titleText="No masterdata yet"
    subtitleText="Add a table for values you maintain here, or a query to read them live from SAP." />
);

export function MasterdataPage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  // masterdata.list still exists — MasterdataEditor and useDraftModel need whole rows. This page
  // pages masterdata.rows, which returns only the six display columns, so both keys go.
  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: orpc.masterdata.list.queryOptions().queryKey });
    void qc.invalidateQueries({ queryKey: orpc.masterdata.rows.key() });
  };

  // kind/source/columnCount/rowCount used to be derived here; they are SQL expressions now, because
  // a saved view has to sort and filter on them across pages this page no longer holds.
  const listSpec = useListSpec("masterdata");
  const page = useInfiniteQuery({
    ...orpc.masterdata.rows.infiniteOptions({
      input: (skip: number | undefined) => ({ spec: listQuery(listSpec.spec), top: 100, ...(skip ? { skip } : {}) }),
      initialPageParam: undefined as number | undefined,
      getNextPageParam: (last) => last.nextSkip,
    }),
    enabled: listSpec.ready,
    retry: false,
    placeholderData: keepPreviousData,
  });
  const rows = useMemo(() => (page.data?.pages ?? []).flatMap((p) => p.rows), [page.data]);

  const remove = useMutation(orpc.masterdata.remove.mutationOptions({ onSuccess: invalidate }));

  const onDelete = useCallback(
    async (selected: Record<string, unknown>[]) => {
      const one = selected.length === 1;
      // Masterdata is shared across models and deletion is immediate: a model that references a
      // deleted name fails its lookups at resolve time (names live inside jsonb, so nothing here
      // can check them first).
      const ok = await confirm({
        title: one ? "Delete table" : "Delete tables",
        message: one
          ? `Delete "${String(selected[0]!.name)}"? Models that reference it by name will fail their lookups. This can't be undone.`
          : `Delete ${selected.length} tables? Models that reference them by name will fail their lookups. This can't be undone.`,
        actionText: "Delete",
        destructive: true,
      });
      if (!ok) return false; // keep the selection — the user backed out
      // ponytail: sequential; a rejected delete aborts the rest and surfaces via remove.error.
      for (const r of selected) await remove.mutateAsync({ id: String(r.id) });
      toast(one ? "Table deleted" : `${selected.length} tables deleted`);
    },
    [remove],
  );

  return (
    <ListReport
      listSpec={listSpec}
      title="Masterdata"
      columns={COLUMNS}
      keyField="id"
      rows={rows}
      total={page.data?.pages[0]?.total ?? rows.length}
      loading={page.isFetching && !page.isFetchingNextPage}
      error={page.error ?? remove.error}
      hasMore={page.hasNextPage}
      onLoadMore={() => { if (!page.isFetchingNextPage) void page.fetchNextPage(); }}
      onRowClick={(row) => navigate({ to: "/masterdata/$id", params: { id: String(row.id) } })}
      onDelete={onDelete}
      noData={noData}
      actions={
        <Toolbar design="Transparent">
          <ToolbarButton design="Emphasized" text="Create" onClick={() => navigate({ to: "/masterdata/new" })} />
        </Toolbar>
      }
    />
  );
}
