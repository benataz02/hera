import { useState } from "react";
import { Form, FormGroup, FormItem, Input, Label, MessageStrip, Switch, TextArea } from "@ui5/webcomponents-react";
import type { Issue, ModelDef } from "@hera/config-engine";
import { ExprInput } from "./ExprInput.tsx";
import { issueFor } from "./useDraftModel.ts";

export function SettingsTab({ draft, update, issues, portalMeta, setPortalMeta }: {
  draft: ModelDef;
  update: (fn: (d: ModelDef) => ModelDef) => void;
  issues: Issue[];
  portalMeta: { portal: boolean; portalDescription: string };
  setPortalMeta: (p: { portal: boolean; portalDescription: string }) => void;
}) {
  // Batches edited as CSV; parse on change, ignore junk. // ponytail: token editor if CSV annoys
  const [batchText, setBatchText] = useState(draft.batchDefaults.join(", "));
  const setBatches = (text: string) => {
    setBatchText(text);
    const nums = text.split(",").map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n > 0);
    update((d) => ({ ...d, batchDefaults: nums }));
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "1rem", padding: "1rem" }}>
      <Form labelSpan="S12 M4" layout="S1 M1 L2 XL2">
        <FormGroup headerText="Model">
          <FormItem labelContent={<Label required>Name</Label>}>
            <Input value={draft.name} onInput={(e) => update((d) => ({ ...d, name: e.target.value }))} />
          </FormItem>
          <FormItem labelContent={<Label>Default batch sizes</Label>}>
            <Input value={batchText} placeholder="1, 10, 100" onInput={(e) => setBatches(e.target.value)}
              valueState={draft.batchDefaults.length ? "None" : "Negative"}
              valueStateMessage={<div>At least one positive integer batch size</div>} />
          </FormItem>
          <FormItem labelContent={<Label>Extraction context</Label>}>
            <TextArea value={draft.extraction?.context ?? ""} rows={3}
              placeholder="Drawing conventions the AI should know (units, title-block layout, notation)…"
              onInput={(e) =>
                update((d) => ({ ...d, extraction: e.target.value ? { context: e.target.value } : undefined }))} />
          </FormItem>
        </FormGroup>
        <FormGroup headerText="Pricing">
          <FormItem labelContent={<Label required>Unit price expression</Label>}>
            <ExprInput value={draft.pricing.priceExpr} model={draft} extraVars={["qty", "unitCost"]}
              fieldId="expr-pricing.priceExpr" issue={issueFor(issues, "pricing.priceExpr")}
              onChange={(v) => update((d) => ({ ...d, pricing: { ...d.pricing, priceExpr: v ?? "" } }))} />
          </FormItem>
          <FormItem labelContent={<Label required>Quote item code</Label>}>
            <Input value={draft.pricing.quoteItemCode}
              valueState={draft.pricing.quoteItemCode ? "None" : "Negative"}
              onInput={(e) => update((d) => ({ ...d, pricing: { ...d.pricing, quoteItemCode: e.target.value } }))} />
          </FormItem>
        </FormGroup>
        <FormGroup headerText="Client portal">
          <FormItem labelContent={<Label>Available in portal</Label>}>
            <Switch checked={portalMeta.portal}
              onChange={(e) => setPortalMeta({ ...portalMeta, portal: e.target.checked })} />
          </FormItem>
          <FormItem labelContent={<Label>Portal description</Label>}>
            <Input value={portalMeta.portalDescription} placeholder="Shown on the client's catalog card"
              onInput={(e) => setPortalMeta({ ...portalMeta, portalDescription: e.target.value })} />
          </FormItem>
        </FormGroup>
      </Form>

      <MessageStrip design="Information" hideCloseButton>
        Query tables (B1/Beas datasets for LOOKUP() and table domains) are managed on the Tables tab, alongside lookup tables.
      </MessageStrip>
    </div>
  );
}
