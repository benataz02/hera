# Entity object page: schema-driven editing and durable writes

Date: 2026-07-29

## Purpose

Rebuild `apps/web/src/components/EntityObjectPage.tsx` as the object floorplan for enabled
SAP Business One entities.

It must support:

- Display and edit modes for documents and master data.
- A document title of `Entity + DocNum` and subtitle of `CardCode · CardName`.
- SAP-aware master-data title fallbacks.
- Variant-driven header fields, form sections, and nested collection columns.
- Minimal Service Layer projection while always fetching hidden identity fields.
- Editable `DocumentLines` with item defaults, pricing, and optimistic totals.
- Reuse in the entity route and the configurator's quote step.
- Durable, idempotent writes for Quotations, Sales Orders, and other profiled entities.

## Verified Service Layer and UI5 facts

The design is based on the connected B1 v2 sandbox and UI5 Web Components React v2.24.1.

- `POST /$metadata` returns the 1.74 MB XML EDMX with 421 entity sets. Keep POST, send
  `Accept: application/xml`, and reject a non-XML response instead of parsing an empty catalog.
- Document nested data such as `DocumentLines` is declared as a complex collection property.
  It is not an expandable navigation property in this Service Layer.
- `$select=DocumentLines/LineNum`, `$select=DocumentLines`, and
  `$expand=DocumentLines(...)` are invalid.
- `$crossjoin(Quotations,Quotations/DocumentLines)` supports independent projection of the
  document and line fields.
- `CompanyService_GetItemPrice` is available. Its `ItemPriceParams` supports `Date`,
  `UoMEntry`, `UoMQuantity`, `InventoryQuantity`, `Currency`, `ItemCode`, `CardCode`, and
  `PriceList`. It returns `Price`, `Currency`, and `Discount`.
- UI5 `Table` has no native fit-all-columns-to-content method. `TableHeaderCell.width` accepts
  explicit CSS lengths/percentages; unset widths share available space proportionally.
- UI5 `Table` supports scroll overflow, row actions, interactive cells, and stable keyboard
  navigation without requiring `AnalyticalTable`.

## Decisions

- Use a shared controlled editor with separate standalone and embedded shells.
- Use a custom `ResponsivePopover`, not UI5 React `VariantManagement`.
- Implement the full variant workflow: select, dirty state, save, save as, default, sharing,
  rename, and delete.
- Use the non-virtualized UI5 v2 `Table` for nested collections in both display and edit modes.
- Display every one-level collection; edit only explicitly profiled collections.
- Use SAP pricing plus local preview arithmetic. SAP is authoritative after save.
- Keep `POST /$metadata`.
- Route all creates and updates through one durable `agent_request(kind="write")` path.
- Require a unique `U_HERA_DedupKey` UDF/index on each document table enabled for create.
- Support common single-key B1 entities first. Composite route keys are outside this version.

## Non-goals

- Reimplement SAP tax, freight, special-price, discount-group, or final rounding engines.
- Edit arbitrary nested collections without a safe identity and update profile.
- Render nested collections deeper than one level.
- Render reverse associations as owned sections.
- Add composite-key URL encoding.
- Add ETag concurrency.
- Add bulk or `$batch` writes.

## Architecture

### Shared core and two shells

`EntityObjectEditor` is a controlled component. It owns presentation and draft behavior but does
not own route navigation or a second `ObjectPage`.

The standalone route uses:

```text
EntityObjectPage
  ObjectPage
    title/header/footer shell
    EntityObjectEditor
```

The configurator uses:

```text
ConfigProcessPage
  existing ObjectPage
    StepCreateQuote
      EntityObjectEditor
```

This avoids nested object pages, competing anchor bars, duplicate scrolling regions, and conflicting
floating footers.

The core accepts a controlled record/draft, schema, active variant, capabilities, callbacks, and an
optional write status. The standalone shell loads an existing entity. `StepCreateQuote` supplies a
new document draft and a configurator origin.

### Proposed web component split

- `EntityObjectPage.tsx`: standalone query and `ObjectPage` shell.
- `EntityObjectEditor.tsx`: forms, sections, edit state, validation, and write actions.
- `ObjectVariantPopover.tsx`: custom variant list and management actions.
- `ObjectLinesTable.tsx`: one nested collection using UI5 `Table`.
- `EntityField.tsx`: display/edit control selection from metadata.
- `EntityValueHelp.tsx`: validated remote lookup.
- `FieldPicker.tsx`: ordered field/column selection, labels, and widths.
- `StepCreateQuote.tsx`: configurator seed and durable-write origin.
- `objectSpec.ts`: pure schema, profile, variant, fetch, and sizing helpers.
- `b1Lines.ts`: pure item-default and preview-calculation helpers.

## Metadata model

### Parser

Extend `parseEdmx` in `apps/agent/src/service-layer-client.ts` to parse:

- `EntityType`, keys, and scalar properties.
- `ComplexType` and properties whose type is `Collection(...)` or a complex scalar.
- `EnumType` and `Member`.
- `NavigationProperty` and `ReferentialConstraint` for validated lookups.

`DocumentLines` comes from a complex collection property, not a navigation property. Reverse
navigation to addressable entity sets remains excluded from owned sections.

Enum options use the member name as the Service Layer value because records return values such as
`bost_Open`; the numeric EDM member value is retained only as metadata:

```ts
type EnumOption = {
  value: string;
  text: string;
  numericValue?: number;
};
```

Humanized labels strip stable B1 prefixes where practical while preserving the exact enum name for
round trips.

### Schema types

Mirror the schema in:

- `apps/agent/src/service-layer-client.ts`
- `packages/db/src/schema/tenant.ts`
- `apps/server/src/orpc/routers/entities.ts`

Zod validation must include every new property; otherwise the server will silently strip metadata
before storing enabled entities.

One-level child schemas include:

```ts
type CollectionSchema = {
  name: string;
  typeName: string;
  many: boolean;
  properties: EdmProperty[];
};
```

Complex types have no OData key declaration. Runtime identity and joining therefore come from a
small entity/collection profile registry.

### Profiles

Metadata describes shape; profiles describe B1 application semantics that EDMX cannot express.

A profile may define:

```ts
type EntityProfile = {
  entity: string;
  family: "sales-document" | "purchase-document" | "master-data";
  titleField?: string;
  subtitleFields?: string[];
  create?: {
    dedupField: string;
    resultKey: string;
  };
  collections?: Record<string, {
    parentKey: string;
    childParentKey: string;
    rowKey: string;
    editable: boolean;
  }>;
};
```

Document profiles use `DocEntry` as the hidden parent key. `DocumentLines` uses `DocEntry` for the
join and `LineNum` as the hidden row key. Only `DocumentLines` is editable initially.

Profiles also select sales or purchase item-default mappings. They are explicit because that
business meaning is not encoded in EDMX.

### Field capabilities and status locks

EDMX nullability does not mean a field is writable. Editing is conservative:

```ts
type FieldCapabilities = {
  editableHeader: string[];
  requiredOnCreate: string[];
  readOnly: string[];
  collectionEditable?: Record<string, string[]>;
  editWhen?: Array<{ field: string; allowed: Array<string | number | boolean> }>;
};
```

- Unknown entities and unknown fields are display-only.
- Shared document capabilities initially cover common safe header fields and safe
  `DocumentLines` fields.
- `Quotations` and `Orders` extend the shared sales-document profile.
- `Items` and `BusinessPartners` have explicit master-data profiles.
- SAP-managed keys, totals, status fields, audit fields, and line identities are always read-only.
- A document is editable only while every profile status lock passes, such as open status and not
  cancelled. Missing lock fields make the document display-only rather than guessing.
- `requiredOnCreate` drives client validation, while SAP remains the final authority.

Adding write support for another entity is therefore a profile change with tests, not an accidental
consequence of metadata discovery.

## Fetch compilation

### Header projection

`objectSpec.ts` compiles the active variant into a fetch request.

Header selection always injects:

- Entity keys.
- Title/subtitle fields.
- Fields needed by edit rules and totals.
- Variant-visible header/general fields.

Injected fields are fetch dependencies, not rendered fields. `DocEntry` therefore never needs to be
a visible column.

The same key injection is applied to `EntityListPage`: row identity is fetched independently of
visible `AnalyticalTable` columns.

### Nested projection

For profiled collections, the agent performs a validated `$crossjoin` and merges the flat pairs:

```text
/$crossjoin(Quotations,Quotations/DocumentLines)
  ?$expand=Quotations($select=DocEntry),
           Quotations/DocumentLines($select=DocEntry,LineNum,ItemCode,...)
  &$filter=Quotations/DocEntry eq Quotations/DocumentLines/DocEntry
            and Quotations/DocEntry eq 142
```

The request compiler injects `childParentKey` and `rowKey`; the table renders only variant fields.
The server validates every entity, collection, and field against the stored schema before the agent
builds a URL.

One cloud-to-agent `get` request may perform a header GET plus several B1 collection GETs and returns
one merged object.

If a variant selects an unprofiled collection, the agent falls back to a full entity GET and the web
client projects the chosen fields. This preserves "display all collections" without pretending B1
supports a generic nested `$select`. Seeded variants avoid this fallback.

### Variant changes during editing

Switching variants may fetch missing dependencies. New server values merge only into draft paths
that are not already present or dirty. Hidden draft values remain in memory, so layout changes do
not erase edits.

## Variant model and management

Expand `ObjectVariantDefZ` so one definition controls both layout and projection:

```ts
type ObjectVariantDef = {
  header: FieldDef[];
  sections: Array<{
    id: "general" | string;
    visible: boolean;
    fields: FieldDef[];
  }>;
};

type FieldDef = {
  name: string;
  visible: boolean;
  label?: string;
  width?: number;
};
```

Array order is render order. Keys are not added to definitions merely to make requests work.

The custom variant button opens `ResponsivePopover` anchored to the title action. It uses a UI5
`List` with active `ListItemStandard` items and shows the selected/default/shared state. Popover
actions provide Save, Save As, and Manage. Manage uses a dialog for rename, default, sharing, and
delete so destructive actions are not crowded into list rows.

Existing ownership rules remain:

- Users manage personal variants.
- Admins/owners publish and manage shared variants.
- The Standard variant is shared and protected from deletion.

### Standard seeding

`seedObjectDef(schema, profile)` intersects preferences with real metadata.

For documents it prefers:

- Title: `DocNum`.
- Subtitle: `CardCode`, `CardName`.
- Header: dates, status, currency, total, salesperson, and owner.
- General: reference, comments, payment/shipping fields, and other high-value scalars.
- Lines: item code/description, quantity, UoM, unit price, discount, tax code, warehouse, and line
  total.

For master data it uses:

- Title: primary key.
- Subtitle: `ItemName`, `CardName`, `Name`, or a name/description heuristic.
- SAP-aware high-value general fields.
- Relevant profiled collections such as addresses or warehouses in display mode.

An existing empty Standard object variant is replaced on rediscovery. Non-empty user/admin variants
are never overwritten.

## UI5 floorplan

### Standalone object page

The route shell renders:

- `ObjectPageTitle` with entity/document title, subtitle, variant action, and Edit action.
- `ObjectPageHeader` with variant-selected facets.
- A General section for scalar fields.
- One section per selected complex struct or collection.
- A floating Save/Cancel footer in edit mode.
- A write-status message strip while a durable command is pending, retrying, failed, or complete.

The embedded editor renders the same sections and controls but delegates title, page scrolling, and
footer placement to `StepCreateQuote`.

### Line table and content-aware widths

Use UI5 v2 `Table`, `TableHeaderRow`, `TableHeaderCell`, `TableRow`, and `TableCell` with
`overflowMode="Scroll"`.

UI5 has no content-fit API, so `objectSpec.ts` provides deterministic automatic sizing:

1. Measure the rendered header and formatted values using the current UI5 font metrics.
2. Add padding and control affordance width.
3. Apply type-specific minimums and maximums.
4. Set explicit pixel `width` on fixed `TableHeaderCell` columns.
5. Leave one description-like column flexible with an appropriate `minWidth` so short tables fill
   the container.
6. Recompute when data, edit/display mode, active variant, labels, or font/theme changes.

Numeric, status, date, and code fields stay compact. Lookups and descriptions get larger bounds.
Inputs fill the cell width. Display text uses one line plus a tooltip to prevent unpredictable row
height.

An explicit variant width overrides automatic sizing. "Reset to Auto/Fit Content" removes the
override. Width persistence uses pixels because that matches the UI5 header-cell API and existing
variant conventions.

## Editing and B1 business logic

### Controls

Control choice is metadata-driven:

- Lookup: value-help field.
- Enum: `Select`.
- Boolean: `CheckBox`.
- Date/date-time: `DatePicker` or `DateTimePicker`.
- Numeric: numeric `Input`.
- Text: `Input` or `TextArea` for profiled long fields.

Unknown or unsupported types fall back to display text and remain read-only.

### Value help

Add a narrow server procedure that validates a lookup from the source schema, then queries only the
target key and label fields. A lookup target does not need to be independently enabled, because the
source relation/profile authorizes only that target and projection.

Search remains server-side and paged. Selecting a value writes the key and any returned display
default.

### Item context

Changing `ItemCode` calls a dedicated validated item-context operation through the agent. It:

1. Fetches selected Item master fields only.
2. Calls `CompanyService_GetItemPrice`.
3. Returns item defaults plus `Price`, `Currency`, and `Discount`.

The price request includes known context where available: `CardCode`, `ItemCode`,
`InventoryQuantity`, `UoMEntry`/`UoMQuantity`, normalized document date, currency, and price list.

Use an abort/stale-sequence guard so a slow response for the previous ItemCode cannot overwrite a
newer selection.

Each line tracks a UI-only price source: `"sap"`, `"config"`, or `"manual"`.

- A configurator-seeded unit price starts as `config`.
- A user-edited unit price starts or becomes `manual`.
- A blank price populated by `CompanyService_GetItemPrice` becomes `sap`.
- Changes to ItemCode, CardCode, quantity, UoM, document date, currency, or price list debounce a
  new SAP price request for `sap` lines.
- Context changes still refresh non-price item defaults where those target fields are not dirty.
- Automatic repricing never overwrites `config` or `manual` prices.
- A visible "Refresh SAP Price" action explicitly changes the line to `sap` and applies the latest
  SAP price/discount after confirmation when it would replace a manual/config value.

This preserves configurator pricing and user intent while allowing quantity-sensitive B1 pricing to
stay current.

Sales-document mappings use sales UoM, VAT, package, length, width, height, volume, weight, factors,
and warehouse defaults. Purchase documents use their purchasing equivalents. The explicit mapping
is tested and extended only when a real field requirement appears.

### Preview arithmetic

Pure helpers update:

- `LineTotal` from quantity, unit price, and discount.
- Document subtotal from line totals.
- Tax-inclusive preview only where the needed tax values are already known.

Do not claim local totals are SAP-final. After a successful write, re-fetch the active projection and
replace preview values with Service Layer values.

### Collection changes

`DocumentLines` supports add and remove. Existing lines retain `LineNum`; new lines have no
`LineNum` until SAP assigns it.

Updates send every retained line identity and its changed values. Use
`B1S-ReplaceCollectionsOnPatch: true` only when a collection changed. Omitting a row then means
delete; hiding a column never means clear it.

Other collections remain display-only until their profile explicitly defines safe create/update/
delete semantics.

## Generic durable writes

### Command shape

Replace synchronous entity `create`/`update` request-reply behavior with:

```ts
type WriteCommand = {
  operation: "create" | "update";
  entity: string;
  key?: string;
  data: Record<string, unknown>;
  commandId: string;
  idempotency?: {
    field: string;
    value: string;
  };
  origin?: {
    kind: "config-document";
    projectId: string;
    runId: string;
    selectionVersion: number;
  };
};
```

The server derives entity/profile/idempotency fields; the browser cannot choose arbitrary SAP
fields. `agent_request.dedupKey` prevents duplicate cloud commands for the same tenant and
`commandId`.

Updates are available for enabled single-key entities. Creates are enabled only when a profile has a
safe idempotency anchor.

The first-version standalone route opens existing records only. Controlled create mode is exposed by
`StepCreateQuote`; future create callers reuse the same contract without changing the queue kind.

Create-command lifecycle is explicit:

- The caller generates `commandId` when a create draft is initialized.
- It stores the id with the draft in `sessionStorage` and reuses it across rerenders, retries, and
  reload restoration.
- Explicitly discarding the draft removes the id.
- A completed command removes the stored draft/id after the result is recorded.
- Re-submitting the same id returns/watches the existing `agent_request`.
- `onCreated(recordKey)` is a shell callback; the standalone shell may navigate, while the
  configurator shows an "Open document" action.

Update drafts also receive a stable command id for cloud deduplication, but their SAP identity is the
known entity key.

### Agent delivery

`processWrite` follows these invariants:

- Never ack without a confirmed SAP record.
- Never blindly re-POST a create after the first delivery.
- First document-create attempt POSTs with the dedup UDF.
- Redelivery GETs by the dedup UDF before considering POST.
- A unique-key conflict is followed by GET; finding the record permits ack.
- Updates PATCH the known key, then GET it before ack.
- Retried updates may repeat the same PATCH, then confirm by GET.
- Transient errors keep the leased request for retry.
- Confirmed validation/rejection errors dead-letter it.

Add generic `sync.ack` and retain `sync.nack`. Ack stores the result/key, marks the request done, and
notifies `requestChannel(id)`.

### SAP prerequisite

Every document entity enabled for create requires `U_HERA_DedupKey` on its SAP header table and a
unique company-database index. Examples include OQUT for Quotations and ORDR for Sales Orders.

The agent verifies that metadata exposes the field before accepting create work. Service Layer
cannot prove that the database index is unique, so index provisioning and upgrade validation remain
an explicit deployment checklist item. Create UI stays disabled for profiles whose prerequisite is
not declared provisioned.

The declaration comes from on-prem agent configuration, not from the browser:

```text
B1_CREATE_CAPABILITIES=Quotations:U_HERA_DedupKey,Orders:U_HERA_DedupKey
```

At startup and after metadata refresh, the agent:

1. Parses the configured entity/field pairs.
2. Confirms each entity and UDF exist in EDMX.
3. Reports valid pairs through an authenticated `sync.heartbeat`.

The server stores the report and timestamp in `tenant_integration.write_capabilities` and
`write_capabilities_checked_at`. `entities.capabilities` returns the current create/edit capability
and a disabled reason. A stale/offline report disables create but does not disable display or safe
updates.

The configuration is the operator's assertion that the corresponding unique index was provisioned.
The deployment document includes per-company verification and post-upgrade re-verification; the UI
does not claim to inspect an index that Service Layer cannot expose.

### Write status

The write mutation returns the durable request id immediately. `entities.watchWrite` streams the
current row and waits on the existing request notification channel. UI states are:

- Pending: agent has not claimed the command.
- In flight: SAP work is running or awaiting retry.
- Done: record key/result confirmed.
- Failed: permanent rejection with the draft retained.

Navigating away does not cancel the durable command.

## Configurator document creation

`StepCreateQuote` remains quotation-specific UI, while the write infrastructure is generic.

It seeds:

- `CardCode`/`CardName` from the project.
- Currency from model pricing.
- One `DocumentLines` row per selected candidate.
- `ItemCode` from `model.pricing.quoteItemCode`.
- Quantity from the selected batch quantity.
- Unit price from the calculated candidate output.

The user can review and edit the same shared editor before save.

For this origin, the server derives a stable command/dedup value from tenant, project, run, and
selection version. That deterministic value is the command's `commandId` (it replaces a random
caller-generated id for configurator drafts) and is also written to the SAP dedup UDF. Generic
create callers use a draft-scoped random UUID instead. `agent_request.dedupKey` namespaces either
form as `write:{entity}:{commandId}`. On ack, the server transaction:

- Marks the write done.
- Stores the SAP `DocEntry`.
- Marks the project quoted.
- Appends the project event.
- Notifies the browser.

The step then offers navigation to the resulting `Quotations/{DocEntry}` object page.

The same `origin` pattern can later create Sales Orders without adding another queue kind.

## Errors and safety

- Metadata discovery fails loudly on non-XML content.
- Every field/path is schema-validated before OData compilation.
- Agent offline and SAP errors render in-page message strips.
- Failed writes preserve the draft.
- Save is disabled while the current command is unresolved.
- Required visible fields get negative value state; SAP remains the full validation authority.
- Closed/cancelled document profiles disable editing where status fields are available.
- Tenant resolution remains server-side; write payloads never select tenant credentials.
- B1 credentials and item-price calls remain on the agent.

## Testing

### Agent

- Trimmed real EDMX fixture covering `EntityType`, `ComplexType`, a complex collection, enums,
  reverse navigation, and lookup constraints.
- POST metadata request sends XML accept headers and rejects JSON/service-document responses.
- Parser emits enum names as values and one-level collection schemas.
- `$crossjoin` path builders inject parent and row keys and escape predicates.
- Item-price payload uses `InventoryQuantity` and other valid `ItemPriceParams`.
- Write delivery tests cover first POST, retry GET-before-POST, found-record ack, unique-conflict
  recovery, update PATCH+GET, transient nack, and permanent nack.

### Server

- Schema/Zod round trip retains nested properties, enums, and lookups.
- Fetch input rejects unknown entities, collections, and fields.
- Write commands derive profiles and cannot accept caller-selected dedup fields.
- Ack is tenant-scoped and applies configurator side effects atomically.
- Standard seeding upgrades only empty Standard variants.

### Web

- `fetchSpec` always fetches keys and never makes them visible.
- List projection includes entity keys independently of visible analytical columns.
- Variant field order/labels/widths compile into the expected projection.
- Automatic widths clamp by type, explicit widths win, and reset returns to automatic sizing.
- Item defaults choose sales or purchase mappings.
- Line and document preview arithmetic is deterministic.
- Variant switching merges fetched values without overwriting dirty draft paths.
- Configurator selections seed the expected document lines.

### Verification

Run focused tests for agent, server, database package, and web, then the repository typecheck/build.
Use the connected sandbox only for read-only metadata/query smoke tests unless a designated test
document is available.

## Build order

The implementation plan is one staged master plan because later phases depend on the contracts from
earlier phases. Each phase has its own verification gate and can be reviewed independently.

### Phase 1: metadata and read-only projection

1. Correct and test metadata parsing/types from a trimmed real fixture.
2. Add profiles and validated header/crossjoin fetch compilation.
3. Add list key projection and read-only object rendering.

Gate: seeded object variants can fetch and display a quotation and master-data record without making
hidden keys visible or fetching all document-line fields.

### Phase 2: variants and editing

1. Expand object variants and SAP-aware seeding.
2. Add pure fetch, sizing, defaulting, and calculation helpers.
3. Implement the custom popover, field picker, controls, line table, and controlled editor.
4. Add item-context retrieval and SAP price action with source/trigger rules.

Gate: an existing profiled record can enter edit mode, retain draft state across variants, calculate
previews, and produce a validated write command.

### Phase 3: durable generic writes

1. Add agent capability configuration/reporting and server persistence.
2. Implement generic write enqueue, delivery, GET confirmation, ack/nack, and watch.
3. Route existing object updates through the durable path.

Gate: automated tests prove no blind create re-POST, no unconfirmed ack, safe update replay, and
create disablement without a current capability.

### Phase 4: configurator creation

1. Add `StepCreateQuote`, draft/id restoration, and candidate-to-line seeding.
2. Add configurator-origin completion effects and document navigation.
3. Run focused and full verification without git operations.

Gate: the quote step creates one confirmed SAP quotation for a stable selection command and restores
or reports its status after reload.
