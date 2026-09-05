# Client portal: projects, document follow-up, and PDF preview/download

## Context

The B2B portal shipped in July (`docs/superpowers/specs/2026-07-07-b2b-portal-design.md`) deliberately
stopped at the quote request: *"No DocNum, no PDF, no cost breakdown"* (`portal.ts:348`). A client can
configure a product, submit it, and see indicative prices — and then the trail goes cold. Everything
that happens afterwards in SAP (the real quotation, the order, the delivery, the invoice) is invisible
to the customer who is waiting for it.

This change turns the portal from a request inbox into a **follow-up workspace**:

- a project page whose timeline merges HERA milestones with the live SAP document chain,
- four read-only document lists in the nav (quotations, orders, deliveries, invoices), scoped to the
  client's business partner,
- PDF preview/download on every document, via the SAP Business One **API Gateway** Reporting Service,
- the same preview/download for internal users on `ListReport` and `EntityObjectPage`,
- and a client↔business-partner binding that is validated against B1 instead of typed by hand.

**Verified during planning:** the API Gateway is live at `https://localhost:60020` —
`GET /rs/v1/LoadAuthorizedCRList` answers `401` unauthenticated, `60000` refuses. `agent.json`
already carries an `apiGateway` block (companyDb/user/pass) that **no code reads**; it needs a `url`
and a `layouts` map.

## Decisions taken

| Axis | Decision |
|---|---|
| Configure wizard | **Unchanged.** `/portal/new` catalog + the 4-step Wizard stay exactly as they are. |
| Timeline (HERA half) | **Milestones only** — `config_project.events` as it stands. No new event kinds, no schema change. |
| Print layouts | **Explicit per-customer map** in `agent.json` → `apiGateway.layouts`. No `LoadAuthorizedCRList` discovery. |
| Internal buttons | Count bar in `ListReport`, enabled on exactly one selected row. |
| Nav | 5 client items. "New request" leaves the nav and becomes a button on the Projects page. |

---

## 1. Auth: bind the portal client to a real business partner

Today `portalClients.invite` takes `cardCode`/`cardName` as free text
(`apps/server/src/orpc/routers/portal.ts:30`, typed into three plain `Input`s at
`apps/web/src/routes/_authed/settings.tsx:106-109`). Nothing checks that the CardCode exists.

- **`portal.ts` `invite`**: drop `cardName` from the input. Before minting the token,
  `b1.readEntity("BusinessPartners", cardCode, { select: ["CardCode","CardName","CardType"] })` through
  `tenantConnector`/`viaB1`. `NOT_FOUND` → `BAD_REQUEST` *"No business partner {code} in SAP."*
  Reject `CardType !== "cCustomer"`. Store the **B1's** `CardName`, never the browser's.
- **`settings.tsx`**: replace the two Inputs with the existing value-help component
  (`apps/web/src/components/b1/EntityValueHelp.tsx`) bound to `BusinessPartners` — the same picker the
  object page already uses. The email `Input` stays.

No schema change: `portal_client.cardCode`/`cardName` already exist and `clientProcedure`
(`apps/server/src/orpc/base.ts:64-76`) already loads them into every portal request's context.

---

## 2. Server: portal document reads

New in `apps/server/src/orpc/routers/portal.ts` under `portal.docs.*`, all `clientProcedure`:

```ts
const PORTAL_ENTITIES = new Set(["Quotations", "Orders", "DeliveryNotes", "Invoices"]);

// The fence is this list, not the seeded variant. A variant is UI; this is the boundary.
const PORTAL_DOC  = ["DocEntry","DocNum","DocDate","DocDueDate","DocumentStatus","DocTotal",
                     "DocCurrency","NumAtCard","Comments"] as const;
const PORTAL_LINE = ["LineNum","ItemCode","ItemDescription","Quantity","UnitPrice","LineTotal"] as const;
```

| Procedure | Behaviour |
|---|---|
| `docs.schema({ entity })` | Delegates to `entitySchema()` (`apps/server/src/entity-meta.ts`) — same cache as `entities.schema`. |
| `docs.rows({ entity, spec, top, skip, count })` | **Appends `{ field: "CardCode", op: "eq", value: ctx.cardCode }` to `spec.filter` server-side**, then the identical `compileList` + `b1.readEntitySet` body as `entities.rows` (`entities.ts:96-114`). |
| `docs.one({ entity, key })` | `b1.readEntity`, then `row.CardCode !== ctx.cardCode` → `NOT_FOUND`, then project through `PORTAL_DOC` / `PORTAL_LINE` and drop `CardCode`. |
| `docs.chain({ projectId })` | The document walk — see §4. |
| `docs.print({ entity, docEntry })` | Same CardCode fence, then `printDocument()` — see §5. |

Extract the shared bodies of `entities.rows` / `entities.one` / `entities.schema` into plain functions
in `apps/server/src/entity-read.ts` so both routers call one implementation — the pattern `portal.extract`
already uses ("shares the implementation helper with the internal `extraction.ts` — one code path, two
procedures").

Note `compileList` (`apps/server/src/entity-list.ts:61`) always injects `schema.keys` into `$select`, so
`DocEntry` is on every row even when it is not a visible column. Printing needs no extra fetch. And
`compileList:66` **throws** on a filter naming a missing field — so a non-BP entity slipping into
`PORTAL_ENTITIES` fails loudly rather than leaking rows.

---

## 3. Web: reuse the entity pages under a portal scope

`EntityListPage` (97 lines) and `EntityObjectPage` (171 lines) are B1-coupled in exactly four spots:
the procedure names, the variant key `b1:${entity}` (`EntityListPage.tsx:24`), and the hardcoded
`navigate({ to: "/b1/..." })` calls (`EntityListPage.tsx:79`, `EntityObjectPage.tsx:61,:107`).

Add **one** prop to each — `scope?: "internal" | "portal"` (default `"internal"`) — and derive
everything from it:

```ts
const portal = scope === "portal";
const listSpec = useListSpec(portal ? `portal:${entity}` : `b1:${entity}`);
```

Under `scope="portal"`: procedures come from `orpc.portal.docs.*`, row click navigates to
`/portal/docs/$entity/$key`, and `EntityObjectPage` renders no Edit button and no copy-flow buttons
(`flows` is not fetched at all).

**New route files** (2), each a 3-line mount like `routes/_authed/b1/$entity.tsx`:

- `apps/web/src/routes/_authed/portal/docs/$entity.tsx`
- `apps/web/src/routes/_authed/portal/docs/$entity_.$key.tsx`

Both `beforeLoad`-guard `entity ∈ PORTAL_ENTITIES` (the server fences anyway; this is UX).
`routes/_authed.tsx:38-44` already pins clients inside `/portal/*` — no change.

**Nav** (`apps/web/src/components/AppShell.tsx:207-245`): the `isClient` branch grows from 2 items to 5
(Projects `sales-order`, Quotations `sales-quote`, Sales orders `sales-order-item`, Deliveries
`shipping-status`, Invoices `monitor-payments`). "New request" is removed.

**Projects list** (`routes/_authed/portal/index.tsx`): swap the hand-rolled `<Table>` for `ListReport`
so all five nav items share one chrome. Columns Name · Product · Status (`ObjectStatus` via the existing
`portalUi.ts`) · Updated; rows from `portal.projects.list` through `applySpec` (the local executor, same
as `ConfigsPage`). `New project` moves into the `actions` toolbar and navigates to `/portal/new`.

---

## 4. The timeline

`PortalRequestSummary.tsx` already renders `project.events` in a UI5 `Timeline` (`:104-111`). It gains a
second source, merged and sorted by date descending.

**New `apps/server/src/doc-chain.ts`** (~60 lines), written in the same style as `doc-history.ts` and
reusing its machinery — `CrossJoinSpec` + `b1.crossJoin`, no new `B1Transport` method:

```
start: config_run.b1DocEntry   (the Quotations DocEntry; the only B1 link HERA stores)

hop 1  $crossjoin(Orders,Orders/DocumentLines)
         Orders/DocEntry eq Orders/DocumentLines/DocEntry
         and Orders/DocumentLines/BaseType eq 23
         and Orders/DocumentLines/BaseEntry eq <q>

hop 2  DeliveryNotes  ... BaseType eq 17 and BaseEntry in <orders>
hop 3  Invoices       ... (BaseType eq 17 and BaseEntry in <orders>)
                       or (BaseType eq 15 and BaseEntry in <deliveries>)
```

`BaseType` codes come straight from `DOCUMENT_FLOWS` (`apps/server/src/doc-copy.ts:16-23`) — the same
table the forward copy writes. Projection per hop: `DocEntry, DocNum, DocDate, DocTotal, DocumentStatus`.
`top: 50` per hop (it counts document/line pairs, same caveat as `doc-history.ts:41`), deduped by
`DocEntry`. `// ponytail: 3 sequential crossjoins per open project; cache in config_run if it ever shows`

`docs.chain` is `clientProcedure`-fenced on the project's CardCode via the existing `ownProject()`
(`portal.ts:81-87`). An internal twin is **not** built — nothing asked for it.

**Rendering**: `TimelineItem` per entry. Documents get `state="Information"`, an icon per type,
`nameClickable` → `/portal/docs/$entity/$key`, and a `<PrintActions>` child. Milestones keep the existing
`EV_UI` icon map. When the project is not yet `quoted` the chain query is disabled and the timeline is
exactly what it is today.

---

## 5. PDF preview and download

The API Gateway is a **different service** from the Service Layer: different port, different login
(`POST /login`, not `/b1s/v2/Login`), and its response is a base64 **string**. So it deliberately does
**not** go through `B1Transport` — that would mean a 9th method, a `query.ts` path shape it cannot
express, and a binary channel `ServiceLayer.request` does not have. Base64 is JSON-safe, so the agent's
`Response.json` reply channel is already sufficient.

### Agent

**`apps/agent/agent.json`** — the orphaned block gains `url` and `layouts`:

```json
"apiGateway": {
  "url": "https://localhost:60020",
  "companyDb": "ALUMIGRAF",
  "user": "manager",
  "pass": "...",
  "layouts": {
    "Quotations": "RCRI00xx", "Orders": "RCRI00xx",
    "DeliveryNotes": "RCRI00xx", "Invoices": "RCRI00xx"
  }
}
```

**New `apps/agent/src/api-gateway.ts`** (~70 lines):

- `login()` → `POST {url}/login` `{CompanyDB, UserName, Password}`; keep the session cookie via
  `res.headers.getSetCookie()` and **one in-flight login promise** — the same two lessons already
  carried in `packages/b1/src/service-layer.ts:66,108`.
- `exportPdf(layoutCode, docEntry)` → `POST {url}/rs/v1/ExportPDFData?DocCode={layoutCode}` with the
  document-layout parameter body:
  `[{ "name": "DocKey@", "type": "xsd:string", "value": [[String(docEntry)]] }]`
  → base64 PDF string. One re-login retry on 401.
- `allowSelfSigned` reuses Bun's `tls: { rejectUnauthorized: false }` (the gateway ships a self-signed
  cert; note `fetch` ignores undici's `dispatcher` under Bun — the existing `packages/b1` comment).

**Route** in `apps/agent/src/index.ts`: `POST /print` handled alongside `/health`, *before* the
`/{target}/{operation}` split (print has no `B1Transport`). Auth-gated like everything else. Body
`{ entity, docEntry }`, reply `{ pdf: "<base64>", fileName: "Quotations-12045.pdf" }`. Unknown entity or
missing layout → `502` with the real status in the body, matching `fail()` (`index.ts:57`).

Exact param name (`DocKey@`) and the `layouts` codes are confirmed by `scripts/print-smoke.ts` — see
Verification.

### Server

- **`packages/b1/src/remote.ts`**: promote the private `call()` to an exported
  `agentPost(opts, route, body)`; `RemoteTransport.call` delegates to it. Five-line refactor, no
  duplicated bearer/CF-Access/timeout handling.
- **`apps/server/src/b1.ts`**: extract `agentTarget(tenantId)` returning
  `{ agentUrl, secret, accessClientId, accessClientSecret }` from `sapConnection`; `tenantConnector`
  uses it too.
- **New `apps/server/src/print.ts`**: `printDocument(tenantId, entity, docEntry)` → `agentPost(...,
  "/print", ...)`, errors through `toOrpcError`.
- **`entity-profiles.ts`**: `export const PRINTABLE = new Set(["Quotations","Orders","DeliveryNotes","Invoices"])`.
- Two procedures, one implementation: `entities.print` (`adminProcedure`, `/b1` is admin-only already)
  and `portal.docs.print` (`clientProcedure` + CardCode fence).

### Web

**New `apps/web/src/components/b1/PrintActions.tsx`** — the single place printing exists in the UI:

```tsx
<PrintActions entity="Quotations" docEntry={12045} scope="portal" />
```

Renders **Preview** and **Download**, owns its `Dialog`, and turns base64 into a blob URL:

```ts
const url = URL.createObjectURL(new Blob([Uint8Array.from(atob(pdf), c => c.charCodeAt(0))],
                                         { type: "application/pdf" }));
```

- Preview → UI5 `Dialog stretch` containing `<iframe src={url} title="…">` — the browser's own PDF
  viewer. No dependency, no renderer. `// ponytail: iframe + the browser's viewer; a real viewer only if someone needs annotations`
- Download → a synthetic `<a href={url} download={fileName}>` click.
- `URL.revokeObjectURL` on dialog close / unmount.

Three call sites:

1. **`EntityObjectPage`** — in the existing `ObjectPageTitle actionsBar` (`:94-109`), next to Edit,
   gated on `PRINTABLE.has(entity)`.
2. **`ListReport`** — one new optional prop next to `onDelete`:
   `selectionActions?: (rows: Row[]) => ReactNode`, rendered in the count bar
   (`ListReport.tsx:286-300`). `EntityListPage` passes
   `(rows) => rows.length === 1 && PRINTABLE.has(entity) ? <PrintActions … docEntry={rows[0].DocEntry} /> : null`.
   `ListReport` never learns what printing is. This cashes in the existing
   `// ponytail: one bulk action; swap for a render-prop slot if a second one ever lands.`
3. **Timeline items** in `PortalRequestSummary`.

---

## 6. Seeded external variants

`ui_variant.entity` is free text with no FK (`packages/db/src/schema/variant.ts:53`), so `portal:Quotations`
is a legal key alongside `b1:Quotations` — the precedent is `configs`/`"Requested"`
(`apps/server/src/seed-variants.ts:85-99`).

Add `ensurePortalVariants(tenantId, userId, force)` to `apps/server/src/seed-variants.ts`, looping the four
entities and calling the existing idempotent `ensureStandardVariants` with:

| page | fields |
|---|---|
| `list` | `DocNum, DocDate, DocDueDate, NumAtCard, DocumentStatus, DocTotal`; `orderby: DocEntry desc`; `filterBar` mirrors `select` |
| `object` | header `DocNum, DocDate, DocDueDate, DocumentStatus, DocTotal, DocCurrency`; general `NumAtCard, Comments`; `DocumentLines` section `ItemCode, ItemDescription, Quantity, UnitPrice, LineTotal` |

No `CardCode`/`CardName` — the client *is* the card. No cost, margin, or salesperson fields; and the
`PORTAL_DOC`/`PORTAL_LINE` allowlist in §2 means adding one to a variant still would not fetch it.

Called from the same two sites as the existing seeders: `apps/server/src/auth.ts:35-36`
(`afterCreateOrganization`) and `scripts/seed-standard.ts:39-40`.

**Delivery to the browser.** `variants.list` is `userProcedure`, which fences clients out
(`base.ts:48`), so `useListSpec` would fall back to `EMPTY_SPEC` and show every column. Add
`portal.variants({ page, entity })` — `clientProcedure`, read-only, returns only shared rows whose
`entity` starts with `portal:`, always `canManage: false, isAdmin: false`. In
`apps/web/src/variants.ts:25`, `useVariants` picks the endpoint by prefix; `useListSpec` derives
`readOnly = entity.startsWith("portal:")`, and `ListReport` skips `VariantManagement` and the width-
persistence mutation when it is set. No new props on the pages.

> Worth saying once: for a user who cannot save views, a saved view is machinery for nothing — a
> constant `ListVariantDef` in the web bundle would be ~40 fewer lines. Seeded variants are built as
> asked, and they do buy per-tenant tailoring without a deploy.

---

## Files

**New (9)**
`apps/agent/src/api-gateway.ts` · `apps/server/src/doc-chain.ts` · `apps/server/src/print.ts` ·
`apps/server/src/entity-read.ts` · `apps/web/src/components/b1/PrintActions.tsx` ·
`apps/web/src/routes/_authed/portal/docs/$entity.tsx` ·
`apps/web/src/routes/_authed/portal/docs/$entity_.$key.tsx` · `scripts/print-smoke.ts` ·
`apps/server/test/portal-docs.test.ts`

**Modified (13)**
`apps/agent/src/index.ts` (+`/print`, `AgentConfig.apiGateway`) · `apps/agent/agent.json` +
`agent.example.json` · `packages/b1/src/remote.ts` (export `agentPost`) · `apps/server/src/b1.ts`
(+`agentTarget`) · `apps/server/src/entity-profiles.ts` (+`PRINTABLE`) ·
`apps/server/src/seed-variants.ts` (+`ensurePortalVariants`) · `apps/server/src/auth.ts` ·
`scripts/seed-standard.ts` · `apps/server/src/orpc/routers/portal.ts` (+`docs.*`, `variants`, invite
validation) · `apps/server/src/orpc/routers/entities.ts` (+`print`, use `entity-read.ts`) ·
`apps/web/src/components/b1/EntityListPage.tsx` + `EntityObjectPage.tsx` (+`scope`) ·
`apps/web/src/components/ListReport.tsx` (+`selectionActions`, readOnly variants) ·
`apps/web/src/variants.ts` (portal endpoint + `readOnly`) · `apps/web/src/components/AppShell.tsx`
(5-item client nav) · `apps/web/src/routes/_authed/portal/index.tsx` (→`ListReport`) ·
`apps/web/src/components/portal/PortalRequestSummary.tsx` (merged timeline) ·
`apps/web/src/routes/_authed/settings.tsx` (BP value help)

**Unchanged**: `packages/db` (no schema change at all), `packages/config-engine`, `packages/b1`'s
`B1Transport`/`query.ts`/`service-layer.ts`, the 4-step wizard and every `Step*` component.

---

## Build order

1. **Print, end to end.** `api-gateway.ts` + agent route + `scripts/print-smoke.ts` → fill in the four
   `RCRI` codes → `PrintActions` on `EntityObjectPage` and `ListReport` for internal users. Ships value
   on its own and settles the one live unknown first.
2. **Portal document reads.** `entity-read.ts`, `portal.docs.*`, `ensurePortalVariants`,
   `portal.variants`, the `scope` prop, the two routes, the 5-item nav.
3. **Timeline.** `doc-chain.ts`, `docs.chain`, merged `PortalRequestSummary`, `/portal` → `ListReport`.
4. **Auth binding.** B1 validation in `invite` + the value help in Settings.

---

## Verification

**Live gateway smoke (do this first — it produces the `layouts` values step 1 needs):**

```bash
bun scripts/print-smoke.ts          # reads apps/agent/agent.json
#  1. POST /login                       -> session
#  2. GET  /rs/v1/LoadAuthorizedCRList  -> prints code / name for every layout
#  3. GET  /rs/v1/LoadCR?DocCode=<code> -> confirms the parameter is named `DocKey@`
#  4. POST /rs/v1/ExportPDFData?DocCode=<code>  body [{name:"DocKey@",...,value:[["<DocEntry>"]]}]
#     -> writes ./out.pdf and reports its byte size
```

If step 3 shows a different parameter name (`ObjectId@` alongside `DocKey@`, say), the body in
`api-gateway.ts` changes and nothing else does.

**Automated**

```bash
bun test apps packages                                    # whole suite
bun test apps/server/test/portal-docs.test.ts             # the new one
bunx tsc -p apps/server/tsconfig.json --noEmit            # and agent, web, packages/b1
bun --cwd apps/web build                                  # regenerates routeTree.gen.ts
```

`apps/server/test/portal-docs.test.ts` covers what the existing `scoping.test.ts` /
`sanitization.test.ts` cover for projects:

- `docs.rows` compiles a query whose `$filter` contains `CardCode eq '<bound>'`, for every entity, and
  still does when the client's own spec carries filters.
- `docs.one` on a DocEntry belonging to another CardCode → `NOT_FOUND`.
- The `docs.one` response JSON contains no `GrossProfit`, `DiscountPercent`, `SalesPersonCode` or any
  key outside `PORTAL_DOC`/`PORTAL_LINE`.
- `docs.print` on another CardCode's DocEntry → `NOT_FOUND`; an entity outside `PRINTABLE` → `FORBIDDEN`.
- `docs.rows` with `entity: "BusinessPartners"` → `FORBIDDEN`.
- `invite` with an unknown CardCode → `BAD_REQUEST`, and the stored `cardName` is B1's, not the input's.

**Manual, against the live ALUMIGRAF company**

```bash
docker compose up -d db && bun run dev        # :3000 + :5173
bun run dev:agent                             # agent.json -> localhost:50001 + localhost:60020
bun run seed:standard <slug> --force          # seeds the portal: variants
bun run seed:portal-client <slug> <email> <a real ALUMIGRAF CardCode>
```

Then walk both flows at `http://<slug>.lvh.me:5173`:

1. **Nav** — Quotations → the list shows only that CardCode's documents, minimal columns, no
   CardCode/cost fields. Select one row → Preview opens the PDF in the dialog, Download saves it. Open
   the row → object page, no Edit button, lines visible, both buttons work.
2. **Timeline** — take a project through configure → submit → (internal) quote in `/configs`, then copy
   the quotation to an order in `/b1/Quotations/<DocEntry>`. Reload `/portal/<id>`: the order appears on
   the timeline above the quotation, its title navigates to the portal object page, and its Preview
   renders the order's layout, not the quotation's.
3. **Internal** — `/b1/Invoices`: select one row, Preview/Download in the count bar; select two, both
   disabled.
4. **Invite** — Settings → Invite client: an unknown CardCode is rejected with SAP's own message; the
   value help returns real business partners.

**Negative paths to see once**: agent stopped → both buttons surface the existing
`SERVICE_UNAVAILABLE` "SAP is not connected."; API Gateway stopped but agent up → `BAD_GATEWAY` naming
the gateway; a `layouts` entry pointing at a nonexistent `DocCode` → a message naming the entity, not a
blank PDF.
