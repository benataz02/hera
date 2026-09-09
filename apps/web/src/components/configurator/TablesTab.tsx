import { useQuery } from "@tanstack/react-query";
import {
  Bar, Button, Form, FormGroup, FormItem, Input, MessageStrip, ObjectStatus, Option, Panel, Select,
  StepInput, Table, TableCell, TableHeaderCell, TableHeaderRow, TableRow, TableRowAction, Text,
  Title, Toolbar, ToolbarButton, ToolbarItem, ToolbarSpacer,
} from "@ui5/webcomponents-react";
import type { Issue, LookupRef, ModelDef, TableColumn, TableDef } from "@hera/config-engine";
import { orpc } from "../../orpc.ts";
import { confirm } from "../confirm.ts";
import { ExprInput } from "./ExprInput.tsx";
import { PAIRS, W, lbl } from "./ParamDialog.tsx";
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

/** The one mandatory item grid every model carries. `itemcode` rides to SAP as a UDF rather than
 *  DocumentLine.ItemCode: the generic configurator item stays the B1 item (config-quote.ts, and
 *  RESERVED_LINE_FIELDS enforces it), and the Crystal Report layouts read U_HERA_ItemCode.
 *  `basis` is its own column rather than `quantity` reused — splitShares weights a row by
 *  basis x qty, so pointing both at one column would weight by qty squared. Left blank on every
 *  row it weighs nothing, which is already an equal split. */
export const itemsTable = (): TableDef => ({
  key: "items",
  title: "Items",
  role: "items",
  qtyCol: "quantity",
  basisCol: "basis",
  map: { itemcode: "U_HERA_ItemCode", itemname: "ItemDescription" },
  columns: [
    { key: "itemcode", label: "Item code", type: "string", cell: { kind: "input" } },
    { key: "itemname", label: "Item name", type: "string", cell: { kind: "input" } },
    { key: "quantity", label: "Quantity", type: "number", cell: { kind: "input" } },
    { key: "basis", label: "Cost basis", type: "number", cell: { kind: "input" } },
  ],
});

/** Columns the table's own definition leans on, so the delete action is withheld from them:
 *  dropping one would either break the price split or silently stop writing a mapped SAP field.
 *  Derived rather than a hardcoded list, so it follows the author if they remap. */
const lockedColumns = (t: TableDef): Set<string> =>
  t.role === "items" ? new Set([t.qtyCol, t.basisCol, ...Object.keys(t.map ?? {})]) : new Set<string>();

// Tables: n rows by author-defined columns. Two roles over one shape - a calc table only feeds sums
// into the model's formulas, the items table does that AND becomes n quotation lines (merge
// production: 1 config, 1 BOM, 1 routing, n items). Every table contributes <table>_<column> and
// <table>_count to every expression scope, which is the whole interface to the rest of the model.
// The role is not a choice on this page: a model has exactly one items table, seeded by
// starterModel and undeletable, and every table added here is a calc table.
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

  const addCalcTable = () =>
    update((d) => ({
      ...d,
      tables: [
        ...(d.tables ?? []),
        {
          key: newKey("table", (d.tables ?? []).map((t) => t.key)),
          title: "Table",
          role: "calc",
          columns: [{ key: "value", label: "Value", type: "number", cell: { kind: "input" } }],
        },
      ],
    }));

  const deleteTable = async (i: number, t: TableDef) => {
    const ok = await confirm({
      title: "Delete",
      message: `Delete table "${t.title || t.key}"? Formulas reading ${t.key}_count or its column sums will stop resolving.`,
      actionText: "Delete",
      destructive: true,
    });
    if (ok) update((d) => ({ ...d, tables: (d.tables ?? []).filter((_, j) => j !== i) }));
  };

  // The items grid leads: it is the one that becomes quotation lines. Carry the original index —
  // every edit and every issue path is keyed on position in draft.tables, not on display order.
  const ordered = defs
    .map((t, i) => ({ t, i }))
    .sort((a, b) => Number(b.t.role === "items") - Number(a.t.role === "items"));

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem", padding: "1rem" }}>
      <Bar design="Subheader" startContent={<Title level="H5">Tables</Title>}
        endContent={<Button icon="add" onClick={addCalcTable}>Add calculation table</Button>} />
      <Text>
        Rows the salesperson fills in per configuration — not the shared masterdata a <code>LOOKUP()</code>
        {" "}or a Table domain reads from. Numeric columns sum into <code>&lt;table&gt;_&lt;column&gt;</code> and
        the row count into <code>&lt;table&gt;_count</code>, usable anywhere a parameter is.
      </Text>

      {/* Only reachable on a model saved before the item grid became mandatory. Deliberately not
          repaired on render: materialising a table the author never asked for would mark their
          draft dirty behind their back. */}
      {defs.every((t) => t.role !== "items") ? (
        <MessageStrip design="Critical" hideCloseButton>
          <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "0.5rem" }}>
            <span>This model has no item grid, so a quote falls back to one generic line per candidate.</span>
            <Button icon="add" design="Transparent"
              onClick={() => update((d) => ({ ...d, tables: [...(d.tables ?? []), itemsTable()] }))}>
              Add item grid
            </Button>
          </div>
        </MessageStrip>
      ) : null}

      {ordered.map(({ t, i }) => {
        const mine = issues.filter((x) => x.path.startsWith(`tables[${i}]`));
        const isItems = t.role === "items";
        const numeric = t.columns.filter((c) => c.type === "number");
        const locked = lockedColumns(t);
        const noNumber = <div>{numeric.length ? "Pick a number column." : "This table has no number column yet — add one."}</div>;
        return (
          <Panel key={i} collapsed={false}
            header={
              <Toolbar design="Transparent" alignContent="Start" accessibleName={`${t.title || t.key} actions`}>
                <ToolbarItem><Title level="H5">{t.title || t.key}</Title></ToolbarItem>
                <ToolbarItem>
                  <Text style={{ color: "var(--sapContent_LabelColor)" }}>
                    {`${t.key} · ${t.columns.length} column${t.columns.length === 1 ? "" : "s"}`}
                  </Text>
                </ToolbarItem>
                <ToolbarSpacer />
                {isItems ? (
                  <ToolbarItem>
                    <ObjectStatus state="Information">Required — becomes the quotation lines</ObjectStatus>
                  </ToolbarItem>
                ) : (
                  <ToolbarButton icon="delete" design="Transparent" text="Delete table"
                    onClick={() => void deleteTable(i, t)} />
                )}
              </Toolbar>
            }>
            <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem", padding: "0.5rem 0" }}>
              {mine.length ? (
                <MessageStrip design="Negative" hideCloseButton>
                  {mine.map((x) => x.message).join(" - ")}
                </MessageStrip>
              ) : null}

              <Form {...PAIRS}>
                <FormGroup accessibleName="Table">
                  <FormItem labelContent={lbl("Key", "The name formulas use. This table contributes <key>_count and one sum per numeric column to every expression scope.", true)}>
                    <Input value={t.key} style={W}
                      onInput={(e) => edit(i, (x) => ({ ...x, key: e.target.value }) as TableDef)} />
                  </FormItem>
                  <FormItem labelContent={lbl("Title", "The heading the salesperson sees above the grid on the configuration form.")}>
                    <Input value={t.title} style={W}
                      onInput={(e) => edit(i, (x) => ({ ...x, title: e.target.value }) as TableDef)} />
                  </FormItem>
                  {/* Unplaced is legal, not broken: the form appends it as a trailing section rather
                      than hiding a table whose sums the model already depends on. */}
                  <FormItem labelContent={lbl("Section", "Which section of the form the grid appears in. Left unplaced it still renders, in a trailing section of its own.")}>
                    <Select style={W} value={placedIn(t.key) ?? NOT_PLACED}
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
                  </FormItem>
                  <FormItem labelContent={lbl("Minimum rows", "Rows the grid starts with and refuses to drop below. Zero lets the salesperson leave it empty.")}>
                    <StepInput style={W} min={0} value={t.minRows ?? 0}
                      onChange={(e) => edit(i, (x) => ({ ...x, minRows: e.target.value || undefined }) as TableDef)} />
                  </FormItem>
                  <FormItem labelContent={lbl("Maximum rows", "Caps how many rows can be added. Zero means no cap.")}>
                    <StepInput style={W} min={0} value={t.maxRows ?? 0}
                      onChange={(e) => edit(i, (x) => ({ ...x, maxRows: e.target.value || undefined }) as TableDef)} />
                  </FormItem>
                </FormGroup>

                {t.role === "items" ? (
                  <FormGroup accessibleName="Quotation lines">
                    <FormItem labelContent={lbl("Quantity column", "Pieces per row. Multiplied by the batch quantity to give the SAP line's Quantity — B1's own ItemCode and Quantity are owned by the price split and cannot be mapped.", true)}>
                      <Select style={W} value={t.qtyCol}
                        valueState={numeric.some((c) => c.key === t.qtyCol) ? "None" : "Negative"}
                        valueStateMessage={noNumber}
                        onChange={(e) => edit(i, (x) => ({ ...x, qtyCol: optValue(e) }) as TableDef)}>
                        {numeric.map((c) => (
                          <Option key={c.key} value={c.key} data-v={c.key} selected={t.qtyCol === c.key}>{c.label}</Option>
                        ))}
                      </Select>
                    </FormItem>
                    <FormItem labelContent={lbl("Cost basis column", "How the configuration's price is divided between rows: each row's share is weighted by basis times quantity, to the cent. Left empty on every row, the split is equal.", true)}>
                      <Select style={W} value={t.basisCol}
                        valueState={numeric.some((c) => c.key === t.basisCol) ? "None" : "Negative"}
                        valueStateMessage={noNumber}
                        onChange={(e) => edit(i, (x) => ({ ...x, basisCol: optValue(e) }) as TableDef)}>
                        {numeric.map((c) => (
                          <Option key={c.key} value={c.key} data-v={c.key} selected={t.basisCol === c.key}>{c.label}</Option>
                        ))}
                      </Select>
                    </FormItem>
                  </FormGroup>
                ) : null}
              </Form>

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
                    {isItems ? (
                      <TableHeaderCell minWidth="11rem"><span>B1 line field</span></TableHeaderCell>
                    ) : null}
                  </TableHeaderRow>
                }>
                {t.columns.map((c, j) => (
                  <TableRow key={j} rowKey={`col-${j}`} data-idx={String(j)}
                    actions={locked.has(c.key) ? undefined : <TableRowAction icon="delete" text="Delete" />}>
                    <TableCell>
                      <Input value={c.key} onInput={(e) => setCol(i, j, { key: e.target.value })} />
                    </TableCell>
                    <TableCell>
                      <Input value={c.label} onInput={(e) => setCol(i, j, { label: e.target.value })} />
                    </TableCell>
                    <TableCell>
                      <Select style={W} value={c.type}
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
                      <Select style={W} value={c.cell.kind}
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
                    {isItems ? (
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
      <Input style={W} value={value} disabled={loading}
        placeholder={loading ? "reading SAP..." : "U_... (SAP unreachable)"}
        onInput={(e) => onChange(e.target.value)} />
    );
  // A seeded mapping (U_HERA_ItemCode) only resolves if the tenant actually created the UDF. Keep
  // the value and say so, rather than letting the Select fall blank and drop the mapping silently:
  // the alternative surfaces as a 400 from B1 at the moment the quote is posted.
  const missing = !!value && !fields.some((f) => f.name === value);
  return (
    <Select style={W} value={value} valueState={missing ? "Critical" : "None"}
      valueStateMessage={<div>{`${value} does not exist on this tenant's DocumentLines — create the UDF in B1, or map the column to another field.`}</div>}
      onChange={(e) => onChange(optValue(e))}>
      <Option value="" data-v="" selected={!value}>— not written —</Option>
      {missing ? <Option value={value} data-v={value} selected additionalText="missing">{value}</Option> : null}
      {fields.map((f) => (
        <Option key={f.name} value={f.name} data-v={f.name} selected={value === f.name}
          additionalText={f.isUDF ? "UDF" : undefined}>
          {f.label === f.name ? f.name : `${f.label} (${f.name})`}
        </Option>
      ))}
    </Select>
  );
}
