import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Bar, Button, BusyIndicator, Dialog, DynamicPage, DynamicPageTitle, IllustratedMessage, Input, Label, MessageStrip,
  ObjectStatus, Option, Select, SegmentedButton, SegmentedButtonItem, Table, TableCell, TableHeaderCell,
  TableHeaderRow, TableRow, TableRowAction, Text, Title,
  Toolbar,
  ToolbarButton,
} from "@ui5/webcomponents-react";
import "@ui5/webcomponents-fiori/dist/illustrations/NoData.js";
import { orpc } from "../../orpc.ts";
import { statusUi } from "./runView.ts";
import { confirm } from "../confirm.ts";
import { toast } from "../toast.ts";

export function ConfigsPage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const configs = useQuery(orpc.configs.list.queryOptions());
  const models = useQuery(orpc.configs.models.queryOptions());
  const invalidate = () => qc.invalidateQueries({ queryKey: orpc.configs.list.queryOptions().queryKey });

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
  const remove = useMutation(orpc.configs.remove.mutationOptions({
    onSuccess: () => { invalidate(); toast("Configuration deleted"); },
  }));
  const confirmRemove = async (id: string, name: string) => {
    if (await confirm({ title: "Delete configuration", message: `Delete "${name}"? This also removes its calculation runs and can't be undone.`, actionText: "Delete", destructive: true }))
      remove.mutate({ id });
  };

  const [filter, setFilter] = useState<"all" | "requested" | "inprogress" | "quoted" | "rejected">("all");
  const all = configs.data ?? [];
  const requestedCount = all.filter((c) => c.status === "requested").length;
  const rejectedCount = all.filter((c) => c.status === "rejected").length;
  // draft + calculated are both "in progress"; requested/quoted/rejected are terminal-ish states.
  const bucket = (s: string) =>
    s === "requested" ? "requested" : s === "quoted" ? "quoted" : s === "rejected" ? "rejected" : "inprogress";
  const rank = (s: string) => (s === "requested" ? 0 : 1); // requested floats to the top
  const shown = all
    .filter((c) => filter === "all" || bucket(c.status) === filter)
    .sort((a, b) => rank(a.status) - rank(b.status));

  if (configs.isPending) return <BusyIndicator active delay={0} style={{ width: "100%", marginTop: "4rem" }} />;

  return (
    <DynamicPage
      titleArea={
        <DynamicPageTitle
          heading={<Title level="H3">Configurations</Title>}
          actionsBar={
            <Toolbar design="Transparent">
              <ToolbarButton 
                design="Emphasized" 
                disabled={!models.data?.length}
                tooltip={models.data?.length ? undefined : "No configurator models yet — an admin creates those first."}
                onClick={() => { setNewName(""); setModelId(models.data?.[0]?.id ?? ""); setNewOpen(true); }}
                text="New configuration">
              </ToolbarButton>
            </Toolbar>
          }
        />
      }
    >
      {configs.error ? <MessageStrip design="Negative" hideCloseButton>{configs.error.message}</MessageStrip> : null}
      {remove.error ? <MessageStrip design="Negative" hideCloseButton>{remove.error.message}</MessageStrip> : null}

      <SegmentedButton onSelectionChange={(e) =>
        setFilter(((e.detail.selectedItems[0] as HTMLElement).dataset.f ?? "all") as typeof filter)}>
        <SegmentedButtonItem data-f="all" selected={filter === "all"}>All</SegmentedButtonItem>
        <SegmentedButtonItem data-f="requested" selected={filter === "requested"}>Requested ({requestedCount})</SegmentedButtonItem>
        <SegmentedButtonItem data-f="inprogress" selected={filter === "inprogress"}>In progress</SegmentedButtonItem>
        <SegmentedButtonItem data-f="quoted" selected={filter === "quoted"}>Quoted</SegmentedButtonItem>
        <SegmentedButtonItem data-f="rejected" selected={filter === "rejected"}>Rejected ({rejectedCount})</SegmentedButtonItem>
      </SegmentedButton>

      <Table
        noData={
          <IllustratedMessage name="NoData" design="Dot"
            titleText={all.length === 0 ? "No configurations yet" : "Nothing in this view"}
            subtitleText={all.length === 0 ? "Create a configuration to start pricing a build." : "Try a different filter above."} />
        }
        rowActionCount={1}
        onRowClick={(e) => {
          const id = (e.detail.row as HTMLElement).dataset.id;
          if (id) navigate({ to: "/configs/$id", params: { id } });
        }}
        onRowActionClick={(e) => {
          const el = (e.detail.row as unknown) as HTMLElement;
          const id = el.dataset.id;
          if (id) void confirmRemove(id, el.dataset.name ?? "this configuration");
        }}
        headerRow={
          <TableHeaderRow sticky>
            <TableHeaderCell><span>Name</span></TableHeaderCell>
            <TableHeaderCell><span>Model</span></TableHeaderCell>
            <TableHeaderCell><span>Customer</span></TableHeaderCell>
            <TableHeaderCell><span>Status</span></TableHeaderCell>
            <TableHeaderCell><span>Last changed</span></TableHeaderCell>
          </TableHeaderRow>
        }
      >
        {shown.map((c) => (
          <TableRow key={c.id} rowKey={c.id} data-id={c.id} data-name={c.name} interactive
            actions={<TableRowAction icon="delete" text="Delete" />}>
            <TableCell><Text>{c.name}</Text></TableCell>
            <TableCell><Text>{c.modelName}</Text></TableCell>
            <TableCell><Text>{c.customer?.cardName ?? "—"}</Text></TableCell>
            <TableCell><ObjectStatus state={statusUi[c.status].state}>{statusUi[c.status].text}</ObjectStatus></TableCell>
            <TableCell><Text>{new Date(c.updatedAt).toLocaleString()}</Text></TableCell>
          </TableRow>
        ))}
      </Table>

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
          <Select onChange={(e) => setModelId((e.detail.selectedOption as HTMLElement).dataset.id ?? "")}>
            {(models.data ?? []).map((m) => (
              <Option key={m.id} data-id={m.id} selected={m.id === modelId}>{m.name}</Option>
            ))}
          </Select>
        </div>
      </Dialog>
    </DynamicPage>
  );
}
