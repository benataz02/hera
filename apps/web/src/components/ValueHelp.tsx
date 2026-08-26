import { useEffect, useMemo, useRef, useState } from "react";
import { keepPreviousData, useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import {
  Bar, BusyIndicator, Button, Dialog, Icon, Input, SuggestionItem, Table, TableCell, TableGrowing,
  TableHeaderCell, TableHeaderRow, TableRow, TableVirtualizer, Text,
  type TableVirtualizerDomRef,
} from "@ui5/webcomponents-react";
import {
  displayColumns, refKeyCols,
  type DomainOption, type LookupRef, type ModelDef, type ResolvedTable, type Val,
} from "@hera/config-engine";
import { orpc } from "../orpc.ts";
import { resolveEntry } from "./configurator/formHelpers.ts";

// Kill the dialog's default content padding so the table (and its sticky header) sit flush.
// overflow:hidden so only the table scrolls — Dialog::part(content) is overflow:auto by default.
if (typeof document !== "undefined") {
  let el = document.getElementById("hera-vh-style");
  if (!el) { el = document.createElement("style"); el.id = "hera-vh-style"; document.head.appendChild(el); }
  el.textContent = `.hera-vh-dialog::part(content){padding:0;overflow:hidden;}`;
}

/** Remote-search plumbing, shared with EntityValueHelp: pull page 1 on the first open/keystroke,
 *  then one round trip per 250ms pause instead of one per keystroke. */
export function useRemoteSearch(onSearch?: (q: string) => void) {
  const primed = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  return {
    prime: () => {
      if (primed.current || !onSearch) return;
      primed.current = true;
      onSearch("");
    },
    search: (q: string) => {
      primed.current = true;
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => onSearch?.(q), 250);
    },
    cancel: () => {
      if (timer.current) clearTimeout(timer.current);
    },
  };
}

// Fiori-style value help for query-sourced parameters: search across every displayed column,
// click a row to pick it. With `onSearch` the search also runs remotely (the caller refreshes
// `table`); the local filter then just narrows what came back.
export function ValueHelpDialog({
  open, headerText, table, valueCol, columns, hiddenValues, onSelect, onClose,
  onSearch, loading, hasMore, onLoadMore, columnLabels, hidden,
}: {
  open: boolean;
  headerText: string;
  table: ResolvedTable;
  valueCol: string;
  /** extra display columns (without valueCol) */
  columns: string[];
  /** values eliminated by constraints — not offered */
  hiddenValues?: Set<Val>;
  onSelect: (v: Val | undefined, row?: Val[]) => void;
  onClose: () => void;
  /** remote search — debounced; the caller refreshes `table` */
  onSearch?: (q: string) => void;
  loading?: boolean;
  /** another page is available — growing loads it when the table is scrolled to the end */
  hasMore?: boolean;
  onLoadMore?: () => void;
  /** dialog headers; missing/blank → the key */
  columnLabels?: Record<string, string>;
  /** keys omitted from the dialog (and local search). Still on the row for derived values. */
  hidden?: string[];
}) {
  const [q, setQ] = useState("");
  const [range, setRange] = useState({ first: 0, last: 20 });
  const virtRef = useRef<TableVirtualizerDomRef>(null);
  const remote = useRemoteSearch(onSearch);
  const visible = [valueCol, ...columns].filter((c) => !hidden?.includes(c));
  const shown = visible.length ? visible : [valueCol];
  const idx = shown.map((c) => table.columns.indexOf(c));
  const vi = table.columns.indexOf(valueCol);

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return table.rows.filter((r) => {
      if (vi < 0 || (hiddenValues?.has(r[vi] ?? null) ?? false)) return false;
      return !needle || idx.some((i) => i >= 0 && String(r[i] ?? "").toLowerCase().includes(needle));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [table, q, hiddenValues, hidden]);

  useEffect(() => {
    setRange({ first: 0, last: 20 });
    virtRef.current?.reset();
  }, [q]);

  const start = Math.max(0, Math.min(range.first - 2, rows.length));
  const end = Math.min(rows.length, Math.max(start, range.last + 3));

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
      <div style={{ display: "flex", flexDirection: "column", height: "60vh" }}>
        <div style={{ flex: "none", background: "var(--sapGroup_ContentBackground)", padding: "0.5rem" }}>
          <Input icon={<Icon name="search" />} placeholder="Search" value={q} showClearIcon
            onInput={(e) => { const v = e.target.value ?? ""; setQ(v); remote.search(v); }} style={{ width: "100%" }} />
        </div>
        {/* overflowMode=Scroll sets #table { height:100% }. That only clips if the host has a
            definite height — maxHeight is not enough, so the virtualizer's rowCount*rowHeight
            spacer overflowed the Dialog as a second scroller. */}
        <Table noDataText="No matching rows." loading={loading} overflowMode="Scroll"
          style={{ flex: 1, height: "100%", minHeight: 0 }}
          features={[
            <TableVirtualizer key="virt" ref={virtRef} rowCount={rows.length} rowHeight={44}
              onRangeChange={(e) => {
                const { first, last } = e.detail;
                setRange((prev) => (prev.first === first && prev.last === last ? prev : { first, last }));
              }} />,
            hasMore ? <TableGrowing key="grow" mode="Scroll" onLoadMore={() => onLoadMore?.()} /> : undefined,
          ]}
          onRowClick={(e) => {
            const i = Number((e.detail.row as HTMLElement).dataset.idx);
            const r = rows[i];
            if (r && vi >= 0) {
              onSelect(r[vi] ?? null, r);
              onClose();
            }
          }}
          headerRow={
            <TableHeaderRow sticky>
              {shown.map((c) => <TableHeaderCell key={c}><span>{columnLabels?.[c] || c}</span></TableHeaderCell>)}
            </TableHeaderRow>
          }>
          {rows.slice(start, end).map((r, j) => {
            const i = start + j;
            return (
              <TableRow key={i} rowKey={String(i)} position={i} data-idx={String(i)} interactive>
                {idx.map((ci, k) => (
                  <TableCell key={k}><Text>{ci < 0 ? "" : String(r[ci] ?? "")}</Text></TableCell>
                ))}
              </TableRow>
            );
          })}
        </Table>
      </div>
    </Dialog>
  );
}

// The value-help input, usable anywhere: type to filter (or to search remotely via `onSearch`),
// pick from the suggestions, or open the F4 dialog for the full table. The field shows the option's
// **label** — the key only ever travels in `value`/`onChange`. Free text that matches no option is
// rejected on blur/Enter and the field snaps back to the committed option.
export function ValueHelp({
  options, value, onChange, headerText, table, valueCol, columns, onSearch, disabled, readonly,
  placeholder, id, valueState, loading, hasMore, onLoadMore, onOpen, columnLabels, hidden,
}: {
  options: DomainOption[];
  value: Val | undefined;
  onChange: (v: Val | undefined, row?: Val[]) => void;
  /** dialog title */
  headerText: string;
  valueState?: "None" | "Positive" | "Critical" | "Negative" | "Information";
  /** rich dialog source; without it the dialog lists `options` as Value/Description */
  table?: ResolvedTable;
  valueCol?: string;
  columns?: string[];
  /** remote search — debounced here, then the caller refreshes `options`/`table` */
  onSearch?: (q: string) => void;
  disabled?: boolean;
  /** display-only: the field stays focusable and copyable, and the F4 icon is not offered */
  readonly?: boolean;
  placeholder?: string;
  id?: string;
  /** a remote fetch is in flight: the field spins and F4 waits for it instead of opening empty */
  loading?: boolean;
  hasMore?: boolean;
  onLoadMore?: () => void;
  /** query value help resets its outer search before opening; generic value helps keep prime-once */
  onOpen?: () => void;
  columnLabels?: Record<string, string>;
  hidden?: string[];
}) {
  const [typed, setTyped] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  // Remember what we committed: with a remote `onSearch` the picked row drops out of `options` on
  // the next search, and the field must keep showing its label rather than falling back to the key.
  const [picked, setPicked] = useState<{ value: Val; label: string } | null>(null);
  const remote = useRemoteSearch(onSearch);

  const label =
    options.find((o) => o.value === value)?.label ??
    (picked && picked.value === value ? picked.label : undefined) ??
    (value === undefined || value === null ? "" : String(value));
  const shown = typed ?? label;

  // filter="None" on the Input; we filter here so both key and label are searchable.
  const q = (typed ?? "").trim().toLowerCase();
  const items = (loading ? [] : options).filter(
    (o) =>
      !o.eliminatedBy &&
      (!q || !!onSearch || o.label.toLowerCase().includes(q) || String(o.value ?? "").toLowerCase().includes(q)),
  );

  const pick = (v: Val | undefined, row?: Val[], matchedLabel?: string) => {
    setPicked(v === undefined ? null : {
      value: v,
      label: matchedLabel ?? options.find((o) => o.value === v)?.label ?? String(v ?? ""),
    });
    setTyped(null); // snap the field back to the committed label
    onChange(v, row);
  };
  const commit = (raw: string) => {
    const r = resolveEntry(options, raw);
    if (r.kind === "clear") pick(undefined);
    else if (r.kind === "set") {
      const row = table && valueCol ? table.rows[r.index] : [r.value, options[r.index]!.label];
      pick(r.value, row, options[r.index]!.label);
    }
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
  const eliminated = useMemo(
    () => new Set(options.filter((o) => o.eliminatedBy).map((o) => o.value)),
    [options],
  );
  // Nothing to show yet: spin on the field and hold the dialog back until the first page lands.
  const pending = !!loading && !dlg.table.rows.length;

  return (
    <>
      <Input id={id} showSuggestions filter="None" value={shown} placeholder={placeholder ?? "Type or pick…"}
        showClearIcon={!readonly} style={{ width: "100%" }} disabled={disabled} readonly={readonly} valueState={valueState}
        icon={
          readonly ? undefined
            : loading ? <BusyIndicator active delay={0} size="S" />
            : <Icon name="value-help" style={{ cursor: "pointer" }} onClick={() => {
                if (onOpen) { remote.cancel(); onOpen(); }
                else remote.prime();
                setOpen(true);
              }} />
        }
        onInput={(e) => { const t = e.target.value ?? ""; setTyped(t); remote.search(t); }}
        onChange={(e) => commit(e.target.value ?? "")}>
        {items.map((o, i) => (
          <SuggestionItem key={i} text={o.label} additionalText={String(o.value ?? "")} />
        ))}
      </Input>
      {open && !pending ? (
        <ValueHelpDialog open headerText={headerText} table={dlg.table} valueCol={dlg.valueCol} columns={dlg.columns}
          columnLabels={columnLabels} hidden={hidden} hiddenValues={eliminated} onSelect={(v, row) => {
            const i = row ? dlg.table.rows.indexOf(row) : -1;
            pick(v, row, i < 0 ? undefined : options[i]?.label);
          }} onClose={() => setOpen(false)}
          onSearch={onSearch} loading={loading} hasMore={hasMore} onLoadMore={onLoadMore} />
      ) : null}
    </>
  );
}

/** Value help over a model's queryTable. Empty search starts from the canonical lookup page, then
 *  follows its @odata.nextLink on scroll; non-empty search starts a separate remote page chain so a
 *  match past page 1 is still findable. */
/** Which endpoint pages this table. The builder preview edits an *unsaved* draft, so it posts the
 *  raw OData path (admin-only); wizard and portal name a saved model's query table instead, and the
 *  server takes the path from the stored model. */
export type QuerySource = { kind: "draft" } | { kind: "project" | "portal"; modelId: string };

export function QueryValueHelp({
  source, queryTable: qt, canonicalTable, lookupRef, value, onChange, onPick, headerText, disabled, readonly,
}: {
  source: QuerySource;
  queryTable: ModelDef["queryTables"][number] | undefined;
  /** canonical first page already resolved with the form's other lookups */
  canonicalTable?: ResolvedTable;
  lookupRef: LookupRef;
  value: Val | undefined;
  onChange: (v: Val | undefined) => void;
  /** the picked row — searched/off-page rows need adding locally to bind derived values immediately */
  onPick?: (t: ResolvedTable) => void;
  headerText: string;
  disabled?: boolean;
  readonly?: boolean;
}) {
  const [search, setSearch] = useState<string | null>(null); // null = untouched; show canonical data without fetching
  const queryClient = useQueryClient();
  // What the server searches: the ref's key/label columns as the model knows them (a query keeps
  // its columns from Test fetch). The rendered key/label come from the response — see below.
  const pinned = refKeyCols(lookupRef, qt?.columns);
  const searchCols = [pinned.valueCol, pinned.labelCol].filter((c): c is string => !!c);

  // initialData only seeds a new cache entry. Replace the empty-search entry when the canonical
  // lookup refreshes so its rows and nextLink cannot remain stale.
  useEffect(() => {
    if (!canonicalTable || !qt?.path) return;
    const data = { pages: [canonicalTable], pageParams: [undefined as string | undefined] };
    const key = source.kind === "draft"
      ? orpc.models.queryPage.infiniteKey({
          input: () => ({ target: qt.target, path: qt.path, columns: qt.columns, search: "", searchCols }),
          initialPageParam: undefined as string | undefined,
        })
      : (source.kind === "portal" ? orpc.portal.queryPage : orpc.configs.queryPage).infiniteKey({
          input: () => ({ modelId: source.modelId, table: qt.name, cursor: undefined, search: "", searchCols }),
          initialPageParam: undefined as string | undefined,
        });
    let current = true;
    void (async () => {
      await queryClient.cancelQueries({ queryKey: key, exact: true });
      if (current) queryClient.setQueryData(key, data);
    })();
    return () => { current = false; };
  }, [canonicalTable, pinned.labelCol, pinned.valueCol, qt, queryClient, source.kind,
    source.kind === "draft" ? undefined : source.modelId]);

  // The cursor IS the next page's path: B1's nextLink already carries the filter and the skip.
  // The canonical first page is real cache data (including its nextLink), not placeholder data:
  // opening F4 or focusing an empty field cannot refetch page 1, and growing starts at page 2.
  // keepPreviousData matters beyond the flicker: without it a search refetch empties `rows`, which
  // makes ValueHelp's `pending` true and unmounts the open F4 dialog mid-search (losing what the
  // user just typed into it). The table shows its own `loading` state instead.
  const term = (search ?? "").trim();
  const canonical = term === "" ? canonicalTable : undefined;
  const common = {
    initialPageParam: undefined as string | undefined,
    initialData: canonical
      ? { pages: [canonical], pageParams: [undefined as string | undefined] }
      : undefined,
    enabled: !!qt?.path && search !== null,
    retry: false,
    staleTime: canonical ? Infinity : 5 * 60_000,
    placeholderData: keepPreviousData,
  } as const;
  const page = useInfiniteQuery(
    source.kind === "draft"
      ? orpc.models.queryPage.infiniteOptions({
          input: (next: string | undefined) => ({
            target: qt?.target ?? "b1", path: next ?? qt?.path ?? "", columns: qt?.columns,
            ...(next ? {} : { search: term, searchCols }),
          }),
          getNextPageParam: (last) => last.nextLink,
          ...common,
        })
      : (source.kind === "portal" ? orpc.portal.queryPage : orpc.configs.queryPage).infiniteOptions({
          input: (next: string | undefined) => ({
            modelId: source.modelId, table: qt?.name ?? "", cursor: next,
            search: term, searchCols,
          }),
          getNextPageParam: (last) => last.nextLink,
          ...common,
        }),
  );

  const table = useMemo<ResolvedTable>(
    () => ({
      columns: page.data?.pages[0]?.columns ?? qt?.columns ?? [],
      rows: (page.data?.pages ?? []).flatMap((p) => p.rows as Val[][]),
    }),
    [page.data, qt?.columns],
  );
  // Columns come back with the page when the query has none pinned, so resolve key/label against
  // what we actually got.
  const { valueCol, labelCol } = refKeyCols(lookupRef, table.columns);
  const options = useMemo<DomainOption[]>(() => {
    const vi = table.columns.indexOf(valueCol);
    const li = labelCol ? table.columns.indexOf(labelCol) : vi;
    return vi < 0 ? [] : table.rows.map((r) => ({ value: r[vi] ?? null, label: String(r[li < 0 ? vi : li] ?? "") }));
  }, [table, valueCol, labelCol]);

  return (
    <ValueHelp options={options} value={value} headerText={headerText}
      onChange={(nv, row) => {
        if (row) onPick?.({ columns: table.columns, rows: [row] });
        onChange(nv);
      }}
      disabled={disabled} readonly={readonly} valueState={page.error ? "Negative" : undefined}
      table={table} valueCol={valueCol} columns={displayColumns(lookupRef, table.columns)}
      columnLabels={qt?.labels} hidden={qt?.hidden}
      onSearch={setSearch} onOpen={() => setSearch("")}
      // Asked and nothing back yet, or a search refetch — but never on a failure, or the field
      // would spin forever and the dialog never open (retry is off; the error shows as valueState).
      loading={search !== null && !page.isError && (!page.data || (page.isFetching && !page.isFetchingNextPage))}
      hasMore={page.hasNextPage && !page.isFetchingNextPage}
      onLoadMore={() => { if (!page.isFetchingNextPage) void page.fetchNextPage(); }} />
  );
}
