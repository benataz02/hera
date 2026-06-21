import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  AnalyticalTable, Dialog, Bar, Button, Title, MessageStrip, BusyIndicator, FlexBox,
} from "@ui5/webcomponents-react";
import { orpc } from "../../orpc.ts";
import { EntityForm } from "../../components/EntityForm.tsx";

export const Route = createFileRoute("/_authed/entities/$entity")({ component: EntityPage });

const cell = (v: unknown) => (v == null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v));

function EntityPage() {
  const { entity } = Route.useParams();
  const enabled = useQuery(orpc.entities.getEnabled.queryOptions());
  const schema = (enabled.data ?? []).find((e) => e.name === entity);

  const list = useQuery(orpc.entities.list.queryOptions({ input: { entity, top: 50 } }));
  const [dialog, setDialog] = useState<null | { mode: "create" | "edit"; initial: Record<string, unknown> }>(null);

  const columns = useMemo(
    () => (schema?.properties ?? []).map((p) => ({ id: p.name, Header: p.name, accessor: (row: Record<string, unknown>) => cell(row[p.name]) })),
    [schema],
  );
  const data = useMemo(() => list.data ?? [], [list.data]);

  const editable = !!schema?.editable;
  const singleKey = (schema?.keys.length ?? 0) === 1;

  const create = useMutation(orpc.entities.create.mutationOptions());
  const update = useMutation(orpc.entities.update.mutationOptions());
  const busy = create.isPending || update.isPending;

  const submit = (formData: Record<string, unknown>) => {
    const onSuccess = () => { setDialog(null); list.refetch(); };
    if (dialog?.mode === "create") create.mutate({ entity, data: formData }, { onSuccess });
    else {
      const key = String(dialog!.initial[schema!.keys[0]!]);
      update.mutate({ entity, key, data: formData }, { onSuccess });
    }
  };

  if (enabled.isPending) return <BusyIndicator active />;
  if (!schema) return <MessageStrip design="Negative" hideCloseButton style={{ margin: "1rem" }}>Entity “{entity}” is not enabled.</MessageStrip>;

  return (
    <div style={{ padding: "1rem", display: "flex", flexDirection: "column", gap: "1rem" }}>
      <FlexBox style={{ justifyContent: "space-between", alignItems: "center" }}>
        <Title level="H4">{entity}</Title>
        {editable ? <Button design="Emphasized" onClick={() => setDialog({ mode: "create", initial: {} })}>Create</Button> : null}
      </FlexBox>

      {list.error ? <MessageStrip design="Negative" hideCloseButton>{list.error.message}</MessageStrip> : null}

      <AnalyticalTable
        columns={columns}
        data={data}
        loading={list.isFetching}
        minRows={1}
        visibleRows={15}
        // Edit on row click (single-key entities only). ponytail: composite keys are read-only.
        onRowClick={editable && singleKey ? (e) => setDialog({ mode: "edit", initial: e.detail.row.original }) : undefined}
      />

      {dialog ? (
        <Dialog
          open
          headerText={dialog.mode === "create" ? `New ${entity}` : `Edit ${entity}`}
          onClose={() => setDialog(null)}
          footer={<Bar endContent={<Button design="Transparent" onClick={() => setDialog(null)}>Cancel</Button>} />}
        >
          {create.error || update.error ? (
            <MessageStrip design="Negative" hideCloseButton>{(create.error ?? update.error)!.message}</MessageStrip>
          ) : null}
          <EntityForm
            properties={schema.properties}
            keys={schema.keys}
            initial={dialog.initial}
            busy={busy}
            submitLabel={dialog.mode === "create" ? "Create" : "Save"}
            onSubmit={submit}
          />
        </Dialog>
      ) : null}
    </div>
  );
}
