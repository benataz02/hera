import { useQuery } from "@tanstack/react-query";
import {
  BusyIndicator, Button, MessageStrip, Tab, TabContainer, Table, TableCell, TableHeaderCell,
  TableHeaderRow, TableRow, Tag, Text, Toolbar, ToolbarButton, ToolbarSpacer,
} from "@ui5/webcomponents-react";
import type { Entries, ModelDef, Val } from "@hera/config-engine";
import { orpc } from "../../orpc.ts";

// The process page's right-hand help pane: live B1 doc history + similar past configurations.
export function HistoryPane({ projectId, model, entries, onCopy }: {
  projectId: string;
  model: ModelDef;
  entries: Entries;
  onCopy: (values: Record<string, Val>) => void;
}) {
  const h = model.history;
  const rawItem = h?.itemCodeParam ? entries[h.itemCodeParam] : undefined;
  const itemCode = typeof rawItem === "string" && rawItem ? rawItem : undefined;
  return (
    <TabContainer style={{ height: "100%" }}>
      <Tab text="Customer & item history" icon="history" selected>
        <DocHistory projectId={projectId} itemCode={itemCode} />
      </Tab>
      <Tab text="Similar configurations" icon="detail-view">
        <Similar projectId={projectId} model={model} entries={entries} onCopy={onCopy} />
      </Tab>
    </TabContainer>
  );
}

const matchTag = {
  both: { design: "Positive", text: "customer + item" },
  item: { design: "Information", text: "item" },
  customer: { design: "Neutral", text: "customer" },
} as const;

function DocHistory({ projectId, itemCode }: { projectId: string; itemCode?: string }) {
  const q = useQuery({
    ...orpc.configs.docHistory.queryOptions({ input: { id: projectId, itemCode } }),
    staleTime: 5 * 60_000,
    retry: false, // agent-offline should show its message, not spin
  });
  if (q.isPending) return <BusyIndicator active delay={0} style={{ width: "100%", marginTop: "2rem" }} />;
  if (q.error)
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
        <MessageStrip design="Information" hideCloseButton>{q.error.message}</MessageStrip>
        <Button style={{ alignSelf: "start" }} onClick={() => void q.refetch()}>Retry</Button>
      </div>
    );
  const { rows, cardCode, itemCode: usedItem } = q.data;
  if (!cardCode && !usedItem)
    return <Text>Assign a customer to this configuration or fill the item parameter to see past documents.</Text>;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "0.25rem" }}>
      <Toolbar design="Transparent">
        <Text>{[cardCode && `customer ${cardCode}`, usedItem && `item ${usedItem}`].filter(Boolean).join(" · ")}</Text>
        <ToolbarSpacer />
        <ToolbarButton icon="refresh" disabled={q.isFetching} onClick={() => void q.refetch()} />
      </Toolbar>
      <Table overflowMode="Popin" noDataText="No recent orders or quotations."
        headerRow={
          <TableHeaderRow>
            <TableHeaderCell width="7rem"><span>Doc</span></TableHeaderCell>
            <TableHeaderCell width="6.5rem"><span>Date</span></TableHeaderCell>
            <TableHeaderCell><span>Customer</span></TableHeaderCell>
            <TableHeaderCell><span>Item</span></TableHeaderCell>
            <TableHeaderCell width="4rem"><span>Qty</span></TableHeaderCell>
            <TableHeaderCell width="6rem"><span>Unit price</span></TableHeaderCell>
            <TableHeaderCell width="8rem"><span>Match</span></TableHeaderCell>
          </TableHeaderRow>
        }>
        {rows.map((r, i) => (
          <TableRow key={i} rowKey={`d-${i}`}>
            <TableCell><Text>{r.docType === "order" ? "SO" : "SQ"} {r.docNum}</Text></TableCell>
            <TableCell><Text>{r.docDate.slice(0, 10)}</Text></TableCell>
            <TableCell><Text>{r.cardName || r.cardCode}</Text></TableCell>
            <TableCell><Text>{r.itemCode}</Text></TableCell>
            <TableCell><Text>{r.quantity}</Text></TableCell>
            <TableCell><Text>{r.unitPrice}</Text></TableCell>
            <TableCell><Tag design={matchTag[r.matched].design} hideStateIcon>{matchTag[r.matched].text}</Tag></TableCell>
          </TableRow>
        ))}
      </Table>
    </div>
  );
}

// Filled in by the "similar configurations" task.
function Similar(_props: { projectId: string; model: ModelDef; entries: Entries; onCopy: (v: Record<string, Val>) => void }) {
  return <Text>Coming next.</Text>;
}
