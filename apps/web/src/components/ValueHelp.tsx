import { useMemo, useState } from "react";
import {
  Bar, Button, Dialog, Icon, Input, SuggestionItem, Table, TableCell, TableHeaderCell, TableHeaderRow,
  TableRow, Text,
} from "@ui5/webcomponents-react";
import type { DomainOption, ResolvedTable, Val } from "@hera/config-engine";
import { resolveEntry } from "./configurator/formHelpers.ts";

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

// The value-help input, usable anywhere: type to filter (or to search remotely via `onSearch`),
// pick from the suggestions, or open the F4 dialog for the full table. The field shows the option's
// **label** — the key only ever travels in `value`/`onChange`. Free text that matches no option is
// rejected on blur/Enter and the field snaps back to the committed option.
export function ValueHelp({
  options, value, onChange, headerText, table, valueCol, columns, onSearch, disabled, readonly, placeholder, id, valueState,
}: {
  options: DomainOption[];
  value: Val | undefined;
  onChange: (v: Val | undefined) => void;
  /** dialog title */
  headerText: string;
  valueState?: "None" | "Positive" | "Critical" | "Negative" | "Information";
  /** rich dialog source; without it the dialog lists `options` as Value/Description */
  table?: ResolvedTable;
  valueCol?: string;
  columns?: string[];
  /** remote search — called with the typed text; the caller refreshes `options` and we skip local filtering */
  onSearch?: (q: string) => void;
  disabled?: boolean;
  /** display-only: the field stays focusable and copyable, and the F4 icon is not offered */
  readonly?: boolean;
  placeholder?: string;
  id?: string;
}) {
  const [typed, setTyped] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  // Remember what we committed: with a remote `onSearch` the picked row drops out of `options` on
  // the next search, and the field must keep showing its label rather than falling back to the key.
  const [picked, setPicked] = useState<{ value: Val; label: string } | null>(null);

  const label =
    options.find((o) => o.value === value)?.label ??
    (picked && picked.value === value ? picked.label : undefined) ??
    (value === undefined || value === null ? "" : String(value));
  const shown = typed ?? label;

  // filter="None" on the Input; we filter here so both key and label are searchable.
  const q = (typed ?? "").trim().toLowerCase();
  const items = options.filter(
    (o) =>
      !o.eliminatedBy &&
      (!q || !!onSearch || o.label.toLowerCase().includes(q) || String(o.value ?? "").toLowerCase().includes(q)),
  );

  const pick = (v: Val | undefined) => {
    setPicked(v === undefined ? null : { value: v, label: options.find((o) => o.value === v)?.label ?? String(v ?? "") });
    setTyped(null); // snap the field back to the committed label
    onChange(v);
  };
  const commit = (raw: string) => {
    const r = resolveEntry(options, raw);
    if (r.kind === "clear") pick(undefined);
    else if (r.kind === "set") pick(r.value);
    else setTyped(null); // reject: keep the last committed value
  };

  const dlg = useMemo(
    () =>
      table && valueCol
        ? { table, valueCol, columns: columns ?? [] }
        : {
            table: { columns: ["Value", "Description"], rows: options.map((o) => [o.value, o.label]) },
            valueCol: "Value",
            columns: ["Description"],
          },
    [table, valueCol, columns, options],
  );
  const hidden = useMemo(
    () => new Set(options.filter((o) => o.eliminatedBy).map((o) => o.value)),
    [options],
  );

  return (
    <>
      <Input id={id} showSuggestions filter="None" value={shown} placeholder={placeholder ?? "Type or pick…"}
        showClearIcon={!readonly} style={{ width: "100%" }} disabled={disabled} readonly={readonly} valueState={valueState}
        icon={readonly ? undefined : <Icon name="value-help" style={{ cursor: "pointer" }} onClick={() => setOpen(true)} />}
        onInput={(e) => { const t = e.target.value ?? ""; setTyped(t); onSearch?.(t); }}
        onChange={(e) => commit(e.target.value ?? "")}>
        {items.map((o, i) => (
          <SuggestionItem key={i} text={o.label} additionalText={String(o.value ?? "")} />
        ))}
      </Input>
      {open ? (
        <ValueHelpDialog open headerText={headerText} table={dlg.table} valueCol={dlg.valueCol} columns={dlg.columns}
          hiddenValues={hidden} onSelect={pick} onClose={() => setOpen(false)} />
      ) : null}
    </>
  );
}
