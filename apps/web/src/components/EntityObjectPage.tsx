import { useEffect, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  ObjectPage, ObjectPageTitle, ObjectPageHeader, ObjectPageSection,
  Breadcrumbs, BreadcrumbsItem, Avatar, Bar, FlexBox,
  Form, FormItem, Label, Title, Text, ObjectStatus,
  Table, TableHeaderRow, TableHeaderCell, TableRow, TableCell,
  Button, VariantManagement, VariantItem,
  Popover, List, ListItemStandard, CheckBox,
  Input, Switch, DatePicker, BusyIndicator, MessageStrip,
} from "@ui5/webcomponents-react";
import type { ButtonDomRef } from "@ui5/webcomponents-react";
import type { EntityProperty, EntitySchema } from "@hera/db";
import { orpc } from "../orpc.ts";
import { useVariants, sameDef, truthy, type ObjectVariantDef } from "../variants.ts";

const cell = (v: unknown) => (v == null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v));
const isNumeric = (t: string) => /int|double|decimal|single|byte/i.test(t);
const isScalar = (v: unknown) => v == null || typeof v !== "object";

// "U_CardName" -> "Card Name". Field names are raw B1/EDM identifiers; this is the only label we have.
const humanize = (n: string) =>
  n.replace(/^U_/, "").replace(/_/g, " ").replace(/([a-z0-9])([A-Z])/g, "$1 $2").trim();

const NAME_RE = /name|descr|title|subject/i;
const IDENT_RE = /docnum/i; // B1 document number — the human-facing id (DocEntry is the opaque key)
const STATUS_RE = /\b(status|state|active|valid|frozen|hold|block|lock)/i;

type FacetState = "None" | "Positive" | "Negative" | "Critical" | "Information";

// ponytail: identOf/nameOf/statusFacets/humanize are heuristics standing in for real field metadata —
// autodiscovery only gives us {name,type,nullable}. Replace them if it ever emits labels/importance.

// Subtitle/avatar name: first name-ish non-key string field with a value (CardName, ItemName, …).
function nameOf(schema: EntitySchema, record: Record<string, unknown>): string | undefined {
  const p = schema.properties.find(
    (p) =>
      /string|char|memo/i.test(p.type) &&
      NAME_RE.test(p.name) &&
      !schema.keys.includes(p.name) &&
      record[p.name] != null &&
      record[p.name] !== "",
  );
  return p ? String(record[p.name]) : undefined;
}

// Title: the document number (DocNum) when present, else the key value, else the URL key.
function identOf(schema: EntitySchema, record: Record<string, unknown>, key: string): string {
  const p = schema.properties.find((p) => IDENT_RE.test(p.name) && record[p.name] != null && record[p.name] !== "");
  if (p) return String(record[p.name]);
  return String(record[schema.keys[0]!] ?? key);
}

// Header summary: boolean-typed or status-named scalar fields rendered as badges, capped at 6.
function statusFacets(schema: EntitySchema, record: Record<string, unknown>) {
  const facets: { label: string; state: FacetState; text: string }[] = [];
  for (const p of schema.properties) {
    if (facets.length >= 6) break;
    const v = record[p.name];
    if (v == null || !isScalar(v)) continue;
    const isBool = /bool/i.test(p.type) || typeof v === "boolean";
    if (!isBool && !STATUS_RE.test(p.name)) continue;
    facets.push({
      label: humanize(p.name),
      state: isBool ? (v ? "Positive" : "None") : "Information",
      text: isBool ? (v ? "Yes" : "No") : cell(v),
    });
  }
  return facets;
}

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

// Fiori object page for any enabled B1 entity: a status-summary header, a General form of scalar
// fields, and one table per nested collection. Read-only by default; an in-place edit flow (footer
// Save/Cancel) appears only when the entity is editable.
export function EntityObjectPage({ entity, recordKey }: { entity: string; recordKey: string }) {
  const navigate = useNavigate();
  const enabled = useQuery(orpc.entities.getEnabled.queryOptions());
  const schema = (enabled.data ?? []).find((e) => e.name === entity);
  const rec = useQuery(orpc.entities.get.queryOptions({ input: { entity, key: recordKey } }));
  const update = useMutation(orpc.entities.update.mutationOptions());

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Record<string, unknown>>({});

  // Object "views" personalize layout only: which sections/fields show and in what order. The
  // single-record GET is unchanged. `layout` is the applied view; it drives rendering + dirty marker.
  const { variants, isAdmin, isLoading: variantsLoading, save: saveVariant, remove: removeVariant } = useVariants("object", entity);
  const [layout, setLayout] = useState<ObjectVariantDef | null>(null);
  const [selectedName, setSelectedName] = useState("");
  const [layoutOpen, setLayoutOpen] = useState(false);
  const layoutBtn = useRef<ButtonDomRef>(null);
  const initedFor = useRef<string>("");
  useEffect(() => {
    if (!schema || variantsLoading || initedFor.current === entity) return;
    initedFor.current = entity;
    const personal = variants.find((v) => v.isDefault && !v.shared);
    const def = personal ?? variants.find((v) => v.isDefault);
    setSelectedName(def?.name ?? "");
    setLayout(def ? (def.definition as ObjectVariantDef) : null);
  }, [schema, variantsLoading, entity, variants]);

  if (enabled.isPending || rec.isPending) return <BusyIndicator active />;
  if (!schema)
    return <MessageStrip design="Negative" hideCloseButton style={{ margin: "1rem" }}>Entity “{entity}” is not enabled.</MessageStrip>;
  if (rec.error || !rec.data)
    return <MessageStrip design="Negative" hideCloseButton style={{ margin: "1rem" }}>{rec.error?.message ?? "Record not found."}</MessageStrip>;
  if (!layout) return <BusyIndicator active />;

  const record = rec.data;
  const keys = schema.keys;
  const name = nameOf(schema, record);          // CardName / ItemName / … -> subtitle + avatar
  const title = identOf(schema, record, recordKey); // DocNum / key value -> title
  const subtitle = name ?? humanize(entity);
  const facets = statusFacets(schema, record);
  const entityLabel = humanize(entity);

  // Nested collections ride on the record, not the scalar schema. Every array-valued field is a B1
  // sub-collection (DocumentLines, Addresses, …) and gets its own section — empty ones included, so
  // the structure is always visible. Non-empty first so data-bearing collections stay near the top.
  const collections = Object.entries(record)
    .filter(([, v]) => Array.isArray(v))
    .map(([name, v]) => ({
      name,
      rows: (v as unknown[]).filter(
        (r): r is Record<string, unknown> => r != null && typeof r === "object" && !Array.isArray(r),
      ),
    }))
    .sort((a, b) => Number(b.rows.length > 0) - Number(a.rows.length > 0));

  // ---- View layout: ordered+visible General fields and which sections show. Missing = visible. ----
  const fieldNames = new Set(layout.fields.map((f) => f.name));
  const orderedProps: EntityProperty[] = layout.fields.length
    ? [
        ...layout.fields.filter((f) => f.visible).map((f) => schema.properties.find((p) => p.name === f.name)).filter((p): p is EntityProperty => !!p),
        ...schema.properties.filter((p) => !fieldNames.has(p.name)),
      ]
    : schema.properties;
  const sectionVisible = (id: string) => layout.sections.find((s) => s.id === id)?.visible ?? true;
  const allSectionIds = ["general", ...collections.map((c) => c.name)];

  const selectedDef = (variants.find((v) => v.name === selectedName)?.definition as ObjectVariantDef | undefined) ?? null;
  const layoutDirty = !sameDef(layout, selectedDef);
  const hasChanges = Object.keys(draft).some((k) => draft[k] !== record[k]);

  const applyVariant = (name: string) => {
    setSelectedName(name);
    setLayout((variants.find((v) => v.name === name)?.definition as ObjectVariantDef | undefined) ?? null);
  };
  const toggleField = (name: string) => {
    const base = layout.fields.length ? layout.fields : schema.properties.map((p) => ({ name: p.name, visible: true }));
    setLayout({ ...layout, fields: base.map((f) => (f.name === name ? { ...f, visible: !f.visible } : f)) });
  };
  const toggleSection = (id: string) => {
    const base = layout.sections.length ? layout.sections : allSectionIds.map((sid) => ({ id: sid, visible: true }));
    const withId = base.some((s) => s.id === id) ? base : [...base, { id, visible: true }];
    setLayout({ ...layout, sections: withId.map((s) => (s.id === id ? { ...s, visible: !s.visible } : s)) });
  };

  const startEdit = () => { setDraft({ ...record }); setEditing(true); };
  const cancel = () => { setDraft({}); setEditing(false); };
  const save = () =>
    update.mutate(
      { entity, key: recordKey, data: draft },
      { onSuccess: () => { setEditing(false); setDraft({}); rec.refetch(); } },
    );

  const variantManagement = (
    <VariantManagement
      dirtyState={layoutDirty}
      hideShare={!isAdmin}
      hideApplyAutomatically
      onSelect={(e) => applyVariant(String(e.detail.selectedVariant.children))}
      onSaveAs={(e) => {
        const d = e.detail;
        const name = String(d.children);
        saveVariant.mutate(
          { page: "object", entity, name, definition: layout, shared: truthy(d.global), isDefault: truthy(d.isDefault) },
          { onSuccess: () => setSelectedName(name) },
        );
      }}
      onSave={() => {
        const row = variants.find((v) => v.name === selectedName);
        if (row) saveVariant.mutate({ id: row.id, page: "object", entity, name: row.name, definition: layout, shared: row.shared, isDefault: row.isDefault });
      }}
      onSaveManageViews={(e) => {
        for (const del of e.detail.deletedVariants) {
          const r = variants.find((v) => v.name === String(del.children));
          if (r) removeVariant.mutate({ id: r.id });
        }
        for (const up of e.detail.updatedVariants) {
          const prevName = up.prevVariant?.children ? String(up.prevVariant.children) : String(up.children);
          const r = variants.find((v) => v.name === prevName);
          if (r && !r.isStandard) saveVariant.mutate({ id: r.id, page: "object", entity, name: String(up.children), definition: r.definition as ObjectVariantDef, shared: truthy(up.global), isDefault: truthy(up.isDefault) });
        }
      }}
    >
      {variants.map((v) => (
        <VariantItem key={v.id} selected={selectedName === v.name} isDefault={v.isDefault} global={v.shared} author={v.author} readOnly={!v.canManage || v.isStandard} hideDelete={!v.canManage || v.isStandard}>
          {v.name}
        </VariantItem>
      ))}
    </VariantManagement>
  );

  const generalSection = (
    <ObjectPageSection id="general" titleText="General" key="general">
      {update.error ? (
        <MessageStrip design="Negative" hideCloseButton style={{ marginBottom: "0.5rem" }}>{update.error.message}</MessageStrip>
      ) : null}
      <Form layout="S1 M1 L2 XL3" labelSpan="S12 M4 L4 XL4">
        {orderedProps.map((p) => {
          const isKey = keys.includes(p.name);
          const v = editing ? draft[p.name] : record[p.name];
          return (
            <FormItem key={p.name} labelContent={<Label>{humanize(p.name)}{isKey ? " (key)" : ""}</Label>}>
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

  const collectionSections = collections.filter(({ name }) => sectionVisible(name)).map(({ name, rows }) => {
    // Columns = union of scalar keys across all rows (so no row's fields are missed; nested arrays
    // like LineTaxJurisdictions are non-scalar and excluded), minus columns blank in every row.
    const cols = [...new Set(rows.flatMap((r) => Object.keys(r).filter((k) => isScalar(r[k]))))]
      .filter((c) => rows.some((r) => r[c] != null && r[c] !== ""));
    return (
      <ObjectPageSection id={name} titleText={`${humanize(name)} (${rows.length})`} key={name}>
        {rows.length === 0 ? (
          <Text>No rows.</Text>
        ) : (
          <Table
            overflowMode="Popin"
            noDataText="No rows"
            headerRow={
              <TableHeaderRow>
                {cols.map((c) => <TableHeaderCell key={c}>{humanize(c)}</TableHeaderCell>)}
              </TableHeaderRow>
            }
          >
            {rows.map((r, i) => (
              // LineNum is the stable line key on every B1 document collection; index covers the rest.
              <TableRow key={r.LineNum != null ? String(r.LineNum) : String(i)}>
                {cols.map((c) => <TableCell key={c}><Text>{cell(r[c])}</Text></TableCell>)}
              </TableRow>
            ))}
          </Table>
        )}
      </ObjectPageSection>
    );
  });

  return (
    <>
    <ObjectPage
      footerArea={
        editing ? (
          <Bar
            design="FloatingFooter"
            endContent={
              <>
                {/* Marker + Save enablement: Save lights up only when the draft differs (no nav block). */}
                <Button design="Emphasized" disabled={update.isPending || !hasChanges} onClick={save}>
                  {update.isPending ? "Saving…" : "Save"}
                </Button>
                <Button design="Transparent" disabled={update.isPending} onClick={cancel}>Cancel</Button>
              </>
            }
          />
        ) : undefined
      }
      titleArea={
        <ObjectPageTitle
          breadcrumbs={
            <Breadcrumbs
              design="Standard"
              onItemClick={(e) => { e.preventDefault(); navigate({ to: "/$entity", params: { entity } }); }}
            >
              <BreadcrumbsItem>{entityLabel}</BreadcrumbsItem>
              <BreadcrumbsItem>{title}</BreadcrumbsItem>
            </Breadcrumbs>
          }
          header={<Title>{title}{editing && hasChanges ? " *" : ""}</Title>}
          subHeader={<Label>{subtitle}</Label>}
          actionsBar={
            <FlexBox alignItems="Center" style={{ gap: "0.5rem" }}>
              {variantManagement}
              <Button ref={layoutBtn} icon="action-settings" design="Transparent" onClick={() => setLayoutOpen((o) => !o)}>Layout</Button>
              {!editing && schema.editable ? <Button design="Emphasized" icon="edit" onClick={startEdit}>Edit</Button> : null}
            </FlexBox>
          }
        />
      }
      headerArea={
        facets.length ? (
          <ObjectPageHeader>
            <FlexBox wrap="Wrap" style={{ gap: "0.5rem 2.5rem" }}>
              {facets.map((f) => (
                <FlexBox key={f.label} direction="Column" style={{ gap: "0.25rem" }}>
                  <Label>{f.label}</Label>
                  <ObjectStatus state={f.state}>{f.text}</ObjectStatus>
                </FlexBox>
              ))}
            </FlexBox>
          </ObjectPageHeader>
        ) : undefined
      }
    >
      {[...(sectionVisible("general") ? [generalSection] : []), ...collectionSections]}
    </ObjectPage>
    <Popover open={layoutOpen} opener={layoutBtn.current ?? undefined} onClose={() => setLayoutOpen(false)} placement="Bottom" headerText="Layout">
      <List headerText="Sections">
        {allSectionIds.map((id) => (
          <ListItemStandard key={id}>
            <CheckBox text={id === "general" ? "General" : humanize(id)} checked={sectionVisible(id)} onChange={() => toggleSection(id)} />
          </ListItemStandard>
        ))}
      </List>
      <List headerText="General fields">
        {schema.properties.map((p) => {
          const f = layout.fields.find((x) => x.name === p.name);
          return (
            <ListItemStandard key={p.name}>
              <CheckBox text={humanize(p.name)} checked={f ? f.visible : true} onChange={() => toggleField(p.name)} />
            </ListItemStandard>
          );
        })}
      </List>
    </Popover>
    </>
  );
}
