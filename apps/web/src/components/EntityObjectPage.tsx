import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  ObjectPage, ObjectPageTitle, ObjectPageHeader, ObjectPageSection,
  Form, FormItem, Label, Text, ObjectStatus,
  Table, TableHeaderRow, TableHeaderCell, TableRow, TableCell,
  Toolbar, ToolbarButton, ToolbarSpacer,
  Input, Switch, DatePicker, BusyIndicator, MessageStrip,
} from "@ui5/webcomponents-react";
import type { EntityProperty } from "@hera/db";
import { orpc } from "../orpc.ts";

const cell = (v: unknown) => (v == null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v));
const isNumeric = (t: string) => /int|double|decimal|single|byte/i.test(t);
const isScalar = (v: unknown) => v == null || typeof v !== "object";

// ponytail: mirrors EntityForm.tsx's Edm->control switch (~10 lines). Extract a shared
// `entityField` helper if a third form ever needs it (rule of three).
function EditField({ p, value, locked, onChange }: {
  p: EntityProperty; value: unknown; locked: boolean; onChange: (v: unknown) => void;
}) {
  if (/bool/i.test(p.type))
    return <Switch checked={!!value} disabled={locked} onChange={(e) => onChange(e.target.checked)} />;
  if (/date/i.test(p.type))
    return <DatePicker value={value == null ? "" : String(value)} disabled={locked} onChange={(e) => onChange(e.detail.value)} />;
  return (
    <Input
      type={isNumeric(p.type) ? "Number" : "Text"}
      value={value == null ? "" : String(value)}
      disabled={locked}
      onInput={(e) => onChange(isNumeric(p.type) ? Number(e.target.value) : e.target.value)}
    />
  );
}

// Abstract object page for any enabled B1 entity: a Form of scalar fields + one Table per nested
// collection. Read-only by default; Edit appears only when the entity is editable.
export function EntityObjectPage({ entity, recordKey }: { entity: string; recordKey: string }) {
  const navigate = useNavigate();
  const enabled = useQuery(orpc.entities.getEnabled.queryOptions());
  const schema = (enabled.data ?? []).find((e) => e.name === entity);
  const rec = useQuery(orpc.entities.get.queryOptions({ input: { entity, key: recordKey } }));
  const update = useMutation(orpc.entities.update.mutationOptions());

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Record<string, unknown>>({});

  if (enabled.isPending || rec.isPending) return <BusyIndicator active />;
  if (!schema)
    return <MessageStrip design="Negative" hideCloseButton style={{ margin: "1rem" }}>Entity “{entity}” is not enabled.</MessageStrip>;
  if (rec.error || !rec.data)
    return <MessageStrip design="Negative" hideCloseButton style={{ margin: "1rem" }}>{rec.error?.message ?? "Record not found."}</MessageStrip>;

  const record = rec.data;
  const keys = schema.keys;
  const title = String(record[keys[0]!] ?? recordKey);

  // Nested collections ride on the record, not the scalar schema — detect arrays-of-objects.
  const arraySections = Object.entries(record).filter(
    ([, v]) => Array.isArray(v) && v.length > 0 && v[0] != null && typeof v[0] === "object",
  ) as [string, Record<string, unknown>[]][];

  const save = () =>
    update.mutate(
      { entity, key: recordKey, data: draft },
      { onSuccess: () => { setEditing(false); rec.refetch(); } },
    );

  const actions = (
    <Toolbar design="Transparent">
      <ToolbarButton icon="nav-back" text="Back" onClick={() => navigate({ to: "/$entity", params: { entity } })} />
      <ToolbarSpacer />
      {editing ? (
        <>
          <ToolbarButton design="Emphasized" text={update.isPending ? "Saving…" : "Save"} disabled={update.isPending} onClick={save} />
          <ToolbarButton design="Transparent" text="Cancel" disabled={update.isPending} onClick={() => setEditing(false)} />
        </>
      ) : schema.editable ? (
        <ToolbarButton design="Emphasized" icon="edit" text="Edit" onClick={() => { setDraft({ ...record }); setEditing(true); }} />
      ) : null}
    </Toolbar>
  );

  const generalSection = (
    <ObjectPageSection id="general" titleText="General" key="general">
      {update.error ? (
        <MessageStrip design="Negative" hideCloseButton style={{ marginBottom: "0.5rem" }}>{update.error.message}</MessageStrip>
      ) : null}
      <Form layout="S1 M1 L2 XL3" labelSpan="S12 M4 L4 XL4">
        {schema.properties.map((p) => {
          const isKey = keys.includes(p.name);
          const v = editing ? draft[p.name] : record[p.name];
          return (
            <FormItem key={p.name} labelContent={<Label>{p.name}{isKey ? " (key)" : ""}</Label>}>
              {editing ? (
                <EditField
                  p={p}
                  value={v}
                  locked={update.isPending || isKey}
                  onChange={(nv) => setDraft((d) => ({ ...d, [p.name]: nv }))}
                />
              ) : /bool/i.test(p.type) ? (
                <ObjectStatus state={v ? "Positive" : "None"}>{v ? "Yes" : "No"}</ObjectStatus>
              ) : (
                <Text>{cell(v)}</Text>
              )}
            </FormItem>
          );
        })}
      </Form>
    </ObjectPageSection>
  );

  const collectionSections = arraySections.map(([name, rows]) => {
    const cols = Object.keys(rows[0]!).filter((c) => isScalar(rows[0]![c]));
    return (
      <ObjectPageSection id={name} titleText={`${name} (${rows.length})`} key={name}>
        <Table
          overflowMode="Popin"
          noDataText="No rows"
          headerRow={
            <TableHeaderRow>
              {cols.map((c) => <TableHeaderCell key={c}>{c}</TableHeaderCell>)}
            </TableHeaderRow>
          }
        >
          {rows.map((r, i) => (
            <TableRow key={i}>
              {cols.map((c) => <TableCell key={c}><Text>{cell(r[c])}</Text></TableCell>)}
            </TableRow>
          ))}
        </Table>
      </ObjectPageSection>
    );
  });

  return (
    <ObjectPage
      titleArea={<ObjectPageTitle header={title} subHeader={entity} actionsBar={actions} />}
      headerArea={
        <ObjectPageHeader>
          <ObjectStatus state={schema.editable ? "Information" : "None"}>
            {schema.editable ? "Editable" : "Read-only"}
          </ObjectStatus>
        </ObjectPageHeader>
      }
    >
      {[generalSection, ...collectionSections]}
    </ObjectPage>
  );
}
