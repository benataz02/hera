import { useMemo, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { keepPreviousData, useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { BusyIndicator, IllustratedMessage, MessageStrip, Toolbar, ToolbarButton } from "@ui5/webcomponents-react";
import "@ui5/webcomponents-fiori/dist/illustrations/NoEntries.js";
import { client, orpc } from "../../orpc.ts";
import { listQuery, useListSpec, type ListColumn } from "../../variants.ts";
import { ListReport } from "../ListReport.tsx";
import { PrintActions } from "./PrintActions.tsx";

// Any B1 entity set as a list report. The saved view IS the query: the server compiles the same
// ListVariantDef into OData, so a variant behaves here exactly as it does on a local list.
// The columns come from the cached $metadata — nothing about the entity is hand-written.

const noData = () => (
  <IllustratedMessage name="NoEntries" design="Auto" titleText="No rows"
    subtitleText="Nothing in SAP matches this view." />
);

// `scope` is the only thing that differs between the internal and the portal mounts: which
// procedures answer, which variant namespace the saved view lives in, and where a row click goes.
// The server fences the portal set independently — this is which page you are on, not permission.
export function EntityListPage({ entity, scope = "internal" }: { entity: string; scope?: "internal" | "portal" }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [refreshing, setRefreshing] = useState(false);
  const portal = scope === "portal";
  const schema = useQuery({
    ...(portal
      ? orpc.portal.docs.schema.queryOptions({ input: { entity } })
      : orpc.entities.schema.queryOptions({ input: { entity } })),
    retry: false,
    staleTime: 60 * 60_000,
  });
  const listSpec = useListSpec(portal ? `portal:${entity}` : `b1:${entity}`);

  const columns = useMemo<ListColumn[]>(
    () =>
      (schema.data?.fields ?? [])
        .filter((f) => f.kind !== "collection")
        .map((f) => ({
          name: f.name,
          // The column's *behaviour* type: BoYesNoEnum is edmType "SAPB1.BoYesNoEnum", which the
          // filter bar's `/bool/i` test would miss and render as a text input.
          type: f.kind === "boolean" ? "Edm.Boolean" : f.edmType,
          label: f.label ?? f.name,
          ...(f.options ? { options: f.options.map((o) => ({ value: o.value, text: o.label })) } : {}),
        })),
    [schema.data],
  );

  // Two things worth knowing about this input:
  //  - listQuery, not the spec itself: widths and labels live in the same document and the whole
  //    document is the infinite-query key, so sending them raw made a column resize refetch page 1.
  //  - the cursor is B1's own @odata.nextLink, sealed server-side. The browser never computes an
  //    offset and never sees a Service Layer URL; page size is B1_PAGE_SIZE, not ours to pick.
  const pageInput = (cursor: string | undefined) =>
    ({ entity, spec: listQuery(listSpec.spec), ...(cursor ? { cursor } : { count: true }) });
  const rowsOptions = portal
    ? orpc.portal.docs.rows.infiniteOptions({
        input: pageInput,
        initialPageParam: undefined as string | undefined,
        getNextPageParam: (last) => last.nextCursor,
      })
    : orpc.entities.rows.infiniteOptions({
        input: pageInput,
        initialPageParam: undefined as string | undefined,
        getNextPageParam: (last) => last.nextCursor,
      });

  const page = useInfiniteQuery({
    ...rowsOptions,
    // Both gates matter: no schema means no column names to compile against, and an unapplied
    // view would fire one render's worth of requests carrying the previous entity's fields.
    enabled: !!schema.data && listSpec.ready,
    retry: false,
    placeholderData: keepPreviousData,
  });

  const rows = useMemo(() => (page.data?.pages ?? []).flatMap((p) => p.rows), [page.data]);
  const keyField = schema.data?.keys[0] ?? "";

  if (schema.isPending) return <BusyIndicator active delay={0} />;
  if (schema.error) return <MessageStrip design="Negative" hideCloseButton>{schema.error.message}</MessageStrip>;

  return (
    <ListReport
      listSpec={listSpec}
      title={schema.data!.label}
      columns={columns}
      keyField={keyField}
      rows={rows}
      total={page.data?.pages[0]?.total ?? rows.length}
      loading={page.isFetching && !page.isFetchingNextPage}
      error={page.error}
      hasMore={page.hasNextPage}
      onLoadMore={() => { if (!page.isFetchingNextPage) void page.fetchNextPage(); }}
      selectionActions={(rows) =>
        rows.length === 1 ? <PrintActions entity={entity} docEntry={Number(rows[0]!.DocEntry)} scope={scope} /> : null
      }
      onRowClick={(row) => {
        const keys = schema.data!.keys;
        // A composite key travels as JSON so one route param can carry both halves.
        const key = keys.length === 1 ? String(row[keys[0]!] ?? "") : JSON.stringify(Object.fromEntries(keys.map((k) => [k, row[k]])));
        if (!key) return;
        if (portal) navigate({ to: "/portal/docs/$entity/$key", params: { entity, key } });
        else navigate({ to: "/b1/$entity/$key", params: { entity, key } });
      }}
      noData={noData}
      actions={
        portal ? undefined : (
          <Toolbar design="Transparent">
            {/* refetch() alone would return the same cached row — the re-read has to be asked for. */}
            <ToolbarButton icon="refresh" text="Refresh schema" disabled={refreshing}
              onClick={async () => {
                setRefreshing(true);
                try {
                  const fresh = await client.entities.schema({ entity, refresh: true });
                  qc.setQueryData(orpc.entities.schema.key({ input: { entity }, type: "query" }), fresh);
                } finally { setRefreshing(false); }
              }} />
          </Toolbar>
        )
      }
    />
  );
}
