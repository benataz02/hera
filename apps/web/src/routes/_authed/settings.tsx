import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Bar, Card, CardHeader, Dialog, Input, Button, CheckBox, List, ListItemStandard, ObjectStatus, Switch, Label,
  MessageStrip, BusyIndicator, FlexBox, Table, TableCell, TableHeaderCell, TableHeaderRow, TableRow, TableRowAction,
  Title, Text, Toast,
} from "@ui5/webcomponents-react";
import type { EnabledEntity, EntitySchema } from "@hera/db";
import { orpc } from "../../orpc.ts";

export const Route = createFileRoute("/_authed/settings")({ component: Settings });

const RENDER_CAP = 100; // a B1 $metadata has hundreds of sets — only render the filtered head.

function Settings() {
  const qc = useQueryClient();
  const enabled = useQuery(orpc.entities.getEnabled.queryOptions());
  const [catalog, setCatalog] = useState<EntitySchema[]>([]);
  const [selected, setSelected] = useState<Record<string, EnabledEntity>>({});
  const [filter, setFilter] = useState("");

  // Seed the current selection once the stored config loads.
  useEffect(() => {
    if (enabled.data) {
      setSelected(Object.fromEntries(enabled.data.map((e) => [e.name, e])));
    }
  }, [enabled.data]);

  const discover = useMutation(
    orpc.entities.discover.mutationOptions({ onSuccess: (cat) => setCatalog(cat) }),
  );
  const save = useMutation(
    orpc.entities.setEnabled.mutationOptions({
      onSuccess: () => qc.invalidateQueries({ queryKey: orpc.entities.getEnabled.queryOptions().queryKey }),
    }),
  );

  // Show the discovered catalog once it exists; before that, the already-enabled entities.
  const source: EntitySchema[] = catalog.length ? catalog : (enabled.data ?? []);
  const shown = source
    .filter((e) => e.name.toLowerCase().includes(filter.toLowerCase()))
    .slice(0, RENDER_CAP);

  const toggle = (e: EntitySchema, on: boolean) =>
    setSelected((sel) => {
      const next = { ...sel };
      if (on) next[e.name] = { ...e, editable: sel[e.name]?.editable ?? false };
      else delete next[e.name];
      return next;
    });
  const setEditable = (name: string, editable: boolean) =>
    setSelected((sel) => (sel[name] ? { ...sel, [name]: { ...sel[name], editable } } : sel));

  const clients = useQuery(orpc.portalClients.list.queryOptions());
  const [inviteOpen, setInviteOpen] = useState(false);
  const [invEmail, setInvEmail] = useState("");
  const [invCardCode, setInvCardCode] = useState("");
  const [invCardName, setInvCardName] = useState("");
  const [bpQuery, setBpQuery] = useState("");
  const [acceptUrl, setAcceptUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // BP search via the generic entities.list (BusinessPartners must be enabled in the entity panel).
  const bps = useQuery({
    ...orpc.entities.list.queryOptions({
      input: { entity: "BusinessPartners", q: bpQuery, top: 10, skip: 0, select: ["CardCode", "CardName"] },
    }),
    enabled: inviteOpen && bpQuery.length >= 2,
    retry: false,
  });

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
      <Card header={<CardHeader titleText="Entities" subtitleText="Pick which SAP B1 entities appear in the app" />}>
        <FlexBox direction="Column" style={{ padding: "1rem", gap: "1rem" }}>
          {discover.error ? <MessageStrip design="Negative" hideCloseButton>{discover.error.message}</MessageStrip> : null}
          {save.isSuccess ? <MessageStrip design="Positive" hideCloseButton>Saved.</MessageStrip> : null}
          {save.error ? <MessageStrip design="Negative" hideCloseButton>{save.error.message}</MessageStrip> : null}

          <FlexBox style={{ gap: "0.75rem", alignItems: "center" }}>
            <Button design="Emphasized" disabled={discover.isPending} onClick={() => discover.mutate({})}>
              {discover.isPending ? "Discovering…" : "Discover from B1"}
            </Button>
            {discover.isPending ? <BusyIndicator active delay={0} /> : null}
            {catalog.length ? <Text>{catalog.length} entity sets found</Text> : null}
          </FlexBox>

          {source.length ? (
            <>
              <Input placeholder="Filter…" value={filter} onInput={(e) => setFilter(e.target.value)} />
              <Title level="H5">{Object.keys(selected).length} selected</Title>
              <FlexBox direction="Column" style={{ gap: "0.25rem", maxHeight: "50vh", overflowY: "auto" }}>
                {shown.map((e) => {
                  const on = !!selected[e.name];
                  return (
                    <FlexBox key={e.name} style={{ gap: "0.75rem", alignItems: "center", justifyContent: "space-between" }}>
                      <CheckBox text={e.name} checked={on} onChange={(ev) => toggle(e, ev.target.checked)} />
                      {on ? (
                        <FlexBox style={{ gap: "0.5rem", alignItems: "center" }}>
                          <Label>Editable</Label>
                          <Switch checked={!!selected[e.name]?.editable} onChange={(ev) => setEditable(e.name, ev.target.checked)} />
                        </FlexBox>
                      ) : null}
                    </FlexBox>
                  );
                })}
                {source.length > shown.length ? <Text>…refine the filter to see more</Text> : null}
              </FlexBox>
              <Button disabled={save.isPending} onClick={() => save.mutate({ entities: Object.values(selected) })}>
                {save.isPending ? "Saving…" : "Save selection"}
              </Button>
            </>
          ) : (
            <Text>Run discovery to list the entities available in your SAP B1 company.</Text>
          )}
        </FlexBox>
      </Card>

      <Card header={<CardHeader titleText="Portal clients" subtitleText="Invite your customers to configure and request quotes" />}>
        <FlexBox direction="Column" style={{ padding: "1rem", gap: "1rem" }}>
          <Button design="Emphasized" style={{ alignSelf: "start" }}
            onClick={() => { setInvEmail(""); setInvCardCode(""); setInvCardName(""); setBpQuery(""); setAcceptUrl(null); setInviteOpen(true); }}>
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
                  disabled={!invEmail.trim() || !invCardCode.trim() || !invCardName.trim() || invite.isPending}
                  onClick={() => invite.mutate({ email: invEmail.trim(), cardCode: invCardCode.trim(), cardName: invCardName.trim() })}>
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
            <Label>Find customer (SAP business partner)</Label>
            <Input placeholder="Search by name or code…" value={bpQuery} onInput={(e) => setBpQuery(e.target.value)} />
            {bps.error ? <MessageStrip design="Critical" hideCloseButton>
              {bps.error.message} — you can enter the customer manually below.
            </MessageStrip> : null}
            <List onItemClick={(e) => {
              setInvCardCode(e.detail.item.dataset.code ?? "");
              setInvCardName(e.detail.item.dataset.name ?? "");
            }}>
              {(bps.data?.rows ?? []).map((r) => (
                <ListItemStandard key={String(r.CardCode)} data-code={String(r.CardCode)} data-name={String(r.CardName ?? "")}
                  description={String(r.CardCode)}>
                  {String(r.CardName ?? r.CardCode)}
                </ListItemStandard>
              ))}
            </List>
            <FlexBox style={{ gap: "0.5rem" }}>
              <Input placeholder="CardCode" value={invCardCode} onInput={(e) => setInvCardCode(e.target.value)} />
              <Input placeholder="Customer name" value={invCardName} onInput={(e) => setInvCardName(e.target.value)} style={{ flex: 1 }} />
            </FlexBox>
          </FlexBox>
        )}
      </Dialog>
      <Toast open={copied} onClose={() => setCopied(false)}>Invite link copied</Toast>
    </div>
  );
}
