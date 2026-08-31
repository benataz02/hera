import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
  Card, CardHeader, DynamicPage, DynamicPageTitle, MessageStrip, ObjectStatus,
  Table, TableCell, TableHeaderCell, TableHeaderRow, TableRow, Text, Timeline, TimelineItem, Title,
  Toolbar,
  ToolbarButton,
} from "@ui5/webcomponents-react";
import { PrintActions } from "../b1/PrintActions.tsx";
import "@ui5/webcomponents-icons/dist/create-form.js";
import "@ui5/webcomponents-icons/dist/paper-plane.js";
import "@ui5/webcomponents-icons/dist/sales-quote.js";
import "@ui5/webcomponents-icons/dist/decline.js";
import "@ui5/webcomponents-icons/dist/undo.js";
import type { Entries, ModelDef } from "@hera/config-engine";
import { orpc } from "../../orpc.ts";
import { candidateLabel, fmt, openKeys, type Sel } from "../configurator/runView.ts";
import { portalStatusUi, type PortalStatus } from "./portalUi.ts";
import type { PortalCandidate } from "./PortalCandidateDetail.tsx";

type Ev = { at: string; kind: "created" | "submitted" | "withdrawn" | "rejected" | "quoted"; note?: string };
const EV_UI: Record<Ev["kind"], { icon: string; text: string }> = {
  created: { icon: "create-form", text: "Request created" },
  submitted: { icon: "paper-plane", text: "Submitted to your supplier" },
  withdrawn: { icon: "undo", text: "Withdrawn" },
  rejected: { icon: "decline", text: "Sent back with changes requested" },
  quoted: { icon: "sales-quote", text: "Quoted" },
};

// The SAP half of the timeline. Same shape as EV_UI so the two merge into one list.
const DOC_UI: Record<"Quotations" | "Orders" | "DeliveryNotes" | "Invoices", { icon: string; text: string }> = {
  Quotations: { icon: "sales-quote", text: "Quotation" },
  Orders: { icon: "sales-order", text: "Sales order" },
  DeliveryNotes: { icon: "shipping-status", text: "Delivery" },
  Invoices: { icon: "monitor-payments", text: "Invoice" },
};

type TimelineEntry = {
  at: string;
  icon: string;
  title: string;
  state?: "Information";
  note?: string;
  doc?: { entity: keyof typeof DOC_UI; docEntry: number; docNum: number };
};

export function PortalRequestSummary({ project, model, latestRun, onWithdraw, onReopen, busy }: {
  project: { id: string; name: string; status: PortalStatus; rejectionNote: string | null; events: Ev[] };
  model: { name: string; definition: ModelDef };
  latestRun: { entries: Entries; candidates: PortalCandidate[]; selection: Sel[] | null } | null;
  onWithdraw: () => void;
  onReopen: () => void;
  busy: boolean;
}) {
  const quoted = useQuery({
    ...orpc.portal.quotedResult.queryOptions({ input: { projectId: project.id } }),
    enabled: project.status === "quoted",
  });
  const navigate = useNavigate();

  // The SAP chain only exists once HERA has written the quotation, which is exactly `quoted`.
  // Before that the timeline is what it has always been.
  const chain = useQuery({
    ...orpc.portal.docs.chain.queryOptions({ input: { projectId: project.id } }),
    enabled: project.status === "quoted",
  });

  const timeline = useMemo<TimelineEntry[]>(
    () =>
      [
        ...project.events.map((e) => ({ at: e.at, icon: EV_UI[e.kind].icon, title: EV_UI[e.kind].text, note: e.note })),
        ...(chain.data ?? []).map((d) => ({
          at: d.docDate,
          icon: DOC_UI[d.entity].icon,
          title: `${DOC_UI[d.entity].text} ${d.docNum || d.docEntry}`,
          state: "Information" as const,
          doc: { entity: d.entity, docEntry: d.docEntry, docNum: d.docNum },
        })),
      ]
        // ISO strings compare correctly as strings; B1 dates are date-only, HERA events are full
        // timestamps, so a same-day document sorts below the event that produced it. Good enough.
        .sort((a, b) => b.at.localeCompare(a.at)),
    [project.events, chain.data],
  );
  const st = portalStatusUi[project.status];
  const keys = latestRun ? openKeys(model.definition, latestRun.entries, latestRun.candidates) : [];

  // Pre-quote lines come from the sanitized run + stored selection; final prices from quotedResult.
  const lines =
    project.status === "quoted"
      ? (quoted.data?.lines ?? []).map((l) => ({ label: candidateLabel(keys, l.assignment), ...l }))
      : (latestRun?.selection ?? []).map((s) => {
          const c = latestRun!.candidates[s.candidateIdx]!;
          const b = c.perBatch.find((x) => x.batchQty === s.batchQty)!;
          return { label: candidateLabel(keys, c.assignment), batchQty: s.batchQty, unitPrice: b.unitPrice, total: b.total };
        });
  const grand = lines.reduce((sum, l) => sum + l.total, 0);

  return (
    <DynamicPage
      titleArea={
        <DynamicPageTitle
          heading={<Title level="H3">{project.name}</Title>}
          subheading={<Text>{model.name}</Text>}
          actionsBar={
            <Toolbar design="Transparent">
              <>
                {project.status === "requested" ? <ToolbarButton disabled={busy} onClick={onWithdraw} text="Withdraw" /> : null}
                {project.status === "rejected" ? <ToolbarButton design="Emphasized" disabled={busy} onClick={onReopen} text="Reopen as draft" /> : null}
                <ObjectStatus state={st.state}>{st.text}</ObjectStatus>
              </>
            </Toolbar>
          }
        />
      }
    >
      <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
        {project.status === "rejected" && project.rejectionNote ? (
          <MessageStrip design="Negative" hideCloseButton>Your supplier requested changes: {project.rejectionNote}</MessageStrip>
        ) : null}
        {project.status === "requested" ? (
          <MessageStrip design="Information" hideCloseButton>Prices are indicative until your supplier confirms the quote.</MessageStrip>
        ) : null}

        <Card header={<CardHeader titleText="Requested lines" />}>
          <Table headerRow={
            <TableHeaderRow>
              <TableHeaderCell><span>Configuration</span></TableHeaderCell>
              <TableHeaderCell horizontalAlign="End"><span>Quantity</span></TableHeaderCell>
              <TableHeaderCell horizontalAlign="End"><span>Unit price</span></TableHeaderCell>
              <TableHeaderCell horizontalAlign="End"><span>Total</span></TableHeaderCell>
            </TableHeaderRow>
          }>
            {lines.map((l, i) => (
              <TableRow key={i} rowKey={String(i)}>
                <TableCell><Text>{l.label}</Text></TableCell>
                <TableCell horizontalAlign="End"><Text>{fmt(l.batchQty)}</Text></TableCell>
                <TableCell horizontalAlign="End"><Text>{fmt(l.unitPrice)}</Text></TableCell>
                <TableCell horizontalAlign="End"><Text>{fmt(l.total)}</Text></TableCell>
              </TableRow>
            ))}
          </Table>
          <div style={{ display: "flex", justifyContent: "flex-end", padding: "0.75rem" }}>
            <Title level="H5">Total: {fmt(grand)}</Title>
          </div>
        </Card>

        <Card header={<CardHeader titleText="History" />}>
          {chain.error ? <MessageStrip design="Negative" hideCloseButton>{chain.error.message}</MessageStrip> : null}
          <Timeline>
            {timeline.map((e, i) => (
              <TimelineItem
                key={i}
                icon={e.icon}
                titleText={e.title}
                subtitleText={new Date(e.at).toLocaleDateString()}
                {...(e.state ? { state: e.state } : {})}
                // TimelineItem makes `name` clickable, not `titleText` — hence the doc number here.
                {...(e.doc
                  ? {
                      name: `#${e.doc.docNum || e.doc.docEntry}`,
                      nameClickable: true,
                      onNameClick: () =>
                        navigate({
                          to: "/portal/docs/$entity/$key",
                          params: { entity: e.doc!.entity, key: String(e.doc!.docEntry) },
                        }),
                    }
                  : {})}
              >
                {e.doc ? <PrintActions entity={e.doc.entity} docEntry={e.doc.docEntry} scope="portal" /> : null}
                {e.note ? <Text>{e.note}</Text> : null}
              </TimelineItem>
            ))}
          </Timeline>
        </Card>
      </div>
    </DynamicPage>
  );
}
