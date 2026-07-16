import { useQuery, keepPreviousData } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import {
  BusyIndicator, Button, Card, CardHeader, MessageStrip, Tab, TabContainer, Table, TableCell, TableHeaderCell,
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

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

const chipDesign = (score: number) => (score >= 0.99 ? "Positive" : score > 0 ? "Critical" : "Neutral");

function Similar({ projectId, model, entries, onCopy }: {
  projectId: string;
  model: ModelDef;
  entries: Entries;
  onCopy: (v: Record<string, Val>) => void;
}) {
  const h = model.history;
  const debounced = useDebounced(entries, 500);
  const anyFilled = !!h?.mappings.some((m) => {
    const v = debounced[m.param];
    return v !== undefined && v !== null && v !== "";
  });
  const q = useQuery({
    ...orpc.configs.similar.queryOptions({ input: { id: projectId, entries: debounced } }),
    enabled: anyFilled,
    placeholderData: keepPreviousData, // re-rank without flashing while typing
    staleTime: 30_000,
  });
  const labelOf = (key: string) => model.parameters.find((p) => p.key === key)?.label ?? key;

  if (!h?.mappings.length)
    return <Text>No similarity mappings configured for this model (model builder → History).</Text>;
  if (!anyFilled) return <Text>Fill a mapped parameter to find similar past configurations.</Text>;
  if (q.isPending) return <BusyIndicator active delay={0} style={{ width: "100%", marginTop: "2rem" }} />;
  if (q.error) return <MessageStrip design="Information" hideCloseButton>{q.error.message}</MessageStrip>;
  if (!q.data.results.length)
    return <Text>No historic rows yet — an admin can press "Sync now" in the model's History tab.</Text>;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem", opacity: q.isFetching ? 0.6 : 1 }}>
      {q.data.results.map((r, i) => (
        <Card key={i}
          header={
            <CardHeader
              titleText={`${Math.round(r.score * 100)}% match`}
              subtitleText={Object.entries(r.display).map(([k, v]) => `${k}: ${String(v ?? "—")}`).join(" · ")}
              action={<Button design="Emphasized" icon="copy" onClick={() => onCopy(r.values)}>Use values</Button>}
            />
          }>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "0.25rem", padding: "0 1rem 1rem" }}>
            {r.matches.map((m) => (
              <Tag key={m.param} design={chipDesign(m.score)} hideStateIcon>
                {labelOf(m.param)}: {String(m.value ?? "—")}
              </Tag>
            ))}
          </div>
        </Card>
      ))}
    </div>
  );
}
