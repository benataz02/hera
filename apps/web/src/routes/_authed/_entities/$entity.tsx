import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  AnalyticalTable, Dialog, Bar, Button, Title, MessageStrip, BusyIndicator, FlexBox,
} from "@ui5/webcomponents-react";
import { orpc } from "../../../orpc.ts";
import { EntityForm } from "../../../components/EntityForm.tsx";

export const Route = createFileRoute("/_authed/_entities/$entity")({ component: EntityPage });

const cell = (v: unknown) => (v == null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v));

function EntityPage() {
  const { entity } = Route.useParams();
  const navigate = Route.useNavigate();
  const enabled = useQuery(orpc.entities.getEnabled.queryOptions());
  const schema = (enabled.data ?? []).find((e) => e.name === entity);

  const list = useQuery(orpc.entities.list.queryOptions({ input: { entity, top: 50 } }));
  const [creating, setCreating] = useState(false);

  const columns = useMemo(
    () => (schema?.properties ?? []).map((p) => ({ id: p.name, Header: p.name, accessor: (row: Record<string, unknown>) => cell(row[p.name]) })),
    [schema],
  );
  const data = useMemo(() => list.data ?? [], [list.data]);

  const editable = !!schema?.editable;
  const singleKey = (schema?.keys.length ?? 0) === 1;

  const create = useMutation(orpc.entities.create.mutationOptions());

  const submit = (formData: Record<string, unknown>) =>
    create.mutate({ entity, data: formData }, { onSuccess: () => { setCreating(false); list.refetch(); } });

  if (enabled.isPending) return <BusyIndicator active />;
  if (!schema) return <MessageStrip design="Negative" hideCloseButton style={{ margin: "1rem" }}>Entity “{entity}” is not enabled.</MessageStrip>;

  return (
    <div style={{ padding: "1rem", display: "flex", flexDirection: "column", gap: "1rem" }}>
      <FlexBox style={{ justifyContent: "space-between", alignItems: "center" }}>
        <Title level="H4">{entity}</Title>
        {editable ? <Button design="Emphasized" onClick={() => setCreating(true)}>Create</Button> : null}
      </FlexBox>

      {list.error ? <MessageStrip design="Negative" hideCloseButton>{list.error.message}</MessageStrip> : null}

      <AnalyticalTable
        columns={columns}
        data={data}
        loading={list.isFetching}
        minRows={1}
        visibleRows={15}
        // Row click opens the object page (single-key entities only; entities.get takes one key).
        // ponytail: composite-key entities aren't navigable — same constraint as before.
        onRowClick={singleKey ? (e) => navigate({ to: "/$entity/$id", params: { entity, id: String(e.detail.row.original[schema.keys[0]!]) } }) : undefined}
      />

      {creating ? (
        <Dialog
          open
          headerText={`New ${entity}`}
          onClose={() => setCreating(false)}
          footer={<Bar endContent={<Button design="Transparent" onClick={() => setCreating(false)}>Cancel</Button>} />}
        >
          {create.error ? (
            <MessageStrip design="Negative" hideCloseButton>{create.error.message}</MessageStrip>
          ) : null}
          <EntityForm
            properties={schema.properties}
            keys={schema.keys}
            initial={{}}
            busy={create.isPending}
            submitLabel="Create"
            onSubmit={submit}
          />
        </Dialog>
      ) : null}
    </div>
  );
}
