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
    → apps/server/orpc/routers/configs.ts: docHistory handler
      → assertAgentReady(tenantId)                         // agent must be online
      → runRequest(tenantId, "query", { target: "b1", path: docHistoryPath(...) })  × 2 (Orders, Quotations)
        → apps/server/orpc/routers/entities.ts: runRequest
          inserts an agentRequest row, pg_notify's the agent, parks on LISTEN/NOTIFY
          for the reply (same doorbell machinery the quote sync backbone uses)
        → apps/agent/src/sync.ts: case "query" → sl.queryRaw(path)   // raw GET, path passed verbatim
      → doc-history.ts: flattenDocs() + sortDocRows()
```

`docHistoryPath()` (`apps/server/src/doc-history.ts`) builds one OData query per entity:

```
/Orders?$select=DocNum,DocDate,CardCode,CardName
       &$expand=DocumentLines($select=ItemCode,ItemDescription,Quantity,UnitPrice)
       &$filter=CardCode eq '...' or DocumentLines/any(d: d/ItemCode eq '...')
       &$orderby=DocDate desc&$top=10
```

Both criteria are OR'd into one request; `flattenDocs` then tags each resulting line
`"both" | "customer" | "item"` depending on which side matched, and `sortDocRows` puts `"both"`
matches first, then newest first.

Config surface (`HistoryTab.tsx`, "Exact help" section): pick which model parameter holds the SAP
item code. The customer always comes from the project itself — no parameter needed for that side.

## Tab 2 — "Similar configurations" (fuzzy help)

Ranks a **cached** table of historic rows against the parameters the user has filled in so far, so
it works without hitting B1 on every keystroke.

```
HistoryTab.tsx: admin defines a history query (B1 SQLQuery path or Beas path) + column list
  → "Sync now" → orpc.models.syncHistory → history-sync.ts: syncModelHistory()
    → fetchQueryTable(target, path, columns) via the agent, same runRequest/query channel
    → delete+insert wholesale into config_history (source of truth = the query; no merge)
  → also runs automatically every hour for every model that has a history query (startHistorySync)

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

## The `B1 400 code 201: Cannot expand invalid navigation property 'DocumentLines' for entity type 'Document'` error

This is the exact-help tab (Tab 1) only — the similarity tab never touches `$expand`.

**Cause:** `$expand` on a *collection* navigation property (like `DocumentLines` on an
`Orders`/`Quotations` document) is only supported from **SAP B1 10.0 FP2105** onward. On an older
patch level, Service Layer rejects it outright — this is a B1 patch-level limitation, not a bug in
the request. `doc-history.ts` already carries a comment flagging this exact possibility:

```ts
// OData: b1s/v2 (v4) lambda — DocumentLines/any(). If a B1 patch level rejects it, swap
// docHistoryPath's item clause for a $crossjoin (see sap-b1-service-layer skill) — callers
// only see the path string.
```

That comment focused on the `$filter` lambda (`DocumentLines/any(...)`), but the same version gate
also covers the plain `$expand=DocumentLines(...)` clause — which is what's actually failing here,
independent of the filter.

**How to configure/fix it**, in order of preference:

1. **Check the B1 patch level** (`Help → About` in the B1 client, or ask whoever administers the
   sandbox). If it's below 10.0 FP2105, upgrading resolves this with no code change.
2. **If upgrading isn't an option**, the code needs to stop expanding a collection nav property.
   Two ways, both keep `flattenDocs`'s external contract (`DocumentLines` array per doc) if done
   right:
   - **Two-step fetch**: query `Orders`/`Quotations` with `$select` only (no `$expand`), then for
     each matched `DocEntry`, `GET /Orders(DocEntry)/DocumentLines?$select=...` separately. Works
     on every patch level since it's a plain nav-property GET, not a collection expand — but adds
     up to N extra agent round-trips per search (bounded by `$top=10` × 2 entities).
   - **Row-level filtering via `QueryService_PostQuery`** (supported from PL11, much older):
     `POST /QueryService_PostQuery` with
     `QueryPath: "$crossjoin(Orders,Orders/DocumentLines)"` and a `$filter` joining
     `DocEntry`. One request, but the response is `text/plain` and needs its own parsing — see
     `references/advanced-queries.md` in the `sap-b1-service-layer` skill for the exact shape.

Until one of those lands, this tab will 400 on any B1 sandbox below FP2105 — the error message
itself is now surfaced correctly to the browser (see the in-flight `service-layer-client.ts`
change reworking `toError`/`parseSlError`); previously it would have collapsed to a generic
"Bad Request" with the real cause discarded.
