import { useState } from "react";
import { Input, Switch, DatePicker, Label, Button, FlexBox } from "@ui5/webcomponents-react";
import type { EntityProperty } from "@hera/db";

// Build one control per B1 property, by Edm type. ponytail: enum/association props fall through
// to a plain Input; B1 validates the write and the error surfaces to the user.
function isNumeric(type: string) {
  return /int|double|decimal|single|byte/i.test(type);
}

export function EntityForm({
  properties, keys, initial, busy, submitLabel, onSubmit,
}: {
  properties: EntityProperty[];
  keys: string[];
  initial: Record<string, unknown>;
  busy: boolean;
  submitLabel: string;
  onSubmit: (data: Record<string, unknown>) => void;
}) {
  const [data, setData] = useState<Record<string, unknown>>(initial);
  const set = (name: string, value: unknown) => setData((d) => ({ ...d, [name]: value }));
  const editingExisting = keys.some((k) => initial[k] != null);

  return (
    <FlexBox direction="Column" style={{ gap: "0.75rem", padding: "1rem", maxHeight: "60vh", overflowY: "auto" }}>
      {properties.map((p) => {
        const v = data[p.name];
        // Key fields are immutable when editing an existing record.
        const locked = busy || (editingExisting && keys.includes(p.name));
        return (
          <FlexBox key={p.name} direction="Column" style={{ gap: "0.25rem" }}>
            <Label required={!p.nullable}>{p.name}{keys.includes(p.name) ? " (key)" : ""}</Label>
            {/bool/i.test(p.type) ? (
              <Switch checked={!!v} disabled={locked} onChange={(e) => set(p.name, e.target.checked)} />
            ) : /date/i.test(p.type) ? (
              <DatePicker value={v == null ? "" : String(v)} disabled={locked} onChange={(e) => set(p.name, e.detail.value)} />
            ) : (
              <Input
                type={isNumeric(p.type) ? "Number" : "Text"}
                value={v == null ? "" : String(v)}
                disabled={locked}
                onInput={(e) => set(p.name, isNumeric(p.type) ? Number(e.target.value) : e.target.value)}
              />
            )}
          </FlexBox>
        );
      })}
      <Button design="Emphasized" disabled={busy} onClick={() => onSubmit(data)}>
        {busy ? "Saving…" : submitLabel}
      </Button>
    </FlexBox>
  );
}
