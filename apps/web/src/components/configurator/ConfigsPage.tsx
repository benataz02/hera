import { useCallback, useMemo } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  IllustratedMessage, ObjectStatus, Text, Toolbar, ToolbarButton,
} from "@ui5/webcomponents-react";
import "@ui5/webcomponents-fiori/dist/illustrations/NoData.js";
import { orpc } from "../../orpc.ts";
import { applySpec, useListSpec, type ListColumn } from "../../variants.ts";
import { ListReport } from "../ListReport.tsx";
import { statusUi } from "./runView.ts";
import { confirm } from "../confirm.ts";
import { toast } from "../toast.ts";

// Read the value off `cell`, not the documented top-level `value` prop: AnalyticalTable's
// CellInstance Omit<>s over an index signature, which erases the flattened props from the type.
// Both exist at runtime; only this one type-checks.
const StatusCell = ({ cell }: { cell: { value?: unknown } }) => {
  const ui = statusUi[cell.value as keyof typeof statusUi];
  return ui ? <ObjectStatus state={ui.state}>{ui.text}</ObjectStatus> : <Text>{String(cell.value ?? "")}</Text>;
};

// `customer` is jsonb; it's flattened to customerName below so it can be filtered/sorted/searched
// like any other column instead of needing its own cell renderer.
const COLUMNS: ListColumn[] = [
  { name: "name", type: "string", label: "Name" },
  { name: "modelName", type: "string", label: "Model" },
  { name: "customerName", type: "string", label: "Customer" },
  {
    name: "status",
    type: "enum",
    label: "Status",
    options: Object.entries(statusUi).map(([value, ui]) => ({ value, text: ui.text })),
    Cell: StatusCell,
  },
  { name: "updatedAt", type: "date", label: "Last changed" },
];

const noData = (reason: "Empty" | "Filtered") =>
  reason === "Filtered" ? (
    <IllustratedMessage name="NoData" design="Auto" titleText="Nothing in this view"
      subtitleText="Try a different filter or pick another view." />
  ) : (
    <IllustratedMessage name="NoData" design="Auto" titleText="No configurations yet"
      subtitleText="Create a configuration to start pricing a build." />
  );

export function ConfigsPage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const configs = useQuery(orpc.configs.list.queryOptions());
  const models = useQuery(orpc.configs.models.queryOptions());
  const invalidate = () => qc.invalidateQueries({ queryKey: orpc.configs.list.queryOptions().queryKey });

  // The list endpoint returns the whole array, so the view runs locally instead of compiling to OData.
  // The old Requested/In-progress SegmentedButton is now the seeded shared "Requested" view.
  const listSpec = useListSpec("configs");
  const flat = useMemo(
    () => (configs.data ?? []).map((c) => ({ ...c, customerName: c.customer?.cardName ?? "—" })),
    [configs.data],
  );
  const rows = useMemo(() => applySpec(flat, listSpec.spec, COLUMNS), [flat, listSpec.spec]);

  // No create dialog: a new configuration is an empty draft on the first model, and name / model /
  // business partner are filled in on its own General section.
  const create = useMutation(
    orpc.configs.create.mutationOptions({
      onSuccess: (r) => {
        invalidate();
        navigate({ to: "/configs/$id", params: { id: r.id } });
      },
    }),
  );
  const remove = useMutation(orpc.configs.remove.mutationOptions({ onSuccess: invalidate }));

  const onDelete = useCallback(
    async (selected: Record<string, unknown>[]) => {
      const one = selected.length === 1;
      const ok = await confirm({
        title: one ? "Delete configuration" : "Delete configurations",
        message: one
          ? `Delete "${String(selected[0]!.name)}"? This also removes its calculation runs and can't be undone.`
          : `Delete ${selected.length} configurations? This also removes their calculation runs and can't be undone.`,
        actionText: "Delete",
        destructive: true,
      });
      if (!ok) return false; // keep the selection — the user backed out
      // ponytail: sequential; a rejected delete aborts the rest and surfaces via remove.error.
      for (const r of selected) await remove.mutateAsync({ id: String(r.id) });
      toast(one ? "Configuration deleted" : `${selected.length} configurations deleted`);
    },
    [remove],
  );

  const first = models.data?.[0]?.id;

  return (
    <ListReport
      listSpec={listSpec}
      title="Configurations"
      columns={COLUMNS}
      keyField="id"
      rows={rows}
      total={rows.length}
      loading={configs.isFetching}
      error={configs.error ?? remove.error ?? create.error}
      onRowClick={(row) => navigate({ to: "/configs/$id", params: { id: String(row.id) } })}
      onDelete={onDelete}
      noData={noData}
      actions={
        <Toolbar design="Transparent">
          <ToolbarButton
            design="Emphasized"
            disabled={!first || create.isPending}
            tooltip={first ? undefined : "No configurator models yet — an admin creates those first."}
            onClick={() => { if (first) create.mutate({ modelId: first }); }}
            text={create.isPending ? "Creating…" : "New configuration"}
          />
        </Toolbar>
      }
    />
  );
}
