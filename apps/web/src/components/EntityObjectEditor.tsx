import { useMemo, useState, type ReactElement } from "react";
import type {
  EntityCapabilities,
  EntityProfile,
  EntityProperty,
  EntitySchema,
  ObjectVariantDef,
} from "@hera/db";
import {
  Button,
  FlexBox,
  Form,
  FormGroup,
  FormItem,
  Label,
  MessageStrip,
  ObjectPageSection,
  Text,
  type ObjectPageSectionPropTypes,
} from "@ui5/webcomponents-react";
import { recalcDocumentTotals } from "../b1Lines.ts";
import { client } from "../orpc.ts";
import {
  addCollectionRow,
  isCollectionFieldEditable,
  isHeaderFieldEditable,
  missingRequiredFields,
  patchDraftField,
  removeCollectionRow,
  visibleHeaderFields,
  visibleObjectSections,
  writeStatusMessage,
  type ObjectSectionSpec,
  type WriteUiStatus,
} from "../objectSpec.ts";
import { EntityField } from "./EntityField.tsx";
import type { ValueHelpRow } from "./EntityValueHelp.tsx";
import { ObjectLinesTable } from "./ObjectLinesTable.tsx";

/** Everything a section body needs. The shell spreads this straight into `renderObjectSections`. */
export type ObjectSectionsProps = {
  entity: string;
  schema: EntitySchema;
  profile: EntityProfile | null;
  record: Record<string, unknown>;
  draft: Record<string, unknown> | null;
  dirtyPaths: Set<string>;
  variant: ObjectVariantDef;
  capabilities: EntityCapabilities;
  onDraftChange(next: Record<string, unknown>, dirtyPaths: Set<string>): void;
  /** When set, each section renders its own “Fields” button for that section id. */
  onEditSectionFields?(sectionId: string): void;
};

export type EntityObjectEditorProps = ObjectSectionsProps & {
  /** Optional durable-write status for embedded callers (shell also shows strip in footer). */
  writeStatus?: WriteUiStatus;
  writeError?: string | null;
  onVariantChange(id: string): void;
  onSubmit(draft: Record<string, unknown>): void;
  onCancel(): void;
};

function isDocFamily(profile: EntityProfile | null): boolean {
  return profile?.family === "sales-document" || profile?.family === "purchase-document";
}

function dirtyFromRows(
  prev: Record<string, unknown>[],
  next: Record<string, unknown>[],
  prefix: string,
  dirty: Set<string>,
): Set<string> {
  const out = new Set(dirty);
  const len = Math.max(prev.length, next.length);
  for (let i = 0; i < len; i++) {
    const a = prev[i] ?? {};
    const b = next[i];
    if (!b) continue;
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if (k.startsWith("__")) continue;
      if (a[k] !== b[k]) out.add(`${prefix}.${i}.${k}`);
    }
  }
  return out;
}

type FacetProps = {
  schema: EntitySchema;
  profile: EntityProfile | null;
  variant: ObjectVariantDef;
  working: Record<string, unknown>;
  draft: Record<string, unknown> | null;
  dirtyPaths: Set<string>;
  capabilities: EntityCapabilities;
  mode: "display" | "edit";
  entity: string;
  onDraftChange(next: Record<string, unknown>, dirtyPaths: Set<string>): void;
};

/** Header facets for ObjectPageHeader (shell). Same EntityField wiring as the General form. */
export function EntityObjectFacets({
  schema,
  profile,
  variant,
  working,
  draft,
  dirtyPaths,
  capabilities,
  mode,
  entity,
  onDraftChange,
}: FacetProps) {
  const headerFields = useMemo(() => visibleHeaderFields(schema, variant), [schema, variant]);
  const propBy = useMemo(() => new Map(schema.properties.map((p) => [p.name, p])), [schema]);
  const [vhRows, setVhRows] = useState<Record<string, ValueHelpRow[]>>({});
  const [vhLabels, setVhLabels] = useState<Record<string, string>>({});

  if (!headerFields.length) return null;

  return (
    <FlexBox wrap="Wrap" gap="1.5rem" style={{ padding: "0.25rem 0" }}>
      {headerFields.map((f) => {
        const prop = propBy.get(f.name);
        if (!prop) return null;
        const readOnly = !isHeaderFieldEditable(profile, f.name, capabilities);
        const required =
          mode === "edit" &&
          !!draft &&
          !!profile?.fields.requiredOnCreate.includes(f.name) &&
          missingRequiredFields(profile, draft).includes(f.name);
        return (
          <div key={f.name} style={{ minWidth: "8rem" }}>
            <Label>{f.label}</Label>
            <div>
              <EntityField
                property={prop}
                value={working[f.name]}
                mode={mode}
                readOnly={readOnly}
                valueState={required ? "Negative" : undefined}
                valueHelpLabel={vhLabels[f.name]}
                valueHelpRows={vhRows[f.name] ?? []}
                onValueHelpSearch={
                  prop.lookup
                    ? (q) => {
                        void client.entities
                          .valueHelp({ entity, field: f.name, search: q })
                          .then((res) => setVhRows((s) => ({ ...s, [f.name]: res.rows })));
                      }
                    : undefined
                }
                onValueHelpChange={
                  prop.lookup
                    ? (next) => {
                        if (!draft) return;
                        if (next?.label) setVhLabels((s) => ({ ...s, [f.name]: next.label }));
                        const patched = patchDraftField(draft, dirtyPaths, f.name, next?.key);
                        onDraftChange(patched.draft, patched.dirtyPaths);
                      }
                    : undefined
                }
                onChange={(next) => {
                  if (!draft) return;
                  const patched = patchDraftField(draft, dirtyPaths, f.name, next);
                  onDraftChange(patched.draft, patched.dirtyPaths);
                }}
              />
            </div>
          </div>
        );
      })}
    </FlexBox>
  );
}

/** Body of one section: the General form or one collection's lines table. */
function ObjectSectionBody({
  sec,
  entity,
  schema,
  profile,
  record,
  draft,
  dirtyPaths,
  variant,
  capabilities,
  onDraftChange,
  onEditSectionFields,
}: ObjectSectionsProps & { sec: ObjectSectionSpec }) {
  const mode = draft ? "edit" : "display";
  const working = draft ?? record;
  const propBy = useMemo(() => new Map(schema.properties.map((p) => [p.name, p])), [schema]);
  const colBy = useMemo(() => new Map(schema.collections.map((c) => [c.name, c])), [schema]);
  const [vhRows, setVhRows] = useState<Record<string, ValueHelpRow[]>>({});
  const [vhLabels, setVhLabels] = useState<Record<string, string>>({});

  const fetchValueHelp = async (field: string, search: string) => {
    const res = await client.entities.valueHelp({ entity, field, search });
    return res.rows;
  };

  const fieldsButton = onEditSectionFields ? (
    <div style={{ display: "flex", justifyContent: "flex-end" }}>
      <Button
        design="Transparent"
        icon="action-settings"
        onClick={() => onEditSectionFields(sec.id)}
      >
        Fields
      </Button>
    </div>
  ) : null;

  if (sec.kind === "general") {
    const renderScalar = (prop: EntityProperty, name: string) => {
      const readOnly = !isHeaderFieldEditable(profile, name, capabilities);
      const required =
        mode === "edit" &&
        !!draft &&
        !!profile?.fields.requiredOnCreate.includes(name) &&
        missingRequiredFields(profile, draft).includes(name);
      return (
        <EntityField
          property={prop}
          value={working[name]}
          mode={mode}
          readOnly={readOnly}
          multiline={name === "Comments"}
          valueState={required ? "Negative" : undefined}
          valueHelpLabel={vhLabels[name]}
          valueHelpRows={vhRows[name] ?? []}
          onValueHelpSearch={
            prop.lookup
              ? (q) => {
                  void fetchValueHelp(name, q).then((rows) =>
                    setVhRows((s) => ({ ...s, [name]: rows })),
                  );
                }
              : undefined
          }
          onValueHelpChange={
            prop.lookup
              ? (next) => {
                  if (!draft) return;
                  if (next?.label) setVhLabels((s) => ({ ...s, [name]: next.label }));
                  const patched = patchDraftField(draft, dirtyPaths, name, next?.key);
                  onDraftChange(patched.draft, patched.dirtyPaths);
                }
              : undefined
          }
          onChange={(next) => {
            if (!draft) return;
            const patched = patchDraftField(draft, dirtyPaths, name, next);
            onDraftChange(patched.draft, patched.dirtyPaths);
          }}
        />
      );
    };

    return (
      <>
        {fieldsButton}
        <Form
          accessibleMode={mode === "edit" ? "Edit" : "Display"}
          labelSpan="S12 M4 L4 XL4"
          layout="S1 M2 L3 XL3"
          itemSpacing="Large"
        >
          <FormGroup>
            {sec.fields.map((f) => {
              const prop = propBy.get(f.name);
              if (!prop) return null;
              return (
                <FormItem key={f.name} labelContent={<Label>{f.label}</Label>}>
                  {renderScalar(prop, f.name)}
                </FormItem>
              );
            })}
          </FormGroup>
        </Form>
      </>
    );
  }

  const col = colBy.get(sec.id);
  if (!col) {
    return (
      <>
        {fieldsButton}
        <Text>Unknown collection.</Text>
      </>
    );
  }

  const documentContext = {
    cardCode: working.CardCode == null ? undefined : String(working.CardCode),
    docDate: working.DocDate == null ? undefined : String(working.DocDate),
    currency:
      working.DocCurrency == null
        ? working.Currency == null
          ? undefined
          : String(working.Currency)
        : String(working.DocCurrency),
    priceList: working.PriceList == null ? undefined : Number(working.PriceList),
  };

  const fetchItemContext = async (
    req: {
      itemCode: string;
      cardCode?: string;
      inventoryQuantity?: number;
      uomEntry?: number;
      uomQuantity?: number;
      date?: string;
      currency?: string;
      priceList?: number;
    },
    _signal: AbortSignal,
  ) =>
    client.entities.itemContext({
      entity,
      itemCode: req.itemCode,
      cardCode: req.cardCode,
      inventoryQuantity: req.inventoryQuantity,
      uomEntry: req.uomEntry,
      uomQuantity: req.uomQuantity,
      date: req.date,
      currency: req.currency,
      priceList: req.priceList,
    });

  const rows = Array.isArray(working[sec.id]) ? (working[sec.id] as Record<string, unknown>[]) : [];
  const fieldDefs = (variant.sections.find((s) => s.id === sec.id)?.fields ?? []).filter(
    (f) => f.visible,
  );
  const editableFields = (profile?.fields.collectionEditable[sec.id] ?? []).filter((name) =>
    isCollectionFieldEditable(profile, sec.id, name, capabilities),
  );
  const collectionEditable = !!profile?.collections[sec.id]?.editable && capabilities.canEdit;
  // ponytail: only DocumentLines carries B1 pricing/total arithmetic; other collections
  // (DocumentReferences, DocumentAdditionalExpenses, …) are plain grids until one needs more.
  const priced = isDocFamily(profile) && sec.id === "DocumentLines";

  return (
    <>
      {fieldsButton}
      <ObjectLinesTable
        fields={fieldDefs}
        properties={col.properties}
        rows={rows}
        mode={mode}
        editableFields={editableFields}
        dirtyPaths={dirtyPaths}
        pathPrefix={sec.id}
        family={profile?.family === "purchase-document" ? "purchase-document" : "sales-document"}
        documentContext={documentContext}
        fetchItemContext={priced ? fetchItemContext : undefined}
        fetchValueHelp={async (field, search) => {
          try {
            return await fetchValueHelp(field, search);
          } catch {
            return [];
          }
        }}
        onRowsChange={
          draft
            ? (nextRows) => {
                const dirties = dirtyFromRows(rows, nextRows, sec.id, dirtyPaths);
                let next: Record<string, unknown> = { ...draft, [sec.id]: nextRows };
                if (priced) next = recalcDocumentTotals(next);
                onDraftChange(next, dirties);
              }
            : undefined
        }
        onAddRow={
          draft && collectionEditable
            ? () => {
                const added = addCollectionRow(draft, dirtyPaths, sec.id, {});
                onDraftChange(priced ? recalcDocumentTotals(added.draft) : added.draft, added.dirtyPaths);
              }
            : undefined
        }
        onRemoveRow={
          draft && collectionEditable
            ? (index) => {
                const removed = removeCollectionRow(draft, dirtyPaths, sec.id, index);
                onDraftChange(
                  priced ? recalcDocumentTotals(removed.draft) : removed.draft,
                  removed.dirtyPaths,
                );
              }
            : undefined
        }
      />
    </>
  );
}

/**
 * The variant's sections as an ARRAY of `ObjectPageSection` elements.
 *
 * ObjectPage detects sections with `Children.forEach`, which does not descend into a custom
 * component or a Fragment — sections must be direct children. Returning an array (React flattens
 * arrays, not components) is what lets the shell keep the section bodies in this file.
 */
export function renderObjectSections(
  props: ObjectSectionsProps,
): ReactElement<ObjectPageSectionPropTypes>[] {
  return visibleObjectSections(props.schema, props.variant).map((sec) => (
    <ObjectPageSection key={sec.id} id={sec.id} titleText={sec.title}>
      <ObjectSectionBody {...props} sec={sec} />
    </ObjectPageSection>
  ));
}

/**
 * Standalone object body (configurator create step) — General form + collection tables.
 * Does not navigate and does not render ObjectPage.
 * Inside an ObjectPage use `renderObjectSections` directly so the sections stay direct children.
 * Header facets: use `EntityObjectFacets` in the shell's ObjectPageHeader.
 */
export function EntityObjectEditor({
  writeStatus = null,
  writeError = null,
  onVariantChange: _onVariantChange,
  onSubmit: _onSubmit,
  onCancel: _onCancel,
  ...sectionProps
}: EntityObjectEditorProps) {
  const statusStrip = writeStatusMessage(writeStatus, writeError);
  return (
    <>
      {statusStrip ? (
        <MessageStrip design={statusStrip.design} hideCloseButton style={{ margin: "0.5rem 0" }}>
          {statusStrip.text}
        </MessageStrip>
      ) : null}
      {renderObjectSections(sectionProps)}
    </>
  );
}
