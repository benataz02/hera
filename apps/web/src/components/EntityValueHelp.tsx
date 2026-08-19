import { useEffect, useRef, useState } from "react";
import {
  Bar,
  Button,
  Dialog,
  Icon,
  Input,
  SuggestionItem,
  Table,
  TableCell,
  TableHeaderCell,
  TableHeaderRow,
  TableRow,
  Text,
} from "@ui5/webcomponents-react";

export type ValueHelpRow = { key: string; label: string; defaults?: Record<string, unknown> };

// Kill dialog content padding so the table sits flush (same as configurator ValueHelp).
if (typeof document !== "undefined" && !document.getElementById("hera-evh-style")) {
  const el = document.createElement("style");
  el.id = "hera-evh-style";
  el.textContent = `.hera-evh-dialog::part(content){padding:0;}`;
  document.head.appendChild(el);
}

/**
 * Validated entity value help: controlled key + label, remote search, explicit pick only.
 * Typed text never becomes the key unless it matches a returned row.
 */
export function EntityValueHelp({
  value,
  label,
  rows,
  onSearch,
  onChange,
  headerText,
  disabled,
  readonly,
  placeholder,
  id,
  valueState,
}: {
  value: string | undefined;
  /** Committed display label for `value` (kept when the row drops out of `rows`). */
  label: string;
  rows: ValueHelpRow[];
  onSearch?: (q: string) => void;
  onChange: (next: { key: string; label: string; defaults?: Record<string, unknown> } | undefined) => void;
  headerText: string;
  disabled?: boolean;
  readonly?: boolean;
  placeholder?: string;
  id?: string;
  valueState?: "None" | "Positive" | "Critical" | "Negative" | "Information";
}) {
  const [typed, setTyped] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const primed = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Metadata only names the target entity — pull page 1 on first focus/open so there is
  // something to pick before the user types.
  const prime = () => {
    if (primed.current || !onSearch) return;
    primed.current = true;
    onSearch("");
  };

  // ponytail: 250ms debounce — one agent→SAP round-trip per pause, not per keystroke.
  const search = (q: string) => {
    primed.current = true;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => onSearch?.(q), 250);
  };

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  const shown = typed ?? (value ? label || value : "");

  const pick = (row: ValueHelpRow | undefined) => {
    setTyped(null);
    if (!row) onChange(undefined);
    else onChange({ key: row.key, label: row.label, defaults: row.defaults });
  };

  /** Reject free-text keys: only exact key/label match against current rows, or clear. */
  const commit = (raw: string) => {
    const t = raw.trim();
    if (!t) {
      pick(undefined);
      return;
    }
    const hit =
      rows.find((r) => r.key === t) ??
      rows.find((r) => r.label.toLowerCase() === t.toLowerCase());
    if (hit) pick(hit);
    else setTyped(null); // snap back to committed label
  };

  return (
    <>
      <Input
        id={id}
        showSuggestions
        filter="None"
        value={shown}
        placeholder={placeholder ?? "Type or pick…"}
        showClearIcon={!readonly}
        style={{ width: "100%" }}
        disabled={disabled}
        readonly={readonly}
        valueState={valueState}
        icon={
          readonly ? undefined : (
            <Icon
              name="value-help"
              style={{ cursor: "pointer" }}
              onClick={() => {
                prime();
                setOpen(true);
              }}
            />
          )
        }
        onFocus={prime}
        onInput={(e) => {
          const t = e.target.value ?? "";
          setTyped(t);
          search(t);
        }}
        onChange={(e) => commit(e.target.value ?? "")}
      >
        {rows.map((r) => (
          <SuggestionItem key={r.key} text={r.label} additionalText={r.key} />
        ))}
      </Input>
      {open ? (
        <Dialog
          open
          headerText={headerText}
          onClose={() => setOpen(false)}
          className="hera-evh-dialog"
          style={{ width: "min(52rem, 95vw)" }}
          footer={
            <Bar
              design="Footer"
              endContent={
                <>
                  <Button
                    onClick={() => {
                      pick(undefined);
                      setOpen(false);
                    }}
                  >
                    Clear
                  </Button>
                  <Button onClick={() => setOpen(false)}>Cancel</Button>
                </>
              }
            />
          }
        >
          <div style={{ display: "flex", flexDirection: "column" }}>
            <div
              style={{
                position: "sticky",
                top: 0,
                zIndex: 2,
                background: "var(--sapGroup_ContentBackground)",
                padding: "0.5rem",
              }}
            >
              <Input
                icon={<Icon name="search" />}
                placeholder="Search"
                value={typed ?? ""}
                showClearIcon
                onInput={(e) => {
                  const t = e.target.value ?? "";
                  setTyped(t);
                  search(t);
                }}
                style={{ width: "100%" }}
              />
            </div>
            <div style={{ overflowY: "auto", maxHeight: "60vh" }}>
              <Table
                noDataText="No matching rows."
                onRowClick={(e) => {
                  const i = Number((e.detail.row as HTMLElement).dataset.idx);
                  const r = rows[i];
                  if (r) {
                    pick(r);
                    setOpen(false);
                  }
                }}
                headerRow={
                  <TableHeaderRow sticky>
                    <TableHeaderCell>
                      <span>Value</span>
                    </TableHeaderCell>
                    <TableHeaderCell>
                      <span>Description</span>
                    </TableHeaderCell>
                  </TableHeaderRow>
                }
              >
                {rows.map((r, i) => (
                  <TableRow key={r.key} rowKey={r.key} data-idx={String(i)} interactive>
                    <TableCell>
                      <Text>{r.key}</Text>
                    </TableCell>
                    <TableCell>
                      <Text>{r.label}</Text>
                    </TableCell>
                  </TableRow>
                ))}
              </Table>
            </div>
          </div>
        </Dialog>
      ) : null}
    </>
  );
}
