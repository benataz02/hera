import type { EntityProperty } from "@hera/db";
import {
  CheckBox,
  DatePicker,
  DateTimePicker,
  Input,
  Option,
  Select,
  Text,
  TextArea,
} from "@ui5/webcomponents-react";
import { fieldDisplayText } from "../objectSpec.ts";
import { EntityValueHelp, useLookupLabel, type ValueHelpRow } from "./EntityValueHelp.tsx";

const fillStyle = { width: "100%" } as const;

const oneLineText = (text: string) => (
  <Text
    title={text || undefined}
    style={{
      display: "block",
      overflow: "hidden",
      textOverflow: "ellipsis",
      whiteSpace: "nowrap",
      maxWidth: "100%",
    }}
  >
    {text}
  </Text>
);

function isDateTimeType(t: string): boolean {
  return /DateTimeOffset|DateTime(?!Date)/i.test(t);
}

function isDateOnlyType(t: string): boolean {
  return /Edm\.Date\b|date(?!time)/i.test(t) && !isDateTimeType(t);
}

function isNumericType(t: string): boolean {
  return /int|double|decimal|single|byte|number/i.test(t);
}

function isBoolType(t: string): boolean {
  return /bool/i.test(t);
}

function asDateString(v: unknown): string {
  if (v == null || v === "") return "";
  if (typeof v === "string") return v.length >= 10 ? v.slice(0, 10) : v;
  if (v instanceof Date && !Number.isNaN(v.getTime())) return v.toISOString().slice(0, 10);
  return String(v);
}

function asDateTimeString(v: unknown): string {
  if (v == null || v === "") return "";
  if (typeof v === "string") return v;
  if (v instanceof Date && !Number.isNaN(v.getTime())) return v.toISOString();
  return String(v);
}

export type EntityFieldProps = {
  property: EntityProperty;
  value: unknown;
  mode: "display" | "edit";
  /** Profile / capability read-only — forces text even in edit mode. */
  readOnly?: boolean;
  /** Long free-text fields (Comments, …) use TextArea when editing. */
  multiline?: boolean;
  onChange?: (next: unknown) => void;
  /**
   * Replace a lookup key with its resolved description for display. Off in tables: there the code
   * is the point, a sibling column already carries the description, and one query per cell would
   * mean rows × lookup-columns round-trips.
   */
  resolveLabel?: boolean;
  /** Lookup value-help wiring (parent owns search / rows). */
  valueHelpLabel?: string;
  valueHelpRows?: ValueHelpRow[];
  onValueHelpSearch?: (q: string) => void;
  onValueHelpChange?: (
    next: { key: string; label: string; defaults?: Record<string, unknown> } | undefined,
  ) => void;
  id?: string;
  valueState?: "None" | "Positive" | "Critical" | "Negative" | "Information";
};

/**
 * Metadata-driven display/edit control. Unsupported or profile-read-only fields render text.
 */
export function EntityField({
  property,
  value,
  mode,
  readOnly,
  multiline,
  onChange,
  resolveLabel = true,
  valueHelpLabel,
  valueHelpRows,
  onValueHelpSearch,
  onValueHelpChange,
  id,
  valueState,
}: EntityFieldProps) {
  const editable = mode === "edit" && !readOnly;
  // Hook before any early return: lookup descriptions must resolve in display mode too.
  const lookupLabel = useLookupLabel(
    property.lookup && resolveLabel && value != null ? String(value) : undefined,
    valueHelpLabel,
    valueHelpRows ?? [],
    onValueHelpSearch,
  );

  if (!editable) {
    if (isBoolType(property.type)) {
      return <CheckBox checked={!!value} disabled displayOnly />;
    }
    if (property.lookup && lookupLabel) return oneLineText(lookupLabel);
    return oneLineText(fieldDisplayText(property, value));
  }

  // Lookup → value help
  if (property.lookup) {
    return (
      <EntityValueHelp
        id={id}
        value={value == null ? undefined : String(value)}
        label={lookupLabel ?? (value == null ? "" : String(value))}
        rows={valueHelpRows ?? []}
        onSearch={onValueHelpSearch}
        onChange={(next) => {
          if (onValueHelpChange) onValueHelpChange(next);
          else onChange?.(next?.key);
        }}
        headerText={property.lookup.entitySet}
        valueState={valueState}
      />
    );
  }

  // Enum → Select
  if (property.options?.length) {
    return (
      <Select
        id={id}
        value={value == null ? "" : String(value)}
        style={fillStyle}
        valueState={valueState}
        onChange={(e) => {
          const opt = e.detail.selectedOption as { value?: string; textContent?: string | null };
          const next = opt?.value ?? opt?.textContent ?? "";
          // Blank option on a nullable enum clears the field; "" is not a valid B1 member.
          onChange?.(next === "" ? null : next);
        }}
      >
        {property.nullable ? <Option value=""> </Option> : null}
        {property.options.map((o) => (
          <Option key={o.value} value={o.value}>
            {o.text || o.value}
          </Option>
        ))}
      </Select>
    );
  }

  // Boolean
  if (isBoolType(property.type)) {
    return (
      <CheckBox
        id={id}
        checked={!!value}
        onChange={() => onChange?.(!value)}
      />
    );
  }

  // Date / date-time
  if (isDateTimeType(property.type)) {
    return (
      <DateTimePicker
        id={id}
        value={asDateTimeString(value)}
        style={fillStyle}
        valueState={valueState}
        onChange={(e) => onChange?.(e.detail.value)}
      />
    );
  }
  if (isDateOnlyType(property.type) || /date|time/i.test(property.type)) {
    return (
      <DatePicker
        id={id}
        value={asDateString(value)}
        valueFormat="yyyy-MM-dd"
        style={fillStyle}
        valueState={valueState}
        onChange={(e) => onChange?.(e.detail.value)}
      />
    );
  }

  // Numeric
  if (isNumericType(property.type)) {
    return (
      <Input
        id={id}
        type="Number"
        value={value == null ? "" : String(value)}
        style={fillStyle}
        valueState={valueState}
        onChange={(e) => {
          const raw = e.target.value?.trim() ?? "";
          if (raw === "") onChange?.(null);
          else {
            const n = Number(raw);
            onChange?.(Number.isFinite(n) ? n : raw);
          }
        }}
      />
    );
  }

  // Text / long text
  if (multiline || /memo|binary/i.test(property.type) || property.name === "Comments") {
    return (
      <TextArea
        id={id}
        value={value == null ? "" : String(value)}
        rows={3}
        style={fillStyle}
        valueState={valueState}
        onChange={(e) => onChange?.(e.target.value)}
      />
    );
  }

  if (/string|guid|char|text/i.test(property.type) || !property.type) {
    return (
      <Input
        id={id}
        value={value == null ? "" : String(value)}
        style={fillStyle}
        valueState={valueState}
        onChange={(e) => onChange?.(e.target.value)}
      />
    );
  }

  // Unsupported → display text
  return oneLineText(fieldDisplayText(property, value));
}
