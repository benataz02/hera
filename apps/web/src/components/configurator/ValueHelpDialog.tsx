import { useMemo, useState } from "react";
import {
  Bar, Button, Dialog, Icon, Input, Table, TableCell, TableHeaderCell, TableHeaderRow, TableRow, Text,
} from "@ui5/webcomponents-react";
import type { ResolvedTable, Val } from "@hera/config-engine";

// Kill the dialog's default content padding so the table (and its sticky header) sit flush.
if (typeof document !== "undefined" && !document.getElementById("hera-vh-style")) {
  const el = document.createElement("style");
  el.id = "hera-vh-style";
  el.textContent = `.hera-vh-dialog::part(content){padding:0;}`;
  document.head.appendChild(el);
}

// Fiori-style value help for query-sourced parameters: search across every displayed column,
// click a row to pick it. ponytail: client-side filter over already-resolved rows; move the
// search server-side if a query ever returns thousands of rows.
export function ValueHelpDialog({ open, headerText, table, valueCol, columns, hiddenValues, onSelect, onClose }: {
  open: boolean;
  headerText: string;
  table: ResolvedTable;
  valueCol: string;
  /** extra display columns (without valueCol) */
  columns: string[];
  /** values eliminated by constraints — not offered */
  hiddenValues?: Set<Val>;
  onSelect: (v: Val | undefined) => void;
  onClose: () => void;
}) {
  const [q, setQ] = useState("");
  const shown = [valueCol, ...columns];
  const idx = shown.map((c) => table.columns.indexOf(c));
  const vi = table.columns.indexOf(valueCol);

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return table.rows.filter((r) => {
      if (vi < 0 || (hiddenValues?.has(r[vi] ?? null) ?? false)) return false;
      return !needle || idx.some((i) => i >= 0 && String(r[i] ?? "").toLowerCase().includes(needle));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [table, q, hiddenValues]);

  return (
    <Dialog open={open} headerText={headerText} onClose={onClose} className="hera-vh-dialog"
      style={{ width: "min(52rem, 95vw)" }}
      footer={
        <Bar design="Footer" endContent={
          <>
            <Button onClick={() => { onSelect(undefined); onClose(); }}>Clear</Button>
            <Button onClick={onClose}>Cancel</Button>
          </>
        } />
      }>
      <div style={{ display: "flex", flexDirection: "column" }}>
        <div style={{ position: "sticky", top: 0, zIndex: 2, background: "var(--sapGroup_ContentBackground)", padding: "0.5rem" }}>
          <Input icon={<Icon name="search" />} placeholder="Search" value={q} showClearIcon
            onInput={(e) => setQ(e.target.value ?? "")} style={{ width: "100%" }} />
        </div>
        {/* Table scrolls in its own region so its sticky column header pins below the search
            instead of fighting it for top:0. */}
        <div style={{ overflowY: "auto", maxHeight: "60vh" }}>
        <Table noDataText="No matching rows."
          onRowClick={(e) => {
            const i = Number((e.detail.row as HTMLElement).dataset.idx);
            const r = rows[i];
            if (r && vi >= 0) {
              onSelect(r[vi] ?? null);
              onClose();
            }
          }}
          headerRow={
            <TableHeaderRow sticky>
              {shown.map((c) => <TableHeaderCell key={c}><span>{c}</span></TableHeaderCell>)}
            </TableHeaderRow>
          }>
          {rows.map((r, i) => (
            <TableRow key={i} rowKey={String(i)} data-idx={String(i)} interactive>
              {idx.map((ci, j) => (
                <TableCell key={j}><Text>{ci < 0 ? "" : String(r[ci] ?? "")}</Text></TableCell>
              ))}
            </TableRow>
          ))}
        </Table>
        </div>
      </div>
    </Dialog>
  );
}
