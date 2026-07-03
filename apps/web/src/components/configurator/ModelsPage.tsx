import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Bar, Button, BusyIndicator, Dialog, DynamicPage, DynamicPageTitle, Input, Label, MessageStrip,
  Table, TableCell, TableHeaderCell, TableHeaderRow, TableRow, TableRowAction, Text, Title,
} from "@ui5/webcomponents-react";
import type { ModelDef } from "@hera/config-engine";
import { orpc } from "../../orpc.ts";

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
    queryTables: [],
    pricing: { priceExpr: "unitCost * 1.2", quoteItemCode: "CFG" },
    batchDefaults: [1, 10, 100],
  };
}

export function ModelsPage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const models = useQuery(orpc.models.list.queryOptions());
  const invalidate = () => qc.invalidateQueries({ queryKey: orpc.models.list.queryOptions().queryKey });

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

  if (models.isPending) return <BusyIndicator active delay={0} style={{ width: "100%", marginTop: "4rem" }} />;

  return (
    <DynamicPage
      titleArea={
        <DynamicPageTitle
          heading={<Title level="H3">Configurator models</Title>}
          actionsBar={
            <Bar design="Header" endContent={
              <Button design="Emphasized" onClick={() => { setNewName(""); setNewOpen(true); }}>New model</Button>
            } />
          }
        />
      }
    >
      {models.error ? <MessageStrip design="Negative" hideCloseButton>{models.error.message}</MessageStrip> : null}
      {remove.error ? <MessageStrip design="Negative" hideCloseButton>{remove.error.message}</MessageStrip> : null}

      <Table
        noDataText="No models yet — create one to start."
        rowActionCount={1}
        onRowClick={(e) => {
          const id = (e.detail.row as HTMLElement).dataset.id;
          if (id) navigate({ to: "/models/$id", params: { id } });
        }}
        onRowActionClick={(e) => {
          const id = ((e.detail.row as unknown) as HTMLElement).dataset.id;
          // ponytail: no confirm dialog — server refuses deletion of in-use models anyway
          if (id) remove.mutate({ id });
        }}
        headerRow={
          <TableHeaderRow sticky>
            <TableHeaderCell><span>Name</span></TableHeaderCell>
            <TableHeaderCell><span>Last changed</span></TableHeaderCell>
          </TableHeaderRow>
        }
      >
        {(models.data ?? []).map((m) => (
          <TableRow key={m.id} rowKey={m.id} data-id={m.id} interactive
            actions={<TableRowAction icon="delete" text="Delete" />}>
            <TableCell><Text>{m.name}</Text></TableCell>
            <TableCell><Text>{new Date(m.updatedAt).toLocaleString()}</Text></TableCell>
          </TableRow>
        ))}
      </Table>

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
    </DynamicPage>
  );
}
