import { useCallback, useMemo, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Bar, Button, Dialog, IllustratedMessage, Input, Label, MessageStrip, Toolbar, ToolbarButton,
} from "@ui5/webcomponents-react";
import "@ui5/webcomponents-fiori/dist/illustrations/AddColumn.js";
import type { ModelDef } from "@hera/config-engine";
import { orpc } from "../../orpc.ts";
import { applySpec, useListSpec, type ListColumn } from "../../variants.ts";
import { ListReport } from "../ListReport.tsx";
import { confirm } from "../confirm.ts";
import { toast } from "../toast.ts";

// Minimal valid model a new draft starts from; passes checkModel (unitCost is in pricing scope).
export function starterModel(name: string): ModelDef {
  return {
    name,
    parameters: [],
    structure: { sections: [{ key: "main", title: "General", groups: [{ key: "general", title: "General", params: [] }] }] },
    computed: [],
    constraints: [],
    bom: [],
    routing: [],
    pricing: { priceExpr: "unitCost * 1.2", quoteItemCode: "CFG" },
    batchDefaults: [1, 10, 100],
  };
}

const COLUMNS: ListColumn[] = [
  { name: "name", type: "string", label: "Name" },
  { name: "updatedAt", type: "date", label: "Last changed" },
];

const noData = () => (
  <IllustratedMessage name="AddColumn" design="Auto" titleText="No models yet"
    subtitleText="Create a configurator model to define parameters, rules and pricing." />
);

export function ModelsPage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const models = useQuery(orpc.models.list.queryOptions());
  const invalidate = () => qc.invalidateQueries({ queryKey: orpc.models.list.queryOptions().queryKey });

  // The list endpoint returns the whole array, so the view runs locally instead of compiling to OData.
  const listSpec = useListSpec("models");
  const rows = useMemo(() => applySpec(models.data ?? [], listSpec.spec, COLUMNS), [models.data, listSpec.spec]);

  const [newOpen, setNewOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const create = useMutation(
    orpc.models.save.mutationOptions({
      onSuccess: (r) => {
        invalidate();
        navigate({ to: "/models/$id", params: { id: r.id } });
      },
    }),
  );
  const remove = useMutation(orpc.models.remove.mutationOptions({ onSuccess: invalidate }));

  const onDelete = useCallback(
    async (selected: Record<string, unknown>[]) => {
      const one = selected.length === 1;
      // The server still refuses deleting in-use models; this guards accidental clicks on unused ones.
      const ok = await confirm({
        title: one ? "Delete model" : "Delete models",
        message: one
          ? `Delete "${String(selected[0]!.name)}"? This can't be undone.`
          : `Delete ${selected.length} models? This can't be undone.`,
        actionText: "Delete",
        destructive: true,
      });
      if (!ok) return false; // keep the selection — the user backed out
      // ponytail: sequential; a rejected in-use model aborts the rest and surfaces via remove.error.
      for (const r of selected) await remove.mutateAsync({ id: String(r.id) });
      toast(one ? "Model deleted" : `${selected.length} models deleted`);
    },
    [remove],
  );

  return (
    <>
      <ListReport
        listSpec={listSpec}
        title="Models"
        columns={COLUMNS}
        keyField="id"
        rows={rows}
        total={rows.length}
        loading={models.isFetching}
        error={models.error ?? remove.error}
        onRowClick={(row) => navigate({ to: "/models/$id", params: { id: String(row.id) } })}
        onDelete={onDelete}
        noData={noData}
        actions={
          <Toolbar design="Transparent">
            <ToolbarButton design="Emphasized" onClick={() => { setNewName(""); setNewOpen(true); }} text="New model" />
          </Toolbar>
        }
      />

      <Dialog
        open={newOpen}
        headerText="New model"
        onClose={() => setNewOpen(false)}
        footer={
          <Bar design="Footer" endContent={
            <>
              <Button design="Emphasized" disabled={!newName.trim() || create.isPending}
                onClick={() => create.mutate({ definition: starterModel(newName.trim()) })}>
                {create.isPending ? "Creating…" : "Create"}
              </Button>
              <Button onClick={() => setNewOpen(false)}>Cancel</Button>
            </>
          } />
        }
      >
        <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem", padding: "0.5rem 0" }}>
          {create.error ? <MessageStrip design="Negative" hideCloseButton>{create.error.message}</MessageStrip> : null}
          <Label for="new-model-name" required>Name</Label>
          <Input id="new-model-name" value={newName} onInput={(e) => setNewName(e.target.value)} />
        </div>
      </Dialog>
    </>
  );
}
