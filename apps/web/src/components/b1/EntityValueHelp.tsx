import { useMemo, useState } from "react";
import { keepPreviousData, useInfiniteQuery } from "@tanstack/react-query";
import type { DomainOption, ResolvedTable, Val } from "@hera/config-engine";
import { orpc } from "../../orpc.ts";
import { ValueHelp } from "../ValueHelp.tsx";

// A field whose ReferentialConstraint points at another entity set becomes a value help over it.
// The dialog, the 250 ms debounce and the infinite paging are ValueHelp's, unchanged — this only
// turns entities.rows pages into the {options, table} shape it already speaks.

const EMPTY = { select: [], filter: [], orderby: [], filterBar: [] };

export function EntityValueHelp({
  entitySet, keyField, value, onChange, headerText, disabled, readonly,
}: {
  entitySet: string;
  keyField: string;
  value: Val | undefined;
  onChange: (v: Val | undefined) => void;
  headerText: string;
  disabled?: boolean;
  readonly?: boolean;
}) {
  const [search, setSearch] = useState<string | null>(null); // null = untouched: don't fetch yet

  const page = useInfiniteQuery(
    orpc.entities.rows.infiniteOptions({
      input: (skip: number | undefined) => ({
        entity: entitySet,
        spec: { ...EMPTY, search: (search ?? "").trim() },
        top: 50,
        ...(skip ? { skip } : {}),
      }),
      initialPageParam: undefined as number | undefined,
      getNextPageParam: (last) => last.nextSkip,
      enabled: search !== null,
      retry: false,
      placeholderData: keepPreviousData,
      staleTime: 5 * 60_000,
    }),
  );

  const rows = useMemo(() => (page.data?.pages ?? []).flatMap((p) => p.rows), [page.data]);
  // Show the key plus whatever the first row's other scalar fields are — B1's own column order.
  const columns = useMemo(() => {
    const first = rows[0];
    if (!first) return [keyField];
    const rest = Object.keys(first).filter((k) => k !== keyField && /^[A-Za-z_][A-Za-z0-9_]*$/.test(k));
    return [keyField, ...rest.slice(0, 4)];
  }, [rows, keyField]);

  const table = useMemo<ResolvedTable>(
    () => ({
      columns,
      rows: rows.map((r) => columns.map((c) => (r as Record<string, unknown>)[c] as Val)),
    }),
    [rows, columns],
  );

  const options = useMemo<DomainOption[]>(
    () => table.rows.map((r) => ({ value: r[0] ?? null, label: String(r[1] ?? r[0] ?? "") })),
    [table],
  );

  return (
    <ValueHelp
      options={options} value={value} onChange={onChange} headerText={headerText}
      table={table} valueCol={columns[0]!} columns={columns.slice(1)}
      onSearch={setSearch} onOpen={() => setSearch("")}
      disabled={disabled} readonly={readonly}
      valueState={page.error ? "Negative" : undefined}
      loading={search !== null && !page.isError && (!page.data || (page.isFetching && !page.isFetchingNextPage))}
      hasMore={page.hasNextPage && !page.isFetchingNextPage}
      onLoadMore={() => { if (!page.isFetchingNextPage) void page.fetchNextPage(); }}
    />
  );
}
