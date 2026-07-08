import { useState } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  Bar, BusyIndicator, Button, Card, CardHeader, Dialog, Icon, IllustratedMessage, Input, Label,
  MessageStrip, Title,
} from "@ui5/webcomponents-react";
import "@ui5/webcomponents-icons/dist/product.js";
import "@ui5/webcomponents-fiori/dist/illustrations/NoEntries.js";
import { orpc } from "../../../orpc.ts";

export const Route = createFileRoute("/_authed/portal/new")({ component: Catalog });

function Catalog() {
  const navigate = useNavigate();
  const models = useQuery(orpc.portal.models.list.queryOptions());
  const [picked, setPicked] = useState<{ id: string; name: string } | null>(null);
  const [name, setName] = useState("");
  const create = useMutation(
    orpc.portal.projects.create.mutationOptions({
      onSuccess: (r) => navigate({ to: "/portal/$id", params: { id: r.id } }),
    }),
  );

  if (models.isPending) return <BusyIndicator active delay={0} style={{ width: "100%", marginTop: "4rem" }} />;
  return (
    <div style={{ padding: "1rem", display: "flex", flexDirection: "column", gap: "1rem" }}>
      <Title level="H3">New request</Title>
      {models.error ? <MessageStrip design="Negative" hideCloseButton>{models.error.message}</MessageStrip> : null}
      {models.data?.length === 0 ? (
        <IllustratedMessage name="NoEntries" titleText="No products available"
          subtitleText="Your supplier hasn't published any configurable products yet." />
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(16rem, 1fr))", gap: "1rem" }}>
          {(models.data ?? []).map((m) => (
            // ponytail: icon avatar; model image column when someone uploads one
            <Card key={m.id}
              header={
                <CardHeader interactive titleText={m.name} subtitleText={m.portalDescription ?? ""}
                  avatar={<Icon name="product" />}
                  onClick={() => { setName(""); setPicked({ id: m.id, name: m.name }); }} />
              }
            />
          ))}
        </div>
      )}

      <Dialog open={!!picked} headerText={`New request — ${picked?.name ?? ""}`} onClose={() => setPicked(null)}
        footer={
          <Bar design="Footer" endContent={
            <>
              <Button design="Emphasized" disabled={!name.trim() || create.isPending}
                onClick={() => picked && create.mutate({ modelId: picked.id, name: name.trim() })}>
                {create.isPending ? "Creating…" : "Create"}
              </Button>
              <Button onClick={() => setPicked(null)}>Cancel</Button>
            </>
          } />
        }
      >
        <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem", padding: "0.5rem 0" }}>
          {create.error ? <MessageStrip design="Negative" hideCloseButton>{create.error.message}</MessageStrip> : null}
          <Label for="new-request-name" required>Name your request</Label>
          <Input id="new-request-name" value={name} onInput={(e) => setName(e.target.value)} />
        </div>
      </Dialog>
    </div>
  );
}
