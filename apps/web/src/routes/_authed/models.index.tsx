import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import {
  DynamicPage, DynamicPageTitle, Toolbar, ToolbarButton, Title, Text, ObjectStatus, BusyIndicator,
  Table, TableHeaderRow, TableHeaderCell, TableRow, TableCell,
} from "@ui5/webcomponents-react";
import { orpc } from "../../orpc.ts";

export const Route = createFileRoute("/_authed/models/")({ component: ModelsList });

function ModelsList() {
  const navigate = useNavigate();
  const models = useQuery(orpc.models.list.queryOptions());

  return (
    <DynamicPage
      hidePinButton
      titleArea={
        <DynamicPageTitle
          heading={<Title level="H4">Models</Title>}
          actionsBar={<Toolbar design="Transparent"><ToolbarButton design="Emphasized" icon="add" text="New model" onClick={() => navigate({ to: "/models/$id", params: { id: "new" } })} /></Toolbar>}
        />
      }
    >
      {models.isPending ? (
        <BusyIndicator active />
      ) : (
        <Table
          headerRow={<TableHeaderRow><TableHeaderCell>Name</TableHeaderCell><TableHeaderCell>Family</TableHeaderCell><TableHeaderCell>Status</TableHeaderCell></TableHeaderRow>}
          noDataText="No models yet — create one"
        >
          {(models.data ?? []).map((m) => (
            <TableRow key={m.id} style={{ cursor: "pointer" }} onClick={() => navigate({ to: "/models/$id", params: { id: m.id } })}>
              <TableCell><Text>{m.name}</Text></TableCell>
              <TableCell><Text>{m.family}</Text></TableCell>
              <TableCell><ObjectStatus state={m.published ? "Positive" : "None"}>{m.published ? "Published" : "Draft"}</ObjectStatus></TableCell>
            </TableRow>
          ))}
        </Table>
      )}
    </DynamicPage>
  );
}
