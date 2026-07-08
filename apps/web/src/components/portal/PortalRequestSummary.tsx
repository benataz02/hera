import { useQuery } from "@tanstack/react-query";
import {
  Bar, Button, Card, CardHeader, DynamicPage, DynamicPageTitle, MessageStrip, ObjectStatus,
  Table, TableCell, TableHeaderCell, TableHeaderRow, TableRow, Text, Timeline, TimelineItem, Title,
} from "@ui5/webcomponents-react";
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
            <Bar design="Header" endContent={
              <>
                {project.status === "requested" ? <Button disabled={busy} onClick={onWithdraw}>Withdraw</Button> : null}
                {project.status === "rejected" ? <Button design="Emphasized" disabled={busy} onClick={onReopen}>Reopen as draft</Button> : null}
                <ObjectStatus state={st.state}>{st.text}</ObjectStatus>
              </>
            } />
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
          <Timeline>
            {project.events.map((e, i) => (
              <TimelineItem key={i} icon={EV_UI[e.kind].icon} titleText={EV_UI[e.kind].text}
                subtitleText={new Date(e.at).toLocaleString()}>
                {e.note ? <Text>{e.note}</Text> : null}
              </TimelineItem>
            ))}
          </Timeline>
        </Card>
      </div>
    </DynamicPage>
  );
}
