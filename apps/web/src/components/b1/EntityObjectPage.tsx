import { useMemo, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  Bar, Button, BusyIndicator, Form, FormGroup, FormItem, Label, MessageStrip, ObjectPage,
  ObjectPageSection, ObjectPageSubSection, ObjectPageTitle, ObjectStatus, Tag, Title, Toolbar,
  ToolbarButton,
} from "@ui5/webcomponents-react";
import { coerceKey, parseKeyParam, type B1Field } from "@hera/b1";
import type { Val } from "@hera/config-engine";
import { formatCell } from "../../listSpec.ts";
import { orpc } from "../../orpc.ts";
import { toast } from "../toast.ts";
import { EntityField } from "./EntityField.tsx";
import { PrintActions } from "./PrintActions.tsx";

// One B1 row as a Fiori ObjectPage: scalar fields in the header section, each complex collection
// as its own section.
//
// Editing is offered only where the server has a curated profile, and only on the fields that
// profile names — the page reads that from entities.profile rather than deciding for itself, so
// the button and the server rule cannot drift apart. Every save carries the ETag read with the
// row; a concurrent change comes back as a conflict instead of a silent overwrite.
//
// Display/edit is the Form's own switch: `accessibleMode` changes the markup and ARIA it emits,
// and `itemSpacing` goes Large -> Normal so the page does not jump when texts become inputs.
//
// The sections MUST be flat children of ObjectPage. It reads them with React.Children, which
// walks arrays but NOT fragments — a `<>…</>` around the collection sections is one opaque child,
// and the anchor bar then draws a single blank tab instead of one per section.

/** B1's BoStatus. Only the colour is ours; the text is the field's own enum label (bost_Open). */
const STATUS_STATE: Record<string, "Information" | "Positive" | "None"> = {
  O: "Information", C: "None", P: "Positive", D: "Positive",
};

/** The line that identifies the row: the profile's fields, else the first two non-key strings. */
function subtitleOf(fields: B1Field[], keys: string[], row: Record<string, unknown>, names?: string[]) {
  const picked = names?.length
    ? names.map((n) => fields.find((f) => f.name === n)).filter((f): f is B1Field => !!f)
    : fields.filter((f) => f.kind === "string" && !keys.includes(f.name)).slice(0, 2);
  return picked.map((f) => formatCell(row[f.name], f.edmType)).filter(Boolean).join(" · ");
}

export function EntityObjectPage({ entity, entityKey }: { entity: string; entityKey: string }) {
  const navigate = useNavigate();
  const parsed = useMemo(() => parseKeyParam(entityKey), [entityKey]);

  const schema = useQuery({ ...orpc.entities.schema.queryOptions({ input: { entity } }), retry: false, staleTime: 60 * 60_000 });
  const key = useMemo(() => (schema.data ? coerceKey(schema.data, parsed) : parsed), [schema.data, parsed]);
  const meta = useQuery({ ...orpc.entities.profile.queryOptions({ input: { entity } }), staleTime: Infinity });
  const one = useQuery({ ...orpc.entities.one.queryOptions({ input: { entity, key } }), enabled: !!schema.data, retry: false });

  const [draft, setDraft] = useState<Record<string, Val | undefined> | null>(null);

  const update = useMutation(orpc.entities.update.mutationOptions({
    onSuccess: () => { setDraft(null); toast("Saved to SAP"); void one.refetch(); },
  }));
  const copy = useMutation(orpc.entities.copy.mutationOptions({
    onSuccess: (r) => {
      toast(`${r.entity} ${r.docNum ?? r.docEntry} created`);
      navigate({ to: "/b1/$entity/$key", params: { entity: r.entity, key: String(r.docEntry) } });
    },
  }));

  const { scalars, collections, status } = useMemo(() => {
    const fields = schema.data?.fields ?? [];
    return {
      scalars: fields.filter((f) => f.kind !== "collection"),
      collections: fields.filter((f) => f.kind === "collection"),
      status: fields.find((f) => f.name === "DocumentStatus"),
    };
  }, [schema.data]);

  if (schema.isPending || (schema.data && one.isPending)) return <BusyIndicator active delay={0} />;
  const loadError = schema.error ?? one.error;
  if (loadError) return <MessageStrip design="Negative" hideCloseButton>{loadError.message}</MessageStrip>;

  const row = one.data!.row;
  const etag = one.data!.etag;
  const keys = schema.data!.keys;
  const profile = meta.data?.profile ?? null;
  const editable = new Set(profile?.editable ?? []);
  const editing = draft !== null;
  const value = (name: string) => (editing && name in draft! ? draft![name] : row[name]);
  const statusState = status ? STATUS_STATE[String(row.DocumentStatus)] : undefined;

  return (
    <ObjectPage
      mode="IconTabBar"
      titleArea={
        <ObjectPageTitle
          header={<Title>{String(row[profile?.titleField ?? keys[0] ?? ""] ?? keys.map((k) => row[k]).join(" / "))}</Title>}
          subHeader={<span>{subtitleOf(scalars, keys, row, profile?.subtitleFields)}</span>}
          actionsBar={
            <Toolbar design="Transparent">
              {profile && !editing ? (
                <ToolbarButton design="Emphasized" icon="edit" text="Edit"
                  // No ETag means B1 gave us nothing to guard the write with; refuse rather than
                  // send a blind PATCH.
                  disabled={!etag} onClick={() => setDraft({})} />
              ) : null}
              <PrintActions entity={entity} docEntry={Number(row.DocEntry)} disabled={editing} />
              {(meta.data?.flows ?? []).map((f) => (
                <ToolbarButton key={f.target} icon="copy" text={f.label} disabled={copy.isPending || editing}
                  onClick={() => copy.mutate({ sourceEntity: entity, targetEntity: f.target, docEntry: Number(row.DocEntry) })} />
              ))}
              <ToolbarButton icon="nav-back" text="Back to list"
                onClick={() => navigate({ to: "/b1/$entity", params: { entity } })} />
            </Toolbar>
          }>
          {statusState ? (
            <ObjectStatus state={statusState}>
              {(status!.options?.find((o) => o.value === row.DocumentStatus)?.label ?? String(row.DocumentStatus))
                .replace(/^bost_/, "")}
            </ObjectStatus>
          ) : null}
          <Tag design="Set2">{schema.data!.table}</Tag>
        </ObjectPageTitle>
      }
      footerArea={
        editing ? (
          <Bar design="FloatingFooter" endContent={
            <>
              <Button design="Emphasized" disabled={update.isPending || !Object.keys(draft!).length}
                onClick={() => update.mutate({ entity, key, etag: etag!, data: draft! as Record<string, unknown> })}>
                {update.isPending ? "Saving…" : "Save to SAP"}
              </Button>
              <Button onClick={() => { update.reset(); setDraft(null); }}>Cancel</Button>
            </>
          } />
        ) : undefined
      }>
      {[
      <ObjectPageSection key="general" id="general" titleText={schema.data!.label}>
        <ObjectPageSubSection id="fields" titleText="Fields">
          <>
            {update.error ? <MessageStrip design="Negative" hideCloseButton>{update.error.message}</MessageStrip> : null}
            {copy.error ? <MessageStrip design="Negative" hideCloseButton>{copy.error.message}</MessageStrip> : null}
            {!profile && !editing ? (
              <MessageStrip design="Information" hideCloseButton>
                {`${schema.data!.label} is read-only in HERA.`}
              </MessageStrip>
            ) : null}
            <Form layout="S1 M2 L3 XL3" labelSpan="S12 M4 L4 XL4"
              accessibleMode={editing ? "Edit" : "Display"} itemSpacing={editing ? "Normal" : "Large"}>
              <FormGroup>
                {scalars.map((f) => (
                  <FormItem key={f.name} labelContent={<Label>{f.label ?? f.name}</Label>}>
                    <EntityField
                      field={f} value={value(f.name)} entityLabel={schema.data!.label}
                      {...(editing && editable.has(f.name)
                        ? { onChange: (v: Val | undefined) => setDraft((d) => ({ ...d, [f.name]: v })) }
                        : {})}
                    />
                  </FormItem>
                ))}
              </FormGroup>
            </Form>
          </>
        </ObjectPageSubSection>
      </ObjectPageSection>,
      ...collections.map((f) => (
        <ObjectPageSection key={f.name} id={f.name} titleText={f.label ?? f.name}>
          <ObjectPageSubSection id={`${f.name}-rows`} titleText={f.label ?? f.name}>
            <EntityField field={f} value={row[f.name]} />
          </ObjectPageSubSection>
        </ObjectPageSection>
      )),
      ]}
    </ObjectPage>
  );
}
