import { useEffect, useState } from "react";
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
import { useRemoteSearch } from "./ValueHelp.tsx";

export type ValueHelpRow = { key: string; label: string; defaults?: Record<string, unknown> };

/**
 * Resolve a stored lookup key into its description. Records hold only the key, and callers pass
 * that raw key as the committed label until a pick happens, so an exact-key query on mount is what
 * turns "C20000" into "Maxi Teq" — in display mode as well as edit.
 * Pass `value: undefined` to opt out (tables do — see EntityField's `resolveLabel`).
 * ponytail: one query per resolving field per record; batch in `entities.get` if that grows.
 */
export function useLookupLabel(
  value: string | undefined,
  committed: string | undefined,
  rows: ValueHelpRow[],
  onSearch?: (q: string) => void,
): string | undefined {
  const uncommitted = !committed || committed === value;
  const [resolved, setResolved] = useState<string | null>(null);

  useEffect(() => {
    if (value && uncommitted) onSearch?.(value);
  }, []);

  useEffect(() => {
    if (resolved || !value) return;
    const hit = rows.find((r) => r.key === value);
    if (hit?.label && hit.label !== hit.key) setResolved(hit.label);
  }, [rows, value, resolved]);

  return uncommitted ? (resolved ?? undefined) : committed;
}

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
  // Metadata only names the target entity — `prime` pulls page 1 on first focus/open so there is
  // something to pick before the user types; `search` debounces the rest.
  const { prime, search } = useRemoteSearch(onSearch);

  // `label` is already resolved by the caller (see useLookupLabel).
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
