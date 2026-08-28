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
// Without `onChange` every control renders readonly (focusable, copyable, announced) rather than
// disabled: a generic entity is read-only and these fields exist precisely to be read.

/** Strings past this render as a TextArea. B1's long text fields (Comments, Remarks) are 254+. */
const LONG_TEXT = 120;

export function EntityField({
  field, value, onChange, entityLabel,
}: {
  field: B1Field;
  value: unknown;
  /** absent = read-only */
  onChange?: (v: Val | undefined) => void;
  /** used as the value-help dialog title */
  entityLabel?: string;
}) {
  const ro = !onChange;
  const set = (v: Val | undefined) => onChange?.(v);

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

  if (field.lookup)
    return (
      <EntityValueHelp
        entitySet={field.lookup.entitySet} keyField={field.lookup.keyField}
        value={(value ?? undefined) as Val | undefined} onChange={set} readonly={ro}
        headerText={`${field.label ?? field.name}${entityLabel ? ` — ${entityLabel}` : ""}`}
      />
    );

  // Edm.Boolean and BoYesNoEnum alike: a checkbox, sent back in whichever form the field wants.
  if (field.kind === "boolean")
    return (
      <CheckBox checked={decodeBool(value)} readonly={ro}
        onChange={(e) => set(encodeBool(field, e.target.checked))} />
    );

  if (field.kind === "enum")
    return (
      <Select readonly={ro} style={{ width: "100%" }}
        onChange={(e) => set((e.detail.selectedOption as HTMLElement).dataset.v ?? undefined)}>
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
      <DatePicker readonly={ro} style={{ width: "100%" }} formatPattern="yyyy-MM-dd"
        value={value == null ? "" : String(value).slice(0, 10)}
        onChange={(e) => set(e.target.value || undefined)} />
    );

  if (field.kind === "time")
    return <Input readonly={ro} style={{ width: "100%" }} value={value == null ? "" : String(value)}
      onInput={(e) => set(e.target.value || undefined)} />;

  if (field.kind === "number")
    return (
      <StepInput readonly={ro} style={{ width: "100%" }}
        value={typeof value === "number" ? value : value == null ? undefined : Number(value)}
        onChange={(e) => set(e.target.value ?? undefined)} />
    );

  // Edm.String / Edm.Guid.
  if (ro && field.maxLength && field.maxLength > LONG_TEXT && String(value ?? "").length > 60)
    return <Text>{String(value ?? "")}</Text>;
  if (field.maxLength && field.maxLength > LONG_TEXT)
    return (
      <TextArea readonly={ro} growing growingMaxRows={5} rows={2} style={{ width: "100%" }}
        maxlength={field.maxLength} value={value == null ? "" : String(value)}
        onInput={(e) => set(e.target.value || undefined)} />
    );
  return (
    <Input readonly={ro} style={{ width: "100%" }} maxlength={field.maxLength}
      value={value == null ? "" : String(value)}
      onInput={(e) => set(e.target.value || undefined)} />
  );
}
