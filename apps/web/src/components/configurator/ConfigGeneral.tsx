import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Form, FormGroup, FormItem, Input, Label, MessageStrip, Option, Select } from "@ui5/webcomponents-react";
import { orpc } from "../../orpc.ts";
import { ValueHelp } from "../ValueHelp.tsx";

export type ConfigCustomer = { cardCode: string; cardName: string };

/** Everything set on the configuration itself is missing — Calculate stays disabled until this is empty. */
export function missingGeneral(p: { name: string; customer: ConfigCustomer | null }): string[] {
  return [...(p.name.trim() ? [] : ["name"]), ...(p.customer ? [] : ["business partner"])];
}

// The configuration's own attributes — name, model, customer — as the first subsection of Configure.
// There is no create dialog and no Save button: a new configuration is an empty draft and each field
// commits on change/blur, exactly like every other field on this page. All three are mandatory; the
// caller gates Calculate on `missingGeneral` over the *persisted* values, so a half-typed name can't
// slip through.
export function ConfigGeneral({ name, modelId, customer, onChange, disabled }: {
  name: string;
  modelId: string;
  customer: ConfigCustomer | null;
  onChange: (patch: { name?: string; modelId?: string; customer?: ConfigCustomer | null }) => void;
  disabled?: boolean;
}) {
  // Local while typing so the field doesn't fight the server value between keystrokes; `null` = show
  // what is persisted. UI5's `change` fires on blur/Enter, which is when we commit.
  const [draftName, setDraftName] = useState<string | null>(null);
  const [bpQuery, setBpQuery] = useState("");
  const models = useQuery(orpc.configs.models.queryOptions());

  // Business partner picker: the same generic entities.list the settings invite dialog uses
  // (BusinessPartners must be enabled). ponytail: one page of 50 and the value-help dialog filters
  // what was fetched — push the search server-side if a tenant's BP list outgrows that.
  const bps = useQuery({
    ...orpc.entities.list.queryOptions({
      input: { entity: "BusinessPartners", q: bpQuery, top: 50, skip: 0, select: ["CardCode", "CardName"] },
    }),
    retry: false,
  });
  const bpOptions = useMemo(
    () => (bps.data?.rows ?? []).map((r) => ({ value: String(r.CardCode), label: String(r.CardName ?? r.CardCode) })),
    [bps.data],
  );

  const shownName = draftName ?? name;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem", width: "100%" }}>
      {bps.error ? <MessageStrip design="Critical" hideCloseButton>{bps.error.message}</MessageStrip> : null}
      {/* Labels on top, same column count as the model's own sections: the Form grid — not per-field
          styling — is what makes every field the same width. Standalone FormItems are deprecated
          since 2.23, hence the group. */}
      <Form labelSpan="S12 M12 L12 XL12" layout="S1 M2 L2 XL2">
        <FormGroup>
          <FormItem labelContent={<Label for="cfg-name" required>Name</Label>}>
            <Input id="cfg-name" value={shownName} style={{ width: "100%" }} disabled={disabled}
              valueState={shownName.trim() ? "None" : "Negative"}
              onInput={(e) => setDraftName(e.target.value ?? "")}
              onChange={(e) => {
                const v = (e.target.value ?? "").trim();
                setDraftName(null); // snap back to the persisted name if the edit is rejected
                if (v && v !== name) onChange({ name: v });
              }} />
          </FormItem>
          <FormItem labelContent={<Label required>Model</Label>}>
            {/* Switching the model throws the entries away (params belong to a model) — the server
                resets entries/batches and the page drops back to draft. */}
            <Select value={modelId} style={{ width: "100%" }} disabled={disabled}
              onChange={(e) => {
                const v = e.detail.selectedOption.value ?? "";
                if (v && v !== modelId) onChange({ modelId: v });
              }}>
              {(models.data ?? []).map((m) => (
                <Option key={m.id} value={m.id}>{m.name}</Option>
              ))}
            </Select>
          </FormItem>
          <FormItem labelContent={<Label for="cfg-bp" required>Business partner</Label>}>
            <ValueHelp id="cfg-bp" headerText="Business partner" options={bpOptions} disabled={disabled}
              value={customer?.cardCode} onSearch={setBpQuery} placeholder="Search by name or code…"
              valueState={customer ? "None" : "Negative"}
              onChange={(v) =>
                onChange({
                  customer: v === undefined || v === null
                    ? null
                    : { cardCode: String(v), cardName: bpOptions.find((o) => o.value === v)?.label ?? String(v) },
                })
              } />
          </FormItem>
        </FormGroup>
      </Form>
    </div>
  );
}
