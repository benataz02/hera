import {
  AnalyticalTable, CheckBox, DatePicker, Input, Option, Select, StepInput, Text, TextArea,
} from "@ui5/webcomponents-react";
import { decodeBool, encodeBool, type B1Field } from "@hera/b1";
import type { Val } from "@hera/config-engine";
import { formatCell } from "../../listSpec.ts";
import { EntityValueHelp } from "./EntityValueHelp.tsx";

// One B1 field, one control.
//
// INVARIANT: the branch order below mirrors ConfiguratorForm.control() — checkbox before select
// before free input — so the two renderers cannot disagree about what a value looks like.
//
// No `onChange` = display mode, and display mode is text — the Fiori form guideline, and what
// `Form accessibleMode="Display"` on the caller announces. A readonly Input reads the same to a
// user but costs a custom element (and, for a lookup, a query hook) per field; a B1 document
// header carries ~120 of them and most are never edited.

/** Strings past this render as a TextArea. B1's long text fields (Comments, Remarks) are 254+. */
const LONG_TEXT = 120;

export function EntityField({
  field, value, onChange, entityLabel,
}: {
  field: B1Field;
  value: unknown;
  /** absent = display mode */
  onChange?: (v: Val | undefined) => void;
  /** used as the value-help dialog title */
  entityLabel?: string;
}) {
  if (field.kind === "collection") {
    const rows = Array.isArray(value) ? (value as Record<string, unknown>[]) : [];
    const cols = (field.fields ?? []).filter((f) => f.kind !== "collection");
    return (
      <AnalyticalTable
        minRows={1}
        data={rows}
        columns={cols.map((f) => ({
          id: f.name,
          Header: f.label ?? f.name,
          accessor: (row: Record<string, unknown>) => formatCell(row[f.name], f.edmType),
        }))}
      />
    );
  }

  if (!onChange) {
    // A tick is already the display form of a boolean; everything else is its formatted string.
    if (field.kind === "boolean") return <CheckBox checked={decodeBool(value)} readonly />;
    if (field.kind === "enum")
      return <Text>{field.options?.find((o) => o.value === value)?.label ?? formatCell(value)}</Text>;
    return <Text>{formatCell(value, field.edmType)}</Text>;
  }

  if (field.lookup)
    return (
      <EntityValueHelp
        entitySet={field.lookup.entitySet} keyField={field.lookup.keyField}
        value={(value ?? undefined) as Val | undefined} onChange={onChange}
        headerText={`${field.label ?? field.name}${entityLabel ? ` — ${entityLabel}` : ""}`}
      />
    );

  // Edm.Boolean and BoYesNoEnum alike: a checkbox, sent back in whichever form the field wants.
  if (field.kind === "boolean")
    return <CheckBox checked={decodeBool(value)} onChange={(e) => onChange(encodeBool(field, e.target.checked))} />;

  if (field.kind === "enum")
    return (
      <Select style={{ width: "100%" }}
        onChange={(e) => onChange((e.detail.selectedOption as HTMLElement).dataset.v ?? undefined)}>
        <Option data-v="" selected={value == null || value === ""}>—</Option>
        {(field.options ?? []).map((o) => (
          <Option key={o.value} data-v={o.value} selected={value === o.value}>{o.label}</Option>
        ))}
      </Select>
    );

  // Date only, both ways: B1's "2026-08-28T00:00:00Z" shows as 2026-08-28 and goes back the same,
  // which is also the literal its $filter and PATCH accept. formatPattern keeps the picker's own
  // value ISO, so no locale string ever reaches SAP.
  if (field.kind === "date")
    return (
      <DatePicker style={{ width: "100%" }} formatPattern="yyyy-MM-dd"
        value={value == null ? "" : String(value).slice(0, 10)}
        onChange={(e) => onChange(e.target.value || undefined)} />
    );

  if (field.kind === "time")
    return <Input style={{ width: "100%" }} value={value == null ? "" : String(value)}
      onInput={(e) => onChange(e.target.value || undefined)} />;

  if (field.kind === "number")
    return (
      <StepInput style={{ width: "100%" }}
        value={typeof value === "number" ? value : value == null ? undefined : Number(value)}
        onChange={(e) => onChange(e.target.value ?? undefined)} />
    );

  // Edm.String / Edm.Guid.
  if (field.maxLength && field.maxLength > LONG_TEXT)
    return (
      <TextArea growing growingMaxRows={5} rows={2} style={{ width: "100%" }}
        maxlength={field.maxLength} value={value == null ? "" : String(value)}
        onInput={(e) => onChange(e.target.value || undefined)} />
    );
  return (
    <Input style={{ width: "100%" }} maxlength={field.maxLength}
      value={value == null ? "" : String(value)}
      onInput={(e) => onChange(e.target.value || undefined)} />
  );
}
