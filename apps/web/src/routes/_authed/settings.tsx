import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Card, CardHeader, Input, Button, CheckBox, Switch, Label, MessageStrip, BusyIndicator, FlexBox, Title, Text,
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
    </div>
  );
}
