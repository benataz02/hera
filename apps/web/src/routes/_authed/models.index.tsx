import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Card, Button, FlexBox, Title, Text, BusyIndicator, ObjectStatus } from "@ui5/webcomponents-react";
import { orpc } from "../../orpc.ts";

export const Route = createFileRoute("/_authed/models/")({ component: Models });

function Models() {
  const navigate = useNavigate();
  const models = useQuery(orpc.config.list.queryOptions());

  return (
    <div style={{ padding: "1rem", maxWidth: 720, margin: "0 auto", display: "flex", flexDirection: "column", gap: "1rem" }}>
      <FlexBox style={{ justifyContent: "space-between", alignItems: "center" }}>
        <Title level="H4">Configurator models</Title>
        <Button design="Emphasized" onClick={() => navigate({ to: "/models/$id", params: { id: "new" } })}>New model</Button>
      </FlexBox>

      {models.isPending ? <BusyIndicator active /> : null}
      {(models.data ?? []).map((m) => (
        <Card key={m.id}>
          <FlexBox style={{ padding: "1rem", justifyContent: "space-between", alignItems: "center" }}>
            <FlexBox direction="Column">
              <Text>{m.name}</Text>
              <Text style={{ opacity: 0.6, fontSize: "0.8rem" }}>{m.family || "—"}</Text>
            </FlexBox>
            <FlexBox style={{ gap: "0.75rem", alignItems: "center" }}>
              <ObjectStatus state={m.published ? "Positive" : "None"}>{m.published ? "published" : "draft"}</ObjectStatus>
              <Button onClick={() => navigate({ to: "/models/$id", params: { id: m.id } })}>Edit</Button>
            </FlexBox>
          </FlexBox>
        </Card>
      ))}
      {models.data && !models.data.length ? <Text>No models yet. Create one to start configuring products.</Text> : null}
    </div>
  );
}
