import { useQuery } from "@tanstack/react-query";
import {
  Bar, Button, Input, Label, MessageStrip, Option, Panel, Select, StepInput,
  Table, TableCell, TableHeaderCell, TableHeaderRow, TableRow, TableRowAction, Text, Title, Toolbar,
} from "@ui5/webcomponents-react";
import type { Issue, LookupRef, ModelDef, TableColumn, TableDef } from "@hera/config-engine";
import { orpc } from "../../orpc.ts";
import { ExprInput } from "./ExprInput.tsx";
import type { TableCols } from "./exprHelpers.ts";
import { issueFor } from "./useDraftModel.ts";

type Update = (fn: (d: ModelDef) => ModelDef) => void;
const NOT_PLACED = " none";

const newKey = (prefix: string, taken: string[]) => {
  let n = taken.length + 1;
  while (taken.includes(`${prefix}${n}`)) n++;
  return `${prefix}${n}`;
};

const optValue = (e: { detail: { selectedOption: unknown } }) => (e.detail.selectedOption as HTMLElement).dataset.v!;

/** A manual option list, as one comma-separated field. Enough for "circular, rectangular"; a list
 *  worth maintaining belongs in masterdata, where it is shared across models. */
const manualText = (ref: LookupRef) =>
  ref.source === "manual" ? ref.options.map((o) => String(o.value)).join(", ") : "";
const parseManual = (type: TableColumn["type"], text: string): LookupRef => ({
  source: "manual",
  options: text
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((v) => ({ value: type === "number" ? Number(v) : type === "boolean" ? v === "true" : v })),
});

const firstNumeric = (cols: TableColumn[]) => cols.find((c) => c.type === "number")?.key ?? "";

/** calc to items and back, keeping whatever the other role does not carry. */
function withRole(t: TableDef, role: TableDef["role"]): TableDef {
  if (t.role === role) return t;
  const { key, title, columns, minRows, maxRows } = t;
  const base = { key, title, columns, minRows, maxRows };
  return role === "items"
    ? { ...base, role: "items", qtyCol: firstNumeric(columns), basisCol: firstNumeric(columns) }
    : { ...base, role: "calc" };
}

// Tables: n rows by author-defined columns. Two roles over one shape - a calc table only feeds sums
// into the model's formulas, an items table does that AND becomes n quotation lines (merge
// production: 1 config, 1 BOM, 1 routing, n items). Every table contributes <table>_<column> and
// <table>_count to every expression scope, which is the whole interface to the rest of the model.
export function TablesTab({ draft, update, issues, tables }: {
  draft: ModelDef;
  update: Update;
  issues: Issue[];
  tables?: TableCols[];
}) {
  const defs = draft.tables ?? [];
  // Only the mapping dropdown depends on SAP. It failing must not block model authoring, so the
  // map cell falls back to a free-text field rather than this tab refusing to render.
  const lineFields = useQuery({ ...orpc.models.lineFields.queryOptions(), retry: false, staleTime: 60 * 60_000 });

  const edit = (i: number, fn: (t: TableDef) => TableDef) =>
    update((d) => ({ ...d, tables: (d.tables ?? []).map((t, j) => (j === i ? fn(t) : t)) }));
  const editCols = (i: number, fn: (c: TableColumn[]) => TableColumn[]) =>
    edit(i, (t) => ({ ...t, columns: fn(t.columns) }) as TableDef);
  const setCol = (i: number, j: number, patch: Partial<TableColumn>) =>
    editCols(i, (cs) => cs.map((c, k) => (k === j ? ({ ...c, ...patch } as TableColumn) : c)));

  /** Placement lives on structure.sections, so moving a table is a structure edit, not a table one. */
  const placedIn = (key: string) => draft.structure.sections.find((s) => (s.tables ?? []).includes(key))?.key;
  const place = (key: string, sectionKey: string) =>
    update((d) => ({
      ...d,
      structure: {
        sections: d.structure.sections.map((s) => {
          const without = (s.tables ?? []).filter((k) => k !== key);
          const next = s.key === sectionKey ? [...without, key] : without;
          return next.length ? { ...s, tables: next } : { ...s, tables: undefined };
        }),
      },
    }));

  const addTable = (role: TableDef["role"]) =>
    update((d) => {
      const key = newKey(role === "items" ? "items" : "table", (d.tables ?? []).map((t) => t.key));
      const columns: TableColumn[] =
        role === "items"
          ? [
              { key: "code", label: "Item code", type: "string", cell: { kind: "input" } },
              { key: "qty", label: "Pieces", type: "number", cell: { kind: "input" } },
              { key: "basis", label: "Cost basis", type: "number", cell: { kind: "input" } },
            ]
          : [{ key: "value", label: "Value", type: "number", cell: { kind: "input" } }];
      const def: TableDef =
        role === "items"
          ? { key, title: "Items", role: "items", columns, qtyCol: "qty", basisCol: "basis" }
          : { key, title: "Table", role: "calc", columns };
      return { ...d, tables: [...(d.tables ?? []), def] };
    });

  const hasItems = defs.some((t) => t.role === "items");

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem", padding: "1rem" }}>
      <Bar design="Subheader" startContent={<Title level="H5">Tables</Title>}
        endContent={
          <Toolbar design="Transparent">
            <Button icon="add" onClick={() => addTable("calc")}>Add calculation table</Button>
            <Button icon="add" design="Emphasized" disabled={hasItems} onClick={() => addTable("items")}
              tooltip={hasItems ? "A model can have one item matrix" : undefined}>Add item matrix</Button>
          </Toolbar>
        } />
      <Text>
        A table's numeric columns are summed into <code>&lt;table&gt;_&lt;column&gt;</code>, and its row count
        into <code>&lt;table&gt;_count</code> — use those anywhere a parameter works. An item matrix additionally
        becomes one quotation line per row, with the configuration's price split across them by cost
        basis times pieces.
      </Text>
      <Text>
        These are rows the salesperson fills in per configuration — not the shared masterdata tables
        a <code>LOOKUP()</code> or a Table domain reads from.
      </Text>
      {defs.length === 0 ? <Text>No tables. A model without one behaves exactly as before.</Text> : null}

      {defs.map((t, i) => {
        const mine = issues.filter((x) => x.path.startsWith(`tables[${i}]`));
        return (
          <Panel key={i} collapsed={false} headerText={`${t.title} (${t.key})`}>
            <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem", padding: "0.5rem 0" }}>
              {mine.length ? (
                <MessageStrip design="Negative" hideCloseButton>
                  {mine.map((x) => x.message).join(" - ")}
                </MessageStrip>
              ) : null}

              <Toolbar design="Transparent">
                <Label>Key</Label>
                <Input value={t.key} style={{ width: "9rem" }}
                  onInput={(e) => edit(i, (x) => ({ ...x, key: e.target.value }) as TableDef)} />
                <Label>Title</Label>
                <Input value={t.title} style={{ width: "12rem" }}
                  onInput={(e) => edit(i, (x) => ({ ...x, title: e.target.value }) as TableDef)} />
                <Label>Role</Label>
                <Select style={{ width: "10rem" }} value={t.role}
                  onChange={(e) => edit(i, (x) => withRole(x, optValue(e) as TableDef["role"]))}>
                  <Option value="calc" data-v="calc" selected={t.role === "calc"}>Calculation</Option>
                  <Option value="items" data-v="items" selected={t.role === "items"}
                    {...(hasItems && t.role !== "items" ? ({ disabled: true } as Record<string, unknown>) : {})}>
                    Item matrix
                  </Option>
                </Select>
                <Label>Section</Label>
                {/* Unplaced is legal, not broken: the form appends it as a trailing section rather
                    than hiding a table whose sums the model already depends on. */}
                <Select style={{ width: "12rem" }} value={placedIn(t.key) ?? NOT_PLACED}
                  onChange={(e) => place(t.key, optValue(e))}>
                  <Option value={NOT_PLACED} data-v={NOT_PLACED} selected={!placedIn(t.key)}>
                    — its own section —
                  </Option>
                  {draft.structure.sections.map((s) => (
                    <Option key={s.key} value={s.key} data-v={s.key} selected={placedIn(t.key) === s.key}>
                      {s.title}
                    </Option>
                  ))}
                </Select>
                <Label>Min rows</Label>
                <StepInput style={{ width: "6rem" }} min={0} value={t.minRows ?? 0}
                  onChange={(e) => edit(i, (x) => ({ ...x, minRows: e.target.value || undefined }) as TableDef)} />
                <Label>Max rows</Label>
                <StepInput style={{ width: "6rem" }} min={0} value={t.maxRows ?? 0}
                  onChange={(e) => edit(i, (x) => ({ ...x, maxRows: e.target.value || undefined }) as TableDef)} />
                <Button icon="delete" design="Transparent"
                  onClick={() => update((d) => ({ ...d, tables: (d.tables ?? []).filter((_, j) => j !== i) }))}>
                  Delete table
                </Button>
              </Toolbar>

              {t.role === "items" ? (
                <Toolbar design="Transparent">
                  <Label>Pieces column</Label>
                  <Select style={{ width: "11rem" }} value={t.qtyCol}
                    onChange={(e) => edit(i, (x) => ({ ...x, qtyCol: optValue(e) }) as TableDef)}>
                    {t.columns.filter((c) => c.type === "number").map((c) => (
                      <Option key={c.key} value={c.key} data-v={c.key} selected={t.qtyCol === c.key}>{c.label}</Option>
                    ))}
                  </Select>
                  <Label>Cost basis column</Label>
                  <Select style={{ width: "11rem" }} value={t.basisCol}
                    onChange={(e) => edit(i, (x) => ({ ...x, basisCol: optValue(e) }) as TableDef)}>
                    {t.columns.filter((c) => c.type === "number").map((c) => (
                      <Option key={c.key} value={c.key} data-v={c.key} selected={t.basisCol === c.key}>{c.label}</Option>
                    ))}
                  </Select>
                  <Text>The configuration total is split across rows by basis times pieces, to the cent.</Text>
                </Toolbar>
              ) : null}

              <Table noDataText="No columns." rowActionCount={1} overflowMode="Scroll"
                onRowActionClick={(e) => {
                  const j = Number((e.detail.row as unknown as HTMLElement).dataset.idx);
                  editCols(i, (cs) => cs.filter((_, k) => k !== j));
                }}
                headerRow={
                  <TableHeaderRow>
                    <TableHeaderCell width="8rem"><span>Key</span></TableHeaderCell>
                    <TableHeaderCell minWidth="9rem"><span>Label</span></TableHeaderCell>
                    <TableHeaderCell width="8rem"><span>Type</span></TableHeaderCell>
                    <TableHeaderCell width="6rem"><span>Unit</span></TableHeaderCell>
                    <TableHeaderCell width="9rem"><span>Cell</span></TableHeaderCell>
                    <TableHeaderCell minWidth="14rem"><span>Options / formula</span></TableHeaderCell>
                    {t.role === "items" ? (
                      <TableHeaderCell minWidth="11rem"><span>B1 line field</span></TableHeaderCell>
                    ) : null}
                  </TableHeaderRow>
                }>
                {t.columns.map((c, j) => (
                  <TableRow key={j} rowKey={`col-${j}`} data-idx={String(j)}
                    actions={<TableRowAction icon="delete" text="Delete" />}>
                    <TableCell>
                      <Input value={c.key} onInput={(e) => setCol(i, j, { key: e.target.value })} />
                    </TableCell>
                    <TableCell>
                      <Input value={c.label} onInput={(e) => setCol(i, j, { label: e.target.value })} />
                    </TableCell>
                    <TableCell>
                      <Select style={{ width: "100%" }} value={c.type}
                        onChange={(e) => setCol(i, j, { type: optValue(e) as TableColumn["type"] })}>
                        {(["string", "number", "boolean"] as const).map((ty) => (
                          <Option key={ty} value={ty} data-v={ty} selected={c.type === ty}>{ty}</Option>
                        ))}
                      </Select>
                    </TableCell>
                    <TableCell>
                      <Input value={c.unit ?? ""} onInput={(e) => setCol(i, j, { unit: e.target.value || undefined })} />
                    </TableCell>
                    <TableCell>
                      <Select style={{ width: "100%" }} value={c.cell.kind}
                        onChange={(e) => {
                          const kind = optValue(e) as TableColumn["cell"]["kind"];
                          setCol(i, j, {
                            cell:
                              kind === "formula" ? { kind: "formula", expr: "0" }
                              : kind === "options" ? { kind: "options", ref: { source: "manual", options: [] } }
                              : { kind: "input" },
                          });
                        }}>
                        <Option value="input" data-v="input" selected={c.cell.kind === "input"}>Typed in</Option>
                        <Option value="options" data-v="options" selected={c.cell.kind === "options"}>Options</Option>
                        <Option value="formula" data-v="formula" selected={c.cell.kind === "formula"}>Computed</Option>
                      </Select>
                    </TableCell>
                    <TableCell>
                      {c.cell.kind === "formula" ? (
                        // Same scope check.ts applies: the model's identifiers plus this row's
                        // earlier columns. A reference to a later column is an error, not a cycle.
                        <ExprInput value={c.cell.expr} model={draft} tables={tables}
                          extraVars={t.columns.slice(0, j).map((x) => x.key)}
                          fieldId={`expr-tables[${i}].columns[${j}]`}
                          issue={issueFor(issues, `tables[${i}].columns[${j}].cell`)}
                          onChange={(v) => setCol(i, j, { cell: { kind: "formula", expr: v ?? "" } })} />
                      ) : c.cell.kind === "options" ? (
                        <OptionsCell col={c} tables={tables ?? []}
                          onChange={(ref) => setCol(i, j, { cell: { kind: "options", ref } })} />
                      ) : (
                        <Text>Typed in by the salesperson</Text>
                      )}
                    </TableCell>
                    {t.role === "items" ? (
                      <TableCell>
                        <LineFieldSelect value={t.map?.[c.key] ?? ""}
                          fields={lineFields.data ?? null} loading={lineFields.isPending}
                          onChange={(field) =>
                            edit(i, (x) => {
                              const map = { ...((x as Extract<TableDef, { role: "items" }>).map ?? {}) };
                              if (field) map[c.key] = field;
                              else delete map[c.key];
                              return { ...x, map: Object.keys(map).length ? map : undefined } as TableDef;
                            })} />
                      </TableCell>
                    ) : null}
                  </TableRow>
                ))}
              </Table>
              <div>
                <Button icon="add" onClick={() =>
                  editCols(i, (cs) => [
                    ...cs,
                    { key: newKey("col", cs.map((c) => c.key)), label: "Column", type: "number", cell: { kind: "input" } },
                  ])}>Add column</Button>
              </div>
            </div>
          </Panel>
        );
      })}
    </div>
  );
}

/** Inline source picker: a comma-separated list, or a masterdata table/query column. */
function OptionsCell({ col, tables, onChange }: {
  col: TableColumn;
  tables: TableCols[];
  onChange: (ref: LookupRef) => void;
}) {
  if (col.cell.kind !== "options") return null;
  const ref = col.cell.ref;
  const src = ref.source === "manual" ? "" : ref.table;
  const cols = ref.source === "manual" ? [] : (tables.find((t) => t.name === ref.table)?.columns ?? []);

  return (
    <div style={{ display: "flex", gap: "0.25rem", width: "100%" }}>
      <Select style={{ flex: 1 }} value={src}
        onChange={(e) => {
          const name = optValue(e);
          if (!name) return onChange({ source: "manual", options: [] });
          const kind = tables.find((t) => t.name === name)?.kind;
          // a query ref takes its key/label columns by convention (refKeyCols); a table names one
          onChange(kind === "query" ? { source: "query", table: name } : { source: "table", table: name, valueCol: "" });
        }}>
        <Option value="" data-v="" selected={ref.source === "manual"}>List...</Option>
        {tables.map((t) => (
          <Option key={t.name} value={t.name} data-v={t.name} selected={src === t.name}>{t.name}</Option>
        ))}
      </Select>
      {ref.source === "manual" ? (
        <Input style={{ flex: 2 }} placeholder="circular, rectangular" value={manualText(ref)}
          onInput={(e) => onChange(parseManual(col.type, e.target.value))} />
      ) : ref.source === "table" ? (
        <Select style={{ flex: 1 }} value={ref.valueCol}
          onChange={(e) => onChange({ ...ref, valueCol: optValue(e) })}>
          <Option value="" data-v="" selected={!ref.valueCol}>value column...</Option>
          {cols.map((c) => <Option key={c} value={c} data-v={c} selected={ref.valueCol === c}>{c}</Option>)}
        </Select>
      ) : null}
    </div>
  );
}

/** The tenant's own DocumentLine UDFs when SAP answers, a free-text field when it does not. */
function LineFieldSelect({ value, fields, loading, onChange }: {
  value: string;
  fields: { name: string; label: string; isUDF: boolean }[] | null;
  loading: boolean;
  onChange: (field: string) => void;
}) {
  if (!fields)
    return (
      <Input style={{ width: "100%" }} value={value} disabled={loading}
        placeholder={loading ? "reading SAP..." : "U_... (SAP unreachable)"}
        onInput={(e) => onChange(e.target.value)} />
    );
  return (
    <Select style={{ width: "100%" }} value={value} onChange={(e) => onChange(optValue(e))}>
      <Option value="" data-v="" selected={!value}>— not written —</Option>
      {fields.map((f) => (
        <Option key={f.name} value={f.name} data-v={f.name} selected={value === f.name}
          additionalText={f.isUDF ? "UDF" : undefined}>
          {f.label === f.name ? f.name : `${f.label} (${f.name})`}
        </Option>
      ))}
    </Select>
  );
}
