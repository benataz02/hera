import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import {
  DynamicPage, DynamicPageTitle, Toolbar, ToolbarButton, Title, Text, BusyIndicator,
  Table, TableHeaderRow, TableHeaderCell, TableRow, TableCell,
} from "@ui5/webcomponents-react";
import { orpc } from "../../orpc.ts";

export const Route = createFileRoute("/_authed/masterdata/")({ component: MasterdataList });

function MasterdataList() {
  const navigate = useNavigate();
  const list = useQuery(orpc.masterdata.list.queryOptions());

  return (
    <DynamicPage
      hidePinButton
      titleArea={
        <DynamicPageTitle
          heading={<Title level="H4">Master data</Title>}
          actionsBar={<Toolbar design="Transparent"><ToolbarButton design="Emphasized" icon="add" text="New master data" onClick={() => navigate({ to: "/masterdata/$id", params: { id: "new" } })} /></Toolbar>}
        />
      }
    >
      {list.isPending ? (
        <BusyIndicator active />
      ) : (
        <Table headerRow={<TableHeaderRow><TableHeaderCell>Name</TableHeaderCell><TableHeaderCell>Defined by</TableHeaderCell></TableHeaderRow>} noDataText="No master data yet — create one">
          {(list.data ?? []).map((m) => (
            <TableRow key={m.id} style={{ cursor: "pointer" }} onClick={() => navigate({ to: "/masterdata/$id", params: { id: m.id } })}>
              <TableCell><Text>{m.name}</Text></TableCell>
              <TableCell><Text>{m.kind === "query" ? "Query" : "Manual"}</Text></TableCell>
            </TableRow>
          ))}
        </Table>
      )}
    </DynamicPage>
  );
}
