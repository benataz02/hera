import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import {
  Bar, BusyIndicator, Button, DynamicPage, DynamicPageTitle, IllustratedMessage, MessageStrip,
  ObjectStatus, Table, TableCell, TableHeaderCell, TableHeaderRow, TableRow, Text, Title,
} from "@ui5/webcomponents-react";
import "@ui5/webcomponents-fiori/dist/illustrations/NoEntries.js";
import { orpc } from "../../../orpc.ts";
import { portalStatusUi, type PortalStatus } from "../../../components/portal/portalUi.ts";

export const Route = createFileRoute("/_authed/portal/")({ component: MyRequests });

function MyRequests() {
  const navigate = useNavigate();
  const q = useQuery(orpc.portal.projects.list.queryOptions());
  if (q.isPending) return <BusyIndicator active delay={0} style={{ width: "100%", marginTop: "4rem" }} />;

  return (
    <DynamicPage
      titleArea={
        <DynamicPageTitle
          heading={<Title level="H3">My requests</Title>}
          actionsBar={
            <Bar design="Header" endContent={
              <Button design="Emphasized" onClick={() => navigate({ to: "/portal/new" })}>New request</Button>
            } />
          }
        />
      }
    >
      {q.error ? <MessageStrip design="Negative" hideCloseButton>{q.error.message}</MessageStrip> : null}
      {q.data && q.data.length === 0 ? (
        <IllustratedMessage name="NoEntries" titleText="No requests yet"
          subtitleText="Configure a product and request a quote from your supplier.">
          <Button design="Emphasized" onClick={() => navigate({ to: "/portal/new" })}>New request</Button>
        </IllustratedMessage>
      ) : (
        <Table
          onRowClick={(e) => {
            const id = (e.detail.row as HTMLElement).dataset.id;
            if (id) navigate({ to: "/portal/$id", params: { id } });
          }}
          headerRow={
            <TableHeaderRow sticky>
              <TableHeaderCell><span>Name</span></TableHeaderCell>
              <TableHeaderCell><span>Product</span></TableHeaderCell>
              <TableHeaderCell><span>Status</span></TableHeaderCell>
              <TableHeaderCell><span>Updated</span></TableHeaderCell>
            </TableHeaderRow>
          }
        >
          {(q.data ?? []).map((p) => (
            <TableRow key={p.id} rowKey={p.id} data-id={p.id} interactive>
              <TableCell><Text>{p.name}</Text></TableCell>
              <TableCell><Text>{p.modelName}</Text></TableCell>
              <TableCell>
                <ObjectStatus state={portalStatusUi[p.status as PortalStatus].state}>
                  {portalStatusUi[p.status as PortalStatus].text}
                </ObjectStatus>
              </TableCell>
              <TableCell><Text>{new Date(p.updatedAt).toLocaleString()}</Text></TableCell>
            </TableRow>
          ))}
        </Table>
      )}
    </DynamicPage>
  );
}
