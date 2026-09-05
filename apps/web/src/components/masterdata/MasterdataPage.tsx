import { useCallback, useMemo } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { IllustratedMessage, Toolbar, ToolbarButton } from "@ui5/webcomponents-react";
import "@ui5/webcomponents-fiori/dist/illustrations/AddColumn.js";
import { orpc } from "../../orpc.ts";
import { applySpec, useListSpec, type ListColumn } from "../../variants.ts";
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
  const list = useQuery(orpc.masterdata.list.queryOptions());
  const invalidate = () => qc.invalidateQueries({ queryKey: orpc.masterdata.list.queryOptions().queryKey });

  // The list endpoint returns the whole array, so the view runs locally instead of compiling to OData.
  const listSpec = useListSpec("masterdata");
  const rows = useMemo(
    () =>
      applySpec(
        (list.data ?? []).map((t) => ({
          id: t.id,
          name: t.name,
          kind: t.kind === "query" ? "Query" : "Table",
          source: t.kind === "query"
            ? `${t.query?.target === "beas" ? "Beas" : "B1"} · ${t.query?.query.entitySet || "no entity set"}`
            : "Maintained here",
          columnCount: t.kind === "query" ? (t.query?.columns.length ?? 0) : t.columns.length,
          rowCount: t.kind === "query" ? "Live" : String(t.rows.length),
          updatedAt: t.updatedAt,
        })),
        listSpec.spec,
        COLUMNS,
      ),
    [list.data, listSpec.spec],
  );

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
      total={rows.length}
      loading={list.isFetching}
      error={list.error ?? remove.error}
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
