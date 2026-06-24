import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import {
  DynamicPage, DynamicPageTitle, Toolbar, ToolbarButton, Title, Text, BusyIndicator,
  Table, TableHeaderRow, TableHeaderCell, TableRow, TableCell,
} from "@ui5/webcomponents-react";
import { orpc } from "../../orpc.ts";

export const Route = createFileRoute("/_authed/tables/")({ component: TablesList });

function TablesList() {
  const navigate = useNavigate();
  const tables = useQuery(orpc.tables.list.queryOptions());

  return (
    <DynamicPage
      hidePinButton
      titleArea={
        <DynamicPageTitle
          heading={<Title level="H4">Tables</Title>}
          actionsBar={<Toolbar design="Transparent"><ToolbarButton design="Emphasized" icon="add" text="New table" onClick={() => navigate({ to: "/tables/$id", params: { id: "new" } })} /></Toolbar>}
        />
      }
    >
      {tables.isPending ? (
        <BusyIndicator active />
      ) : (
        <Table headerRow={<TableHeaderRow><TableHeaderCell>Name</TableHeaderCell></TableHeaderRow>} noDataText="No tables yet — create one">
          {(tables.data ?? []).map((t) => (
            <TableRow key={t.id} style={{ cursor: "pointer" }} onClick={() => navigate({ to: "/tables/$id", params: { id: t.id } })}>
              <TableCell><Text>{t.name}</Text></TableCell>
            </TableRow>
          ))}
        </Table>
      )}
    </DynamicPage>
  );
}
