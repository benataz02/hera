import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Bar, Card, CardHeader, Dialog, Input, Button, ObjectStatus, Label,
  MessageStrip, FlexBox, Table, TableCell, TableHeaderCell, TableHeaderRow, TableRow, TableRowAction,
  Text, Toast,
} from "@ui5/webcomponents-react";
import { orpc } from "../../orpc.ts";
import { EntityValueHelp } from "../../components/ValueHelp.tsx";

export const Route = createFileRoute("/_authed/settings")({ component: Settings });

const CUSTOMER_SELECT = ["CardCode", "CardName"];
const CUSTOMER_FILTER = [{ field: "CardType", op: "eq" as const, value: "cCustomer" }];

function Settings() {
  const qc = useQueryClient();
  const clients = useQuery(orpc.portalClients.list.queryOptions());
  const [inviteOpen, setInviteOpen] = useState(false);
  const [invEmail, setInvEmail] = useState("");
  const [invCardCode, setInvCardCode] = useState("");
  const [acceptUrl, setAcceptUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const invite = useMutation(orpc.portalClients.invite.mutationOptions({
    onSuccess: (r) => {
      setAcceptUrl(`${window.location.origin}/accept?token=${r.token}`);
      qc.invalidateQueries({ queryKey: orpc.portalClients.list.queryOptions().queryKey });
    },
  }));
  const revoke = useMutation(orpc.portalClients.revoke.mutationOptions({
    onSuccess: () => qc.invalidateQueries({ queryKey: orpc.portalClients.list.queryOptions().queryKey }),
  }));

  return (
    <div style={{ padding: "1rem", maxWidth: 720, margin: "0 auto", display: "flex", flexDirection: "column", gap: "1rem" }}>
      <Card header={<CardHeader titleText="Portal clients" subtitleText="Invite your customers to configure and request quotes" />}>
        <FlexBox direction="Column" style={{ padding: "1rem", gap: "1rem" }}>
          <Button design="Emphasized" style={{ alignSelf: "start" }}
            onClick={() => { setInvEmail(""); setInvCardCode(""); setAcceptUrl(null); setInviteOpen(true); }}>
            Invite client
          </Button>
          {revoke.error ? <MessageStrip design="Negative" hideCloseButton>{revoke.error.message}</MessageStrip> : null}
          <Table
            noDataText="No portal clients yet — invite one."
            rowActionCount={1}
            onRowActionClick={(e) => {
              const id = ((e.detail.row as unknown) as HTMLElement).dataset.id;
              if (id) revoke.mutate({ id });
            }}
            headerRow={
              <TableHeaderRow>
                <TableHeaderCell><span>Email</span></TableHeaderCell>
                <TableHeaderCell><span>Customer</span></TableHeaderCell>
                <TableHeaderCell><span>Status</span></TableHeaderCell>
              </TableHeaderRow>
            }
          >
            {(clients.data ?? []).map((c) => {
              const expired = !c.acceptedAt && Date.now() - new Date(c.invitedAt).getTime() > 7 * 24 * 3600 * 1000;
              const status = c.acceptedAt ? { state: "Positive" as const, text: "Active" }
                : expired ? { state: "Negative" as const, text: "Expired" }
                : { state: "Critical" as const, text: "Invited" };
              return (
                <TableRow key={c.id} rowKey={c.id} data-id={c.id}
                  actions={<TableRowAction icon="delete" text="Revoke" />}>
                  <TableCell><Text>{c.email}</Text></TableCell>
                  <TableCell><Text>{c.cardName} ({c.cardCode})</Text></TableCell>
                  <TableCell><ObjectStatus state={status.state}>{status.text}</ObjectStatus></TableCell>
                </TableRow>
              );
            })}
          </Table>
        </FlexBox>
      </Card>

      <Dialog open={inviteOpen} headerText="Invite portal client" onClose={() => setInviteOpen(false)}
        footer={
          <Bar design="Footer" endContent={
            acceptUrl ? <Button onClick={() => setInviteOpen(false)}>Done</Button> : (
              <>
                <Button design="Emphasized"
                  disabled={!invEmail.trim() || !invCardCode.trim() || invite.isPending}
                  onClick={() => invite.mutate({ email: invEmail.trim(), cardCode: invCardCode.trim() })}>
                  {invite.isPending ? "Creating…" : "Create invite"}
                </Button>
                <Button onClick={() => setInviteOpen(false)}>Cancel</Button>
              </>
            )
          } />
        }
      >
        {acceptUrl ? (
          <FlexBox direction="Column" style={{ gap: "0.5rem", padding: "0.5rem 0" }}>
            <MessageStrip design="Information" hideCloseButton>
              Copy this link and send it to your client — it is shown only once and expires in 7 days.
            </MessageStrip>
            <Input readonly value={acceptUrl} style={{ width: "100%" }} />
            <Button icon="copy" onClick={() => { void navigator.clipboard.writeText(acceptUrl); setCopied(true); }}>
              Copy link
            </Button>
          </FlexBox>
        ) : (
          <FlexBox direction="Column" style={{ gap: "0.5rem", padding: "0.5rem 0" }}>
            {invite.error ? <MessageStrip design="Negative" hideCloseButton>{invite.error.message}</MessageStrip> : null}
            <Label required>Client email</Label>
            <Input type="Email" value={invEmail} onInput={(e) => setInvEmail(e.target.value)} />
            <Label required>Customer</Label>
            <EntityValueHelp
              entitySet="BusinessPartners"
              keyField="CardCode"
              select={CUSTOMER_SELECT}
              filter={CUSTOMER_FILTER}
              value={invCardCode}
              onChange={(v) => setInvCardCode(v == null ? "" : String(v))}
              headerText="Select a customer"
            />
          </FlexBox>
        )}
      </Dialog>
      <Toast open={copied} onClose={() => setCopied(false)}>Invite link copied</Toast>
    </div>
  );
}
