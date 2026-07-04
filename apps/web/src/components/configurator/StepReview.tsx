import {
  Bar, Button, Input, MessageStrip, ObjectStatus, Panel, StepInput, Table, TableCell,
  TableHeaderCell, TableHeaderRow, TableRow, TableRowAction, Text, Title,
} from "@ui5/webcomponents-react";
import { computeOutputs, type Entries, type ModelDef, type OutputOverrides, type Outputs, type ResolvedLookups } from "@hera/config-engine";
import {
  addBomLine, addOpLine, candidateLabel, fmt, isEdited, isRemoved, openKeys, patchAddedBom,
  patchAddedOp, patchBom, patchOp, removeAddedBom, removeAddedOp, resetLine, withoutRemovals,
  type Candidate, type Sel,
} from "./runView.ts";

// Wizard step 4: per selected cell, the outputs become editable. Two computeOutputs passes:
// the display pass ignores remove flags (so removed rows stay visible, struck through) and
// the totals pass applies everything — the numbers shown are exactly what the server will
// recompute and store on Save selection.
export function StepReview({ model, lookups, runEntries, candidates, selection, onChange, onSave, saving, error, saved }: {
  model: ModelDef;
  lookups: ResolvedLookups;
  runEntries: Entries;
  candidates: Candidate[];
  selection: Sel[];
  onChange: (next: Sel[]) => void;
  onSave: () => void;
  saving: boolean;
  error: string | null;
  saved: boolean;
}) {
  const keys = openKeys(model, runEntries, candidates);
  const setOv = (i: number, ov: OutputOverrides) =>
    onChange(selection.map((s, j) => (j === i ? { ...s, overrides: ov } : s)));

  let grand = 0;
  const panels = selection.map((s, i) => {
    const cand = candidates[s.candidateIdx];
    if (!cand) return null;
    const ov = s.overrides ?? {};
    const addedBom = new Set((ov.addBom ?? []).map((a) => a.id));
    const addedOps = new Set((ov.addOps ?? []).map((a) => a.id));

    let display: Outputs, totals: Outputs;
    try {
      display = computeOutputs(model, lookups, cand.assignment, s.batchQty, withoutRemovals(ov));
      totals = computeOutputs(model, lookups, cand.assignment, s.batchQty, ov);
    } catch (e) {
      return (
        <MessageStrip key={i} design="Negative" hideCloseButton>
          {candidateLabel(keys, cand.assignment)} — {e instanceof Error ? e.message : String(e)}
        </MessageStrip>
      );
    }
    grand += totals.batchTotal;

    const rowStatus = (kind: "bom" | "ops", id: string, added: boolean) =>
      added ? <ObjectStatus state="Information">added</ObjectStatus>
        : isRemoved(ov, kind, id) ? <ObjectStatus state="Negative">removed</ObjectStatus>
        : isEdited(ov, kind, id) ? <ObjectStatus state="Information">edited</ObjectStatus>
        : null;
    const rowActions = (kind: "bom" | "ops", id: string, added: boolean) =>
      added ? <TableRowAction icon="delete" text="Remove" />
        : isRemoved(ov, kind, id) ? <TableRowAction icon="refresh" text="Restore" />
        : (
          <>
            {isEdited(ov, kind, id) ? <TableRowAction icon="reset" text="Reset" /> : null}
            <TableRowAction icon="delete" text="Remove" />
          </>
        );
    const onAction = (kind: "bom" | "ops", e: Parameters<NonNullable<React.ComponentProps<typeof Table>["onRowActionClick"]>>[0]) => {
      const id = (e.detail.row as HTMLElement).dataset.lineId!;
      const action = (e.detail.action as HTMLElement).getAttribute("text");
      const added = kind === "bom" ? addedBom.has(id) : addedOps.has(id);
      if (added) setOv(i, kind === "bom" ? removeAddedBom(ov, id) : removeAddedOp(ov, id));
      else if (action === "Reset") setOv(i, resetLine(ov, kind, id));
      else if (action === "Restore") setOv(i, kind === "bom" ? patchBom(ov, id, { remove: false }) : patchOp(ov, id, { remove: false }));
      else setOv(i, kind === "bom" ? patchBom(ov, id, { remove: true }) : patchOp(ov, id, { remove: true }));
    };
    const dim = (kind: "bom" | "ops", id: string) => (isRemoved(ov, kind, id) ? { opacity: 0.55 } : undefined);
    const rate = (l: Outputs["ops"][number]) =>
      ov.ops?.find((o) => o.id === l.id)?.ratePerHour
      ?? (ov.addOps ?? []).find((o) => o.id === l.id)?.ratePerHour
      ?? (l.totalMin > 0 ? (l.cost * 60) / l.totalMin : 0);

    return (
      <Panel key={`${s.candidateIdx}-${s.batchQty}`} fixed
        headerText={`${candidateLabel(keys, cand.assignment)} — qty ${fmt(s.batchQty)}`}>
        <Title level="H6" style={{ margin: "0 0 0.25rem" }}>Bill of materials</Title>
        <Table rowActionCount={2} noDataText="No BOM lines."
          onRowActionClick={(e) => onAction("bom", e)}
          headerRow={
            <TableHeaderRow>
              <TableHeaderCell minWidth="9rem"><span>Item</span></TableHeaderCell>
              <TableHeaderCell minWidth="9rem"><span>Description</span></TableHeaderCell>
              <TableHeaderCell><span>Qty / unit</span></TableHeaderCell>
              <TableHeaderCell><span>Unit price</span></TableHeaderCell>
              <TableHeaderCell horizontalAlign="End"><span>Line total</span></TableHeaderCell>
              <TableHeaderCell><span></span></TableHeaderCell>
            </TableHeaderRow>
          }>
          {display.bom.map((l) => {
            const added = addedBom.has(l.id);
            return (
              <TableRow key={l.id} rowKey={l.id} data-line-id={l.id}
                actions={rowActions("bom", l.id, added)}>
                <TableCell>
                  {added
                    ? <Input value={l.itemCode} onInput={(e) => setOv(i, patchAddedBom(ov, l.id, { itemCode: e.target.value }))} />
                    : <Text style={dim("bom", l.id)}>{l.itemCode}</Text>}
                </TableCell>
                <TableCell>
                  {added
                    ? <Input value={l.desc} onInput={(e) => setOv(i, patchAddedBom(ov, l.id, { desc: e.target.value }))} />
                    : <Text style={dim("bom", l.id)}>{l.desc}</Text>}
                </TableCell>
                <TableCell>
                  <StepInput min={0} step={0.5} value={l.qtyPerUnit} disabled={isRemoved(ov, "bom", l.id)}
                    onChange={(e) => setOv(i, added
                      ? patchAddedBom(ov, l.id, { qtyPerUnit: e.target.value ?? 0 })
                      : patchBom(ov, l.id, { qtyPerUnit: e.target.value ?? 0 }))} />
                </TableCell>
                <TableCell>
                  <StepInput min={0} step={0.5} value={l.unitPrice} disabled={isRemoved(ov, "bom", l.id)}
                    onChange={(e) => setOv(i, added
                      ? patchAddedBom(ov, l.id, { unitPrice: e.target.value ?? 0 })
                      : patchBom(ov, l.id, { unitPrice: e.target.value ?? 0 }))} />
                </TableCell>
                <TableCell horizontalAlign="End"><Text style={dim("bom", l.id)}>{fmt(l.lineTotal)}</Text></TableCell>
                <TableCell>{rowStatus("bom", l.id, added)}</TableCell>
              </TableRow>
            );
          })}
        </Table>
        <Button icon="add" design="Transparent" onClick={() => setOv(i, addBomLine(ov))}>Add line</Button>

        <Title level="H6" style={{ margin: "0.75rem 0 0.25rem" }}>Operations</Title>
        <Table rowActionCount={2} noDataText="No operations."
          onRowActionClick={(e) => onAction("ops", e)}
          headerRow={
            <TableHeaderRow>
              <TableHeaderCell minWidth="9rem"><span>Resource</span></TableHeaderCell>
              <TableHeaderCell><span>Setup min</span></TableHeaderCell>
              <TableHeaderCell><span>Run min / unit</span></TableHeaderCell>
              <TableHeaderCell><span>Rate / hour</span></TableHeaderCell>
              <TableHeaderCell horizontalAlign="End"><span>Cost</span></TableHeaderCell>
              <TableHeaderCell><span></span></TableHeaderCell>
            </TableHeaderRow>
          }>
          {display.ops.map((l) => {
            const added = addedOps.has(l.id);
            // typed so it satisfies both Partial<OpOv> and Partial<AddedOp>
            const patch = (p: { setupMin?: number; runMinPerUnit?: number; ratePerHour?: number }) =>
              setOv(i, added ? patchAddedOp(ov, l.id, p) : patchOp(ov, l.id, p));
            return (
              <TableRow key={l.id} rowKey={l.id} data-line-id={l.id}
                actions={rowActions("ops", l.id, added)}>
                <TableCell>
                  {added
                    ? <Input value={l.resource} onInput={(e) => setOv(i, patchAddedOp(ov, l.id, { resource: e.target.value }))} />
                    : <Text style={dim("ops", l.id)}>{l.resource}</Text>}
                </TableCell>
                <TableCell>
                  <StepInput min={0} value={l.setupMin} disabled={isRemoved(ov, "ops", l.id)}
                    onChange={(e) => patch({ setupMin: e.target.value ?? 0 })} />
                </TableCell>
                <TableCell>
                  <StepInput min={0} step={0.1} value={l.runMinPerUnit} disabled={isRemoved(ov, "ops", l.id)}
                    onChange={(e) => patch({ runMinPerUnit: e.target.value ?? 0 })} />
                </TableCell>
                <TableCell>
                  <StepInput min={0} value={rate(l)} disabled={isRemoved(ov, "ops", l.id)}
                    onChange={(e) => patch({ ratePerHour: e.target.value ?? 0 })} />
                </TableCell>
                <TableCell horizontalAlign="End"><Text style={dim("ops", l.id)}>{fmt(l.cost)}</Text></TableCell>
                <TableCell>{rowStatus("ops", l.id, added)}</TableCell>
              </TableRow>
            );
          })}
        </Table>
        <Button icon="add" design="Transparent" onClick={() => setOv(i, addOpLine(ov))}>Add operation</Button>

        <Bar design="Footer" style={{ marginTop: "0.5rem" }}
          startContent={
            <Text>
              Material {fmt(totals.materialPerUnit)} · labor {fmt(totals.laborPerUnit)} · unit cost {fmt(totals.unitCost)}
            </Text>
          }
          endContent={<Text style={{ fontWeight: 600 }}>Unit price {fmt(totals.unitPrice)} · batch total {fmt(totals.batchTotal)}</Text>}
        />
      </Panel>
    );
  });

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
      <Title level="H5">Review outputs</Title>
      <Text>Adjust quantities, times, prices and rates line by line — totals recompute as you type. Saving stores the selection; the server recomputes every number from the run snapshot.</Text>
      {error ? <MessageStrip design="Negative" hideCloseButton>{error}</MessageStrip> : null}
      {saved ? <MessageStrip design="Positive" hideCloseButton>Selection saved — totals recomputed on the server.</MessageStrip> : null}
      {panels}
      <Bar design="FloatingFooter"
        startContent={<Text>Total across {selection.length} line{selection.length === 1 ? "" : "s"}: <span style={{ fontWeight: 700 }}>{fmt(grand)}</span></Text>}
        endContent={
          <Button design="Emphasized" disabled={saving || selection.length === 0} onClick={onSave}>
            {saving ? "Saving…" : "Save selection"}
          </Button>
        } />
    </div>
  );
}
