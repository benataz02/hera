import { useState } from "react";
import {
  Bar, Button, Dialog, Input, Label, MultiComboBox, MultiComboBoxItem, Option, Select,
  Table, TableCell, TableHeaderCell, TableHeaderRow, TableRow, TableRowAction, Text, Title,
} from "@ui5/webcomponents-react";
import type { Constraint, Issue, ModelDef, ResolvedLookups, Val } from "@hera/config-engine";
import { ExprInput } from "./ExprInput.tsx";
import { issueFor } from "./useDraftModel.ts";

type Update = (fn: (d: ModelDef) => ModelDef) => void;
type TableConstraint = Extract<Constraint, { kind: "table" }>;
// Combination-table cells are scalar (no string[] multicombo values), unlike the full Val union.
type Cell = Exclude<Val, string[]>;

// "true"/"false" -> boolean, numeric -> number, "" -> null, else string.
export const parseLit = (s: string): Cell =>
  s === "" ? null : s === "true" ? true : s === "false" ? false : !Number.isNaN(Number(s)) ? Number(s) : s;

export function RulesTab({ draft, update, issues, lookups }: {
  draft: ModelDef; update: Update; issues: Issue[]; lookups?: ResolvedLookups;
}) {
  const [editingTable, setEditingTable] = useState<number | null>(null);
  const setC = (i: number, c: Constraint) =>
    update((d) => ({ ...d, constraints: d.constraints.map((x, j) => (j === i ? c : x)) }));
  const removeC = (i: number) => update((d) => ({ ...d, constraints: d.constraints.filter((_, j) => j !== i) }));

  const exprs = draft.constraints.map((c, i) => [c, i] as const).filter(([c]) => c.kind === "expr");
  const tablesC = draft.constraints.map((c, i) => [c, i] as const).filter(([c]) => c.kind === "table");

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem", padding: "1rem" }}>
      <Bar design="Subheader" startContent={<Title level="H5">Expression constraints</Title>}
        endContent={<Button icon="add" onClick={() => update((d) => ({ ...d, constraints: [...d.constraints, { kind: "expr", assert: "", message: "" }] }))}>Add constraint</Button>} />
      <Table noDataText="No expression constraints." rowActionCount={1}
        onRowActionClick={(e) => removeC(Number(((e.detail.row as unknown) as HTMLElement).dataset.idx))}
        headerRow={
          <TableHeaderRow>
            <TableHeaderCell width="28%"><span>When (optional)</span></TableHeaderCell>
            <TableHeaderCell width="36%"><span>Must hold</span></TableHeaderCell>
            <TableHeaderCell><span>Message</span></TableHeaderCell>
          </TableHeaderRow>
        }>
        {exprs.map(([c, i]) => c.kind === "expr" ? (
          <TableRow key={i} rowKey={`ec-${i}`} data-idx={String(i)} actions={<TableRowAction icon="delete" text="Delete" />}>
            <TableCell>
              <ExprInput optional value={c.when} model={draft} fieldId={`expr-constraints[${i}].when`}
                issue={issueFor(issues, `constraints[${i}].when`)}
                onChange={(v) => setC(i, { ...c, when: v })} />
            </TableCell>
            <TableCell>
              <ExprInput value={c.assert} model={draft} fieldId={`expr-constraints[${i}].assert`}
                issue={issueFor(issues, `constraints[${i}].assert`)} placeholder='e.g. coating != "none" || material == "steel"'
                onChange={(v) => setC(i, { ...c, assert: v ?? "" })} />
            </TableCell>
            <TableCell>
              <Input value={c.message} placeholder="Shown when violated"
                onInput={(e) => setC(i, { ...c, message: e.target.value })} />
            </TableCell>
          </TableRow>
        ) : null)}
      </Table>

      <Bar design="Subheader" startContent={<Title level="H5">Combination tables</Title>}
        endContent={<Button icon="add" onClick={() => {
          update((d) => ({ ...d, constraints: [...d.constraints, { kind: "table", params: [], rows: [], mode: "forbid" }] }));
          setEditingTable(draft.constraints.length); // index of the appended one
        }}>Add combination table</Button>} />
      <Table noDataText="No combination tables." rowActionCount={2}
        onRowActionClick={(e) => {
          const i = Number(((e.detail.row as unknown) as HTMLElement).dataset.idx);
          const icon = ((e.detail.action as unknown) as HTMLElement).getAttribute("icon");
          if (icon === "delete") removeC(i);
          else setEditingTable(i);
        }}
        headerRow={
          <TableHeaderRow>
            <TableHeaderCell><span>Parameters</span></TableHeaderCell>
            <TableHeaderCell><span>Mode</span></TableHeaderCell>
            <TableHeaderCell><span>Rows</span></TableHeaderCell>
          </TableHeaderRow>
        }>
        {tablesC.map(([c, i]) => c.kind === "table" ? (
          <TableRow key={i} rowKey={`tc-${i}`} data-idx={String(i)}
            actions={<><TableRowAction icon="edit" text="Edit" /><TableRowAction icon="delete" text="Delete" /></>}>
            <TableCell><Text>{c.params.join(" × ") || "—"}</Text></TableCell>
            <TableCell><Text>{c.mode}</Text></TableCell>
            <TableCell><Text>{String(c.rows.length)}</Text></TableCell>
          </TableRow>
        ) : null)}
      </Table>

      {editingTable !== null && draft.constraints[editingTable]?.kind === "table" ? (
        <ComboTableDialog
          draft={draft} lookups={lookups}
          value={draft.constraints[editingTable] as TableConstraint}
          onOk={(c) => { setC(editingTable, c); setEditingTable(null); }}
          onCancel={() => setEditingTable(null)}
        />
      ) : null}
    </div>
  );
}

function ComboTableDialog({ draft, lookups, value, onOk, onCancel }: {
  draft: ModelDef; lookups?: ResolvedLookups; value: TableConstraint;
  onOk: (c: TableConstraint) => void; onCancel: () => void;
}) {
  const [c, setCLocal] = useState<TableConstraint>(structuredClone(value));
  // Only finite params can appear in a combination table (checkModel enforces the same).
  const eligible = draft.parameters.filter((p) => p.domain?.kind === "options" || p.type === "boolean");
  const optionsFor = (key: string): Cell[] | null => {
    const p = draft.parameters.find((x) => x.key === key);
    if (p?.type === "boolean") return [true, false];
    // Combination-eligible params carry scalar option values; narrow the wider Val to Cell.
    if (p?.domain?.kind === "options" && p.domain.ref.source === "manual") return p.domain.ref.options.map((o) => o.value as Cell);
    const dom = lookups?.domains[key];
    return dom ? dom.map((o) => o.value as Cell) : null;
  };

  const setParams = (params: string[]) =>
    setCLocal((x) => ({
      ...x,
      params,
      rows: x.rows.map((r) => params.map((k) => r[x.params.indexOf(k)] ?? null)),
    }));

  return (
    <Dialog open headerText="Combination table" onClose={onCancel} style={{ width: "min(52rem, 92vw)" }}
      footer={
        <Bar design="Footer" endContent={
          <>
            <Button design="Emphasized" disabled={c.params.length < 2} onClick={() => onOk(c)}>OK</Button>
            <Button onClick={onCancel}>Cancel</Button>
          </>
        } />
      }>
      <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem", padding: "0.5rem 0" }}>
        <div style={{ display: "flex", gap: "0.75rem", alignItems: "end" }}>
          <div style={{ flex: 1 }}>
            <Label required>Parameters (2+)</Label>
            <MultiComboBox
              onSelectionChange={(e) => setParams(e.detail.items.map((i) => (i as HTMLElement).getAttribute("text")!))}>
              {eligible.map((p) => (
                <MultiComboBoxItem key={p.key} text={p.key} selected={c.params.includes(p.key)} />
              ))}
            </MultiComboBox>
          </div>
          <div>
            <Label>Mode</Label>
            <Select value={c.mode} onChange={(e) => setCLocal((x) => ({ ...x, mode: (e.detail.selectedOption as HTMLElement).dataset.v as "allow" | "forbid" }))}>
              <Option value="allow" data-v="allow">Allow only these</Option>
              <Option value="forbid" data-v="forbid">Forbid these</Option>
            </Select>
          </div>
        </div>

        {c.params.length >= 2 ? (
          <Table noDataText="No rows yet." rowActionCount={1}
            onRowActionClick={(e) => {
              const r = Number(((e.detail.row as unknown) as HTMLElement).dataset.idx);
              setCLocal((x) => ({ ...x, rows: x.rows.filter((_, j) => j !== r) }));
            }}
            headerRow={
              <TableHeaderRow>
                {c.params.map((k) => <TableHeaderCell key={k}><span>{k}</span></TableHeaderCell>)}
              </TableHeaderRow>
            }>
            {c.rows.map((row, ri) => (
              <TableRow key={ri} rowKey={`r-${ri}`} data-idx={String(ri)} actions={<TableRowAction icon="delete" text="Delete" />}>
                {c.params.map((k, ci) => {
                  const opts = optionsFor(k);
                  const setCell = (v: Cell) =>
                    setCLocal((x) => ({ ...x, rows: x.rows.map((r, j) => (j === ri ? r.map((cell, cj) => (cj === ci ? v : cell)) : r)) }));
                  return (
                    <TableCell key={k}>
                      {opts ? (
                        <Select value={JSON.stringify(row[ci] ?? null)}
                          onChange={(e) => setCell(JSON.parse((e.detail.selectedOption as HTMLElement).dataset.j!))}>
                          <Option value="null" data-j="null">—</Option>
                          {opts.map((v, oi) => (
                            <Option key={oi} value={JSON.stringify(v)} data-j={JSON.stringify(v)}>{String(v)}</Option>
                          ))}
                        </Select>
                      ) : (
                        <Input value={String(row[ci] ?? "")} onInput={(e) => setCell(parseLit(e.target.value))} />
                      )}
                    </TableCell>
                  );
                })}
              </TableRow>
            ))}
          </Table>
        ) : <Text>Pick at least two parameters, then add rows.</Text>}

        <Button icon="add" style={{ alignSelf: "start" }} disabled={c.params.length < 2}
          onClick={() => setCLocal((x) => ({ ...x, rows: [...x.rows, x.params.map(() => null)] }))}>Add row</Button>
      </div>
    </Dialog>
  );
}
