import { useMemo } from "react";
import {
  CheckBox, Input, Option, Select, Table, TableCell, TableHeaderCell,
  TableHeaderRow, TableRow, TableRowAction, Text, Title, Toolbar, ToolbarButton,
} from "@ui5/webcomponents-react";
import {
  aggregateKey, columnOptions, evalTableRows,
  type ResolvedLookups, type TableColumn, type TableDef, type Val,
} from "@hera/config-engine";
import { QueryValueHelp, type QuerySource } from "../ValueHelp.tsx";
import { addRow, pasteRows, removeRow, setCell, type Row } from "./configTableOps.ts";
import { colMinWidth } from "./tableWidths.ts";

const rowIndex = (row: unknown) => Number((row as { rowKey: string }).rowKey.split("-")[1]);

/** Formula results are raw floats; trim the noise without pretending to a currency. */
const show = (v: Val): string =>
  v === null || v === undefined ? "—" : typeof v === "number" ? String(Number(v.toFixed(4))) : String(v);

const header = (c: TableColumn) => c.label + (c.unit ? ` (${c.unit})` : "");

/**
 * The one table component for both roles. An `items` table becomes n quotation lines; a `calc`
 * table only feeds sums into the model's formulas — the difference is entirely in what the server
 * does with the rows, so the editing surface is identical.
 *
 * Controlled, like ConfiguratorForm: rows in, rows out, every computed cell re-derived here rather
 * than stored. The cell controls follow ConfiguratorForm.control()'s branch order so a column and a
 * parameter of the same type look and behave the same.
 */
export function ConfigTable({ def, rows, scopeVars, lookups, onChange, disabled, querySource }: {
  def: TableDef;
  rows: Row[];
  /** the model's current values — row formulas read these, and row cells shadow them */
  scopeVars: Record<string, Val>;
  lookups: ResolvedLookups;
  onChange: (rows: Row[]) => void;
  disabled?: boolean;
  querySource: QuerySource;
}) {
  // Same function the server runs, so the footer cannot disagree with the price.
  const evaluated = useMemo(
    () => evalTableRows(def, rows, scopeVars, lookups.tables),
    [def, rows, scopeVars, lookups],
  );
  // colMinWidth measures positionally, so hand it the grid rather than the keyed rows.
  const grid = useMemo(() => evaluated.map((r) => def.columns.map((c) => r[c.key])), [evaluated, def]);
  const totals = useMemo(() => {
    const out = new Map<string, number>();
    for (const c of def.columns) {
      if (c.type !== "number") continue;
      out.set(c.key, evaluated.reduce((a, r) => a + (typeof r[c.key] === "number" ? (r[c.key] as number) : 0), 0));
    }
    return out;
  }, [evaluated, def]);

  const atMax = def.maxRows !== undefined && rows.length >= def.maxRows;
  const atMin = rows.length <= (def.minRows ?? 0);

  const cell = (ri: number, c: TableColumn) => {
    const stored = rows[ri]?.[c.key];
    const set = (v: Val) => onChange(setCell(rows, ri, c.key, v));

    if (c.cell.kind === "formula") return <Text>{show(evaluated[ri]?.[c.key] ?? null)}</Text>;

    if (c.type === "boolean")
      return (
        <CheckBox checked={stored === true} disabled={disabled} accessibleName={header(c)}
          onChange={(e) => set(e.target.checked)} />
      );

    if (c.cell.kind === "options" && c.cell.ref.source === "query") {
      const ref = c.cell.ref;
      return (
        <QueryValueHelp source={querySource} canonicalTable={lookups.tables[ref.table]} lookupRef={ref}
          value={stored ?? undefined} headerText={header(c)} disabled={disabled}
          onChange={(nv) => set(nv ?? null)} />
      );
    }

    if (c.cell.kind === "options") {
      const opts = columnOptions(c, lookups);
      return (
        <Select style={{ width: "100%" }} disabled={disabled}
          value={stored === undefined || stored === null ? "" : JSON.stringify(stored)}
          onChange={(e) => {
            const j = (e.detail.selectedOption as HTMLElement).dataset.j;
            set(j === undefined || j === "" ? null : (JSON.parse(j) as Val));
          }}>
          <Option value="" data-j="">—</Option>
          {opts.map((o, i) => (
            <Option key={i} value={JSON.stringify(o.value)} data-j={JSON.stringify(o.value)}>{o.label}</Option>
          ))}
        </Select>
      );
    }

    return (
      <Input style={{ width: "100%" }} type={c.type === "number" ? "Number" : "Text"}
        accessibleName={header(c)} value={stored === undefined || stored === null ? "" : String(stored)}
        disabled={disabled}
        onInput={(e) => {
          const raw = e.target.value ?? "";
          set(raw === "" ? null : c.type === "number" ? Number(raw) : raw);
        }} />
    );
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "0.25rem" }}>
      <Toolbar design="Transparent" accessibleName={`${def.title} actions`}>
        <Title level="H5">{def.title}</Title>
        <ToolbarButton icon="add" design="Transparent" text="Add row" disabled={disabled || atMax}
          onClick={() => onChange(addRow(rows))} />
      </Toolbar>
      <div
        onPaste={(e) => {
          const text = e.clipboardData.getData("text");
          // Only a grid becomes new rows; a single value belongs in the cell being pasted into.
          if (!/[\t\n]/.test(text) || disabled) return;
          e.preventDefault();
          onChange(pasteRows(rows, def, text, def.maxRows));
        }}>
        <Table
          // noDataText, not an IllustratedMessage: the illustration needs its own side-effect
          // import to register a loader, and this is a small inline grid, not an empty page.
          noDataText="No rows yet. Add one, or paste a block of cells straight from a spreadsheet."
          rowActionCount={disabled || atMin ? 0 : 1}
          onRowActionClick={(e) => onChange(removeRow(rows, rowIndex(e.detail.row)))}
          headerRow={
            <TableHeaderRow>
              {def.columns.map((c, i) => (
                <TableHeaderCell key={c.key} minWidth={colMinWidth(header(c), grid, i)}>
                  <span>{header(c)}</span>
                </TableHeaderCell>
              ))}
            </TableHeaderRow>
          }>
          {rows.map((_, ri) => (
            <TableRow key={ri} rowKey={`row-${ri}`}
              actions={disabled || atMin ? undefined : <TableRowAction icon="delete" text="Delete" />}>
              {def.columns.map((c) => (
                <TableCell key={c.key}>{cell(ri, c)}</TableCell>
              ))}
            </TableRow>
          ))}
          {/* The totals the model's formulas actually see: <table>_<col>. Shown so a salesperson
              watches the number their routing depends on move as they type, rather than guessing.
              No `actions`, so the delete column stays blank for it. */}
          {rows.length ? (
            <TableRow key="totals" rowKey="totals-0">
              {def.columns.map((c, i) => (
                <TableCell key={c.key}>
                  <Text style={{ fontWeight: "bold" }}>
                    {i === 0 ? `Σ (${aggregateKey(def.key, "count")} = ${rows.length})`
                      : totals.has(c.key) ? `${aggregateKey(def.key, c.key)} = ${show(totals.get(c.key)!)}`
                      : ""}
                  </Text>
                </TableCell>
              ))}
            </TableRow>
          ) : null}
        </Table>
      </div>
    </div>
  );
}
