# History pane: exact doc history + similar configurations

The process page's right-hand pane (`HistoryPane.tsx`) has two tabs, each a separate feature with
its own data path. Both are optional per model — configured in the model builder's History tab
(`HistoryTab.tsx`).

## Tab 1 — "Customer & item history" (exact help)

Shows the live Orders/Quotations in SAP B1 for the project's customer and/or the current
`itemCode` parameter, fetched on demand — nothing cached, nothing synced.

```
HistoryPane.tsx (DocHistory)
  → orpc.configs.docHistory { id: projectId, itemCode }
    → apps/server/orpc/routers/configs.ts: fetchDocHistory
      → tenantConnector(tenantId)                          // the tenant's on-prem agent
      → b1.crossJoin(docHistoryQuery("Orders" | "Quotations", ...))  × 2, in parallel
        → packages/b1 RemoteTransport → POST <agentUrl>/b1/cross-join
        → apps/agent → DirectTransport → crossJoinPath() → GET the Service Layer
      → doc-history.ts: flattenDocs() + sortDocRows()
```

`docHistoryQuery()` (`apps/server/src/doc-history.ts`) returns a `CrossJoinSpec` — data, not a URL.
`packages/b1/src/query.ts` is the only module that turns one into a path:

```
$crossjoin(Orders,Orders/DocumentLines)
  ?$expand=Orders($select=DocNum,DocDate,CardCode,CardName),
           Orders/DocumentLines($select=ItemCode,ItemDescription,Quantity,UnitPrice)
  &$filter=Orders/DocEntry eq Orders/DocumentLines/DocEntry
           and (Orders/CardCode eq '...' or Orders/DocumentLines/ItemCode eq '...')
  &$orderby=Orders/DocDate desc&$top=10
```

The `DocEntry` equality **is** the join. Without it the crossjoin pairs every document with every
line in the company. Both criteria are OR'd into one request; `flattenDocs` then tags each
resulting line `"both" | "customer" | "item"` depending on which side matched, and `sortDocRows`
puts `"both"` matches first, then newest first.

Config surface (`HistoryTab.tsx`, "Exact help" section): pick which model parameter holds the SAP
item code. The customer always comes from the project itself — no parameter needed for that side.

## Tab 2 — "Similar configurations" (fuzzy help)

Ranks a **cached** table of historic rows against the parameters the user has filled in so far, so
it works without hitting B1 on every keystroke.

```
HistoryTab.tsx: admin defines a history query (entity set + optional filter) + column list
  → "Sync now" → orpc.models.syncHistory → history-sync.ts: syncModelHistory()
    → fetchQueryTable(run, target, query, columns, { maxPages: HISTORY_MAX_PAGES })
      — a capped @odata.nextLink walk; the bound is stated at the call site because
        packages/b1 has no readAll to hide it in
    → delete+insert wholesale into config_history (source of truth = the query; no merge)

HistoryPane.tsx (Similar), debounced 500ms on entries
  → orpc.configs.similar { id: projectId, entries }
    → history-sync.ts: loadHistoryRows() — 5 min in-process cache, invalidated on every sync
    → similarity.ts: scoreRows(history, entries, rows)
```

Scoring (`similarity.ts`) is a plain weighted average, no ranking service:
`score = Σ(weight × match) / Σ(weight of params the user actually filled)`, per mapping:
- `exact` — normalized string equality
- `contains` — case/whitespace-insensitive substring
- `closeness` — numeric, normalized against the observed min/max of that column in the cached data

Config surface (`HistoryTab.tsx`, "Similarity help" section): the query itself, a
param↔column mapping per row (with match type + weight), and which columns to show on each result
card. "Sync now" is disabled while the model has unsaved changes, since sync runs the *saved* query.

## Why a `$crossjoin` and not `$expand`

B1's `$filter` parser has no lambda operators, so a document cannot be filtered by its lines
directly. All three attempts were verified against `b1s/v2` and all three return 400:

| Attempt | B1's answer |
| --- | --- |
| `DocumentLines/any(d: d/ItemCode eq 'X')` | "Invalid symbol in the filter condition" |
| `DocumentLines/ItemCode eq 'X'` | "Property 'DocumentLines/ItemCode' is invalid" |
| `$expand=DocumentLines(...)` | not a navigation property — it is a complex collection |

`$crossjoin` is the way in, and it is a plain GET: no `QueryService_PostQuery`, no `text/plain`
response to parse. It returns one flat `{Orders, Orders/DocumentLines}` pair per line, which is
already `DocRow`'s grain — so `flattenDocs` reads it directly.

`$top` therefore counts (document, line) pairs rather than documents. That is fine: the pane lists
rows, not documents.
