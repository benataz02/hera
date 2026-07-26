import { useCallback, useMemo, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Bar, Button, Dialog, IllustratedMessage, Input, Label, MessageStrip, ObjectStatus, Option, Select,
  Text, Toolbar, ToolbarButton,
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

  const [newOpen, setNewOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [modelId, setModelId] = useState("");
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

  return (
    <>
      <ListReport
        listSpec={listSpec}
        title="Configurations"
        columns={COLUMNS}
        keyField="id"
        rows={rows}
        total={rows.length}
        loading={configs.isFetching}
        error={configs.error ?? remove.error}
        onRowClick={(row) => navigate({ to: "/configs/$id", params: { id: String(row.id) } })}
        onDelete={onDelete}
        noData={noData}
        actions={
          <Toolbar design="Transparent">
            <ToolbarButton
              design="Emphasized"
              disabled={!models.data?.length}
              tooltip={models.data?.length ? undefined : "No configurator models yet — an admin creates those first."}
              onClick={() => { setNewName(""); setModelId(models.data?.[0]?.id ?? ""); setNewOpen(true); }}
              text="New configuration"
            />
          </Toolbar>
        }
      />

      <Dialog
        open={newOpen}
        headerText="New configuration"
        onClose={() => setNewOpen(false)}
        footer={
          <Bar design="Footer" endContent={
            <>
              <Button design="Emphasized" disabled={!newName.trim() || !modelId || create.isPending}
                onClick={() => create.mutate({ modelId, name: newName.trim() })}>
                {create.isPending ? "Creating…" : "Create"}
              </Button>
              <Button onClick={() => setNewOpen(false)}>Cancel</Button>
            </>
          } />
        }
      >
        <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem", padding: "0.5rem 0" }}>
          {create.error ? <MessageStrip design="Negative" hideCloseButton>{create.error.message}</MessageStrip> : null}
          <Label for="new-config-name" required>Name</Label>
          <Input id="new-config-name" value={newName} onInput={(e) => setNewName(e.target.value)} />
          <Label required>Model</Label>
          <Select value={modelId} onChange={(e) => setModelId(e.detail.selectedOption.value ?? "")}>
            {(models.data ?? []).map((m) => (
              <Option key={m.id} value={m.id}>{m.name}</Option>
            ))}
          </Select>
        </div>
      </Dialog>
    </>
  );
}
