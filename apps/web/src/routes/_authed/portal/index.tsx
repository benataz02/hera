import { useMemo } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { IllustratedMessage, Button, ObjectStatus, Text, Toolbar, ToolbarButton } from "@ui5/webcomponents-react";
import "@ui5/webcomponents-fiori/dist/illustrations/NoEntries.js";
import { orpc } from "../../../orpc.ts";
import { applySpec, useListSpec, type ListColumn } from "../../../variants.ts";
import { ListReport } from "../../../components/ListReport.tsx";
import { portalStatusUi, type PortalStatus } from "../../../components/portal/portalUi.ts";

export const Route = createFileRoute("/_authed/portal/")({ component: MyRequests });

// Read the value off `cell`, not the documented top-level `value` prop: AnalyticalTable's
// CellInstance Omit<>s over an index signature, which erases the flattened props from the type.
const StatusCell = ({ cell }: { cell: { value?: unknown } }) => {
  const ui = portalStatusUi[cell.value as PortalStatus];
  return ui ? <ObjectStatus state={ui.state}>{ui.text}</ObjectStatus> : <Text>{String(cell.value ?? "")}</Text>;
};

const COLUMNS: ListColumn[] = [
  { name: "name", type: "string", label: "Name" },
  { name: "modelName", type: "string", label: "Product" },
  {
    name: "status",
    type: "enum",
    label: "Status",
    options: Object.entries(portalStatusUi).map(([value, ui]) => ({ value, text: ui.text })),
    Cell: StatusCell,
  },
  { name: "updatedAt", type: "date", label: "Updated" },
];

const noData = (reason: "Empty" | "Filtered") =>
  reason === "Filtered" ? (
    <IllustratedMessage name="NoEntries" design="Auto" titleText="Nothing in this view"
      subtitleText="Try a different filter." />
  ) : (
    <IllustratedMessage name="NoEntries" design="Auto" titleText="No requests yet"
      subtitleText="Configure a product and request a quote from your supplier." />
  );

function MyRequests() {
  const navigate = useNavigate();
  const q = useQuery(orpc.portal.projects.list.queryOptions());

  // `portal:` keys are read-only views (variants.ts) — a portal client cannot save one, so the
  // page gets the ListReport chrome without a variant switcher. This key is deliberately not
  // seeded: an empty spec means every column, which is exactly the four below.
  const listSpec = useListSpec("portal:projects");
  const rows = useMemo(() => applySpec(q.data ?? [], listSpec.spec, COLUMNS), [q.data, listSpec.spec]);

  return (
    <ListReport
      listSpec={listSpec}
      title="My requests"
      columns={COLUMNS}
      keyField="id"
      rows={rows}
      total={rows.length}
      loading={q.isFetching}
      error={q.error}
      onRowClick={(row) => navigate({ to: "/portal/$id", params: { id: String(row.id) } })}
      noData={noData}
      actions={
        <Toolbar design="Transparent">
          {/* "New request" left the nav in favour of five document items; it lives here now. */}
          <ToolbarButton design="Emphasized" text="New request" onClick={() => navigate({ to: "/portal/new" })} />
        </Toolbar>
      }
    />
  );
}
