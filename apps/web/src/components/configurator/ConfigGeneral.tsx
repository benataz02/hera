import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Form, FormGroup, FormItem, Input, Label, Option, Select } from "@ui5/webcomponents-react";
import { orpc } from "../../orpc.ts";

export type ConfigCustomer = { cardCode: string; cardName: string };

/** Everything set on the configuration itself is missing — Calculate stays disabled until this is empty. */
export function missingGeneral(p: { name: string; customer: ConfigCustomer | null }): string[] {
  return [...(p.name.trim() ? [] : ["name"]), ...(p.customer ? [] : ["business partner"])];
}

// The configuration's own attributes — name, model, customer — as the first subsection of Configure.
export function ConfigGeneral({ name, modelId, customer, onChange, disabled }: {
  name: string;
  modelId: string;
  customer: ConfigCustomer | null;
  onChange: (patch: { name?: string; modelId?: string; customer?: ConfigCustomer | null }) => void;
  disabled?: boolean;
}) {
  const [draftName, setDraftName] = useState<string | null>(null);
  const [draftCode, setDraftCode] = useState<string | null>(null);
  const [draftCardName, setDraftCardName] = useState<string | null>(null);
  const models = useQuery(orpc.configs.models.queryOptions());
  const shownName = draftName ?? name;
  const shownCode = draftCode ?? customer?.cardCode ?? "";
  const shownCardName = draftCardName ?? customer?.cardName ?? "";

  const commitCustomer = (cardCode: string, cardName: string) => {
    const code = cardCode.trim();
    const label = cardName.trim();
    if (!code && !label) {
      if (customer) onChange({ customer: null });
      return;
    }
    if (!code || !label) return;
    if (customer?.cardCode === code && customer.cardName === label) return;
    onChange({ customer: { cardCode: code, cardName: label } });
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem", width: "100%" }}>
      <Form labelSpan="S12 M12 L12 XL12" layout="S1 M2 L2 XL2">
        <FormGroup>
          <FormItem labelContent={<Label for="cfg-name" required>Name</Label>}>
            <Input id="cfg-name" value={shownName} style={{ width: "100%" }} disabled={disabled}
              valueState={shownName.trim() ? "None" : "Negative"}
              onInput={(e) => setDraftName(e.target.value ?? "")}
              onChange={(e) => {
                const v = (e.target.value ?? "").trim();
                setDraftName(null);
                if (v && v !== name) onChange({ name: v });
              }} />
          </FormItem>
          <FormItem labelContent={<Label required>Model</Label>}>
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
          <FormItem labelContent={<Label for="cfg-bp-code" required>Customer code</Label>}>
            <Input id="cfg-bp-code" value={shownCode} style={{ width: "100%" }} disabled={disabled}
              valueState={shownCode.trim() ? "None" : "Negative"}
              placeholder="CardCode"
              onInput={(e) => setDraftCode(e.target.value ?? "")}
              onChange={(e) => {
                const v = e.target.value ?? "";
                setDraftCode(null);
                commitCustomer(v, shownCardName);
              }} />
          </FormItem>
          <FormItem labelContent={<Label for="cfg-bp-name" required>Customer name</Label>}>
            <Input id="cfg-bp-name" value={shownCardName} style={{ width: "100%" }} disabled={disabled}
              valueState={shownCardName.trim() ? "None" : "Negative"}
              placeholder="Customer name"
              onInput={(e) => setDraftCardName(e.target.value ?? "")}
              onChange={(e) => {
                const v = e.target.value ?? "";
                setDraftCardName(null);
                commitCustomer(shownCode, v);
              }} />
          </FormItem>
        </FormGroup>
      </Form>
    </div>
  );
}
