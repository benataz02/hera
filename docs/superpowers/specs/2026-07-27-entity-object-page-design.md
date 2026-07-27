# Entity object page: schema-driven, variant-scoped, editable

Date: 2026-07-27
Branch: `claude/configurator-ui-improvements-4zjskv`

## Problem

`apps/web/src/components/EntityObjectPage.tsx` renders any enabled B1 entity as a Fiori object page,
but it is built on a blind spot: **the app has no schema for anything nested and no schema for enums.**

`parseEdmx` (`apps/agent/src/service-layer-client.ts:29`) extracts `Property` + `Key` and discards
`NavigationProperty` and `EnumType`. So the page can only learn that `DocumentLines` exists *by
fetching the whole record* and scanning it for array-valued fields:

```ts
const collections = Object.entries(record).filter(([, v]) => Array.isArray(v))
```

Three user-visible consequences follow from that one gap:

1. **No minimal fetch.** You cannot `$select` a field set you do not know about, so `entities.get`
   (`apps/server/src/orpc/routers/entities.ts:185`) does a bare `GET /Entity(key)` and pulls every
   column of every line on every open.
2. **Keys must be visible to be fetched.** `visibleColumns()` feeds *both* the OData `$select` and the
   table's column list, so `DocEntry` has to be a rendered column or the record does not come back at
   all. Same defect in `EntityListPage.tsx:29`, which sends `select: visibleCols` and then reads
   `row[schema.keys[0]]` for the row click.
3. **No enums.** Every `DocumentStatus`/`BoYesNoEnum` field is a free-text `Input` showing `bost_Open`.

Alongside that, the current page is display-plus-header-edit only. It has no line editing, no create
mode, no B1 defaulting or line arithmetic, and its `ObjectVariantDef` (`{fields[], sections[]}`) has
no per-collection column configuration.

## Goal

Rebuild the page as the single object floorplan for both **document-type** entities (Quotations,
Orders, Invoices) and **master data** (Items, BusinessPartners), used from two callers:

- `_authed/_entities/$entity_/$id` — navigate from a list to one record.
- The configurator's quote step in `ConfigProcessPage.tsx:328`, currently `<ToBeDone />`.

with edit/display mode, per-section variant-driven field configuration, minimal fetch, and B1's
line-level defaulting and arithmetic.

## Non-goals

- Reimplementing B1's pricing engine (price lists, special prices, volume/period discounts, BP
  discount groups, tax jurisdictions). See "Live calculation" below.
- Routing quote creation through the outbox `dedupKey` idempotency. See "Accepted risks".
- OData v3 (`b1s/v1`) navigation properties.
- Collections nested more than one level (`DocumentLines[].LineTaxJurisdictions`).
- Reverse associations ("all Quotations for this ChartOfAccount"). Parsed well enough to be
  distinguished from owned collections, then discarded — related-object navigation is its own feature.
- ETag / optimistic concurrency on save.
- Changing the list report's OData compilation path.

## Decisions taken

| Question | Decision |
|---|---|
| How deep does client-side B1 logic go? | Local arithmetic, B1 authoritative on save |
| Variant scope | One saved view per object, covering header + section fields + line columns |
| Create mode | Yes — `recordKey` optional, `initialValues` prop, `onSaved` callback |
| PATCH semantics | `B1S-ReplaceCollectionsOnPatch: true` |
| Approach | Schema-driven (teach `parseEdmx` about `NavigationProperty` + `EnumType`) |

### Why schema-driven

The two rejected alternatives:

- **Record-driven** (status quo): keep discovering collections from the fetched record. Circular —
  you cannot fetch minimally until you know the shape, and you cannot know the shape without fetching
  fully. Fails "seed variants with minimal fields" outright and leaves no enum source.
- **Self-learning hybrid**: fetch fully once, cache the discovered shape into the variant, fetch
  minimally afterwards. Avoids touching the agent, but the first open of every entity is still a full
  fetch and the cached shape silently rots when B1 gains a UDF. Clever where boring is available.

Schema-driven is the only option that makes the variant the single source of truth for *both* layout
and fetch, which is what every other requirement hangs off.

### Why local arithmetic, not a B1 round-trip

B1's pricing engine lives in the SBO server, not in Service Layer; there is no simulate endpoint. The
only exact option is to keep a shadow `Draft` alive and PATCH it on every change — ~200-600ms per
edit through the agent, plus a draft lifecycle that orphans rows when a tab dies. Instead: compute
optimistically in the browser, and let the save re-read make B1 authoritative. Any pricing rule we
did not model corrects itself the moment the user saves, visibly and in one place.

---

## Architecture

### 1. Metadata — `parseEdmx` learns two new tags

`apps/agent/src/service-layer-client.ts`:

```ts
export interface EdmProperty {
  name: string;
  type: string;
  nullable: boolean;
  /** EnumType members, inlined. Drives Select in forms AND ListReport's FilterBar. */
  options?: { value: string; text: string }[];
}

export interface EntitySchema {
  name: string;
  keys: string[];
  properties: EdmProperty[];
  /** Owned sub-structures, one level deep. `many` distinguishes a collection from a struct. */
  collections?: (EntitySchema & { many: boolean })[];
}
```

Parser changes:

- Add `EnumType`, `Member`, `NavigationProperty`, `ReferentialConstraint` to the `XMLParser` `isArray` list.
- Build `Map<enumLocalName, {value,text}[]>` from `EnumType > Member` (`@_Name` → text, `@_Value` →
  value). When a `Property`'s `@_Type` strips to a name in that map, attach `options`.
- **Invert the existing EntitySet → EntityType map** into `Map<entityTypeLocalName, entitySetName>`.
  The parser already walks `EntityContainer > EntitySet`; this is the same loop.
- Walk each `EntityType`'s `NavigationProperty` entries and classify them (below).

#### Owned sub-collection vs. reverse association

B1 declares navigation in **both** directions, and the two are not remotely the same thing:

```xml
<!-- on ChartOfAccount: a reverse association. Every Document that references this account. -->
<NavigationProperty Name="Quotations" Partner="ChartOfAccount" Type="Collection(SAPB1.Document)"/>

<!-- on Document: an owned sub-collection. The document's own lines. -->
<NavigationProperty Name="DocumentLines" Type="Collection(SAPB1.Document_Lines)"/>
```

Both are `Type="Collection(...)"`. Treating every collection nav property as a section would give
`ChartOfAccounts` a "Quotations" section listing every quotation in the company, and would inline the
entire `Document` schema into every master-data type that points at one — which is also the payload
explosion risk, not just a UI bug.

The discriminator is derivable from the inverted map:

> **A collection nav property whose target EntityType has no EntitySet is owned. One whose target
> has an EntitySet is a reverse association.**

`Document_Lines` is not addressable (`GET /Document_Lines` does not exist), so it is owned and gets a
section. `Document` is addressable as `Quotations`/`Orders`/`Invoices`, so `ChartOfAccount.Quotations`
is a reverse association and is skipped. If B1 also emits OData v4's `ContainsTarget="true"` on owned
navigation, that is the more explicit signal and takes precedence when present.

Reverse associations are **discarded**, not stored. Rendering "related documents" is a separate
feature and nothing in this spec consumes them.

#### Foreign keys come from `ReferentialConstraint`

Single-valued nav properties carry the FK mapping explicitly:

```xml
<NavigationProperty Name="BusinessPartner" Partner="Quotations" Type="SAPB1.BusinessPartner">
  <ReferentialConstraint Property="CardCode" ReferencedProperty="CardCode"/>
</NavigationProperty>
```

`Property` is the local (dependent) field; the nav target's EntityType resolved through the inverted
map gives the entity set to read from. So the local `CardCode` property gains:

```ts
/** Derived from NavigationProperty > ReferentialConstraint. Drives ValueHelp. */
lookup?: { entitySet: string; valueField: string };   // { entitySet: "BusinessPartners", valueField: "CardCode" }
```

`ItemCode` on `Document_Lines` resolves to `Items` the same way. This is the entire value-help source
map, derived rather than declared — no hand-maintained table, and a UDF-driven FK a customer adds
works without a code change. A property whose nav property omits `ReferentialConstraint` simply gets
no `lookup` and falls back to a plain `Input`.

Single-valued nav properties whose target has **no** EntitySet are owned structs — `many: false`,
rendered as a Form section.

**Enums are inlined per property, not stored in a shared table.** B1 enums are small (2-6 members) and
inlining keeps `EntityProperty` structurally compatible with `ListColumn` (`{name, type, label?,
options?, Cell?}`), which `EntityListPage` already relies on ("B1 pages pass `schema.properties`
straight through"). `ListReport` already renders a `Select` in the FilterBar for any column with
`options` — so **the list report gains enum filters for free**, no code change.
`ponytail:` comment names the ceiling — dedupe into an enum table if the jsonb ever gets fat.

Two deliberate ceilings, each with a `ponytail:` comment naming its upgrade path:

- **v4 navigation properties only.** The client demonstrably speaks `b1s/v2` (`$count=true`,
  `@odata.nextLink`, `Prefer: odata.maxpagesize`). v3's `Association`/`FromRole`/`ToRole` indirection
  is real work for a version this codebase does not use. Property/Key parsing keeps its existing
  v3+v4 handling untouched.
- **One level deep.** `DocumentLines` yes; `DocumentLines[].LineTaxJurisdictions` no. Line-level
  nested arrays stay excluded from line columns, as they already are.

**Payload risk (accepted, monitored).** `discover` returns every entity set, so inlining
`Document_Lines` into ~30 document sets grows a response that travels through the `agent_request.result`
jsonb column and the LISTEN/NOTIFY reply path. The owned-vs-reverse rule above is what keeps this
bounded — without it, every master-data type pointing at a `Document` would inline the full document
schema. Mitigation on top: log the serialized byte size in the `discover` handler. If it measurably
hurts, dedupe child types into a top-level map keyed by type name. Not before it fires.

**The type is declared twice and validated once — all three must change together.**

| Location | What it is | Change |
|---|---|---|
| `apps/agent/src/service-layer-client.ts:7` | `EdmProperty` / `EntitySchema`, what `parseEdmx` emits | add `options`, `collections` |
| `packages/db/src/schema/tenant.ts:4` | `EntityProperty` / `EntitySchema` / `EnabledEntity`, what is stored | mirror them |
| `apps/server/src/orpc/routers/entities.ts:67` | `PropertyZ` / `EntitySchemaZ` / `EnabledEntityZ` | mirror them |

The third is the one that bites: zod objects strip unknown keys by default, so without it
`setEnabled` would accept a schema carrying `options` and `collections` and persist it with both
silently removed — discovery would look like it worked and the page would still see nothing. The
`EntitySchemaZ` change is recursive (`collections` holds entity schemas), so it needs an explicit
`z.lazy` or a hand-written one-level-deep child schema. One level deep is the simpler match for what
the parser actually emits.

**Migration.** Existing `tenant_integration.enabledEntities` rows have no `collections` and no
`options`. Both are optional; absent means "as today". An admin re-runs Discover → Save in Settings
to pick them up. No data migration.

### 2. Fetch — the variant *is* the `$select`/`$expand`

`entities.get` input gains:

```ts
select: z.array(z.string()).optional(),
expand: z.array(z.object({ name: z.string(), select: z.array(z.string()) })).optional(),
```

Every name is validated against the schema before it reaches a URL, by the same `assertField` guard
`entities.list` already uses — header properties for `select`, the named collection's properties for
`expand[].select`. An unknown name is a `BAD_REQUEST`, never a passthrough. Omitting both keeps
today's whole-record behaviour, so the endpoint change lands independently of the UI.

Agent gains `buildGetPath(entity, key, keyQuoted, {select, expand})` next to `buildListPath` — pure,
no I/O, so it is unit-testable without a live B1:

```
/Quotations(142)?$select=DocEntry,DocNum,CardCode,CardName,DocDate,DocTotal
                &$expand=DocumentLines($select=LineNum,ItemCode,Quantity,UnitPrice,LineTotal)
```

The rule that fixes the `DocEntry` defect lives in one pure function, `apps/web/src/objectSpec.ts`:

```ts
// Keys are ALWAYS fetched and NEVER rendered.
export function fetchSpec(schema: EntitySchema, def: ObjectVariantDef): {
  select: string[];
  expand: { name: string; select: string[] }[];
}
```

`select = unique([...schema.keys, def.title, ...def.subtitle, ...def.header, ...generalFields])`
with `undefined` filtered out; per collection, `unique([...child.keys, ...columns])`. The rendered
columns come from `def` alone. Two sets derived from one source, so they cannot drift.

An empty `def` (a tenant that never reseeded) returns `{select: [], expand: []}`, and the caller omits
empty arrays from the `entities.get` input — which is today's fetch-everything behaviour. Empty is
therefore "no projection", never "project nothing".

`EntityListPage.tsx:29` gets the same treatment: `select: [...new Set([...schema.keys, ...visibleCols])]`.

### 3. Variant shape + seeding

`packages/db/src/schema/variant.ts`:

```ts
export const ObjectVariantDefZ = z.object({
  title: z.string().optional(),                  // "DocNum"
  subtitle: z.array(z.string()).default([]),     // ["CardCode", "CardName"]
  header: z.array(z.string()).default([]),       // header-area facet fields
  sections: z.array(z.object({
    id: z.string(),                              // "general" | collection name
    visible: z.boolean(),
    fields: z.array(z.string()),                 // general → form fields; collection → columns
    labels: z.record(z.string(), z.string()).optional(),
    widths: z.record(z.string(), z.number()).optional(),
  })).default([]),
});
```

Existing seeded rows are `{fields: [], sections: []}`. `sections: []` parses; the stray top-level
`fields` is dropped by zod. **No migration script.**

`seedObjectDef(schema)` — pure, `apps/server/src/objectSeed.ts`. `ensureStandardVariants` takes an
optional schema (it is already called from `setEnabled`, where the schema is in hand). Every list is
intersected with the entity's real properties, so a rule that does not apply simply contributes
nothing:

| Slot | Preference order | Cap |
|---|---|---|
| `title` | `DocNum` → `Code` → `ItemCode` → `CardCode` → `keys[0]` | 1 |
| `subtitle` | `CardCode`+`CardName` → `ItemName` → first name-ish string field | 2 |
| `header` | `DocDate`, `DocDueDate`, `DocTotal`, `DocumentStatus`, `Canceled` | 5 |
| `general` | first non-key scalars not already used above | 8 |
| collection | `ItemCode`, `ItemDescription`\|`Dscription`, `Quantity`, `UnitPrice`, `DiscountPercent`, `LineTotal` | 6 |

`ensureStandardVariants` is idempotent on `isStandard`, so existing tenants would keep their empty
(fetch-everything) Standard forever. **One extra branch: when called with a schema and the existing
Standard's definition is empty, overwrite it.** Without this the feature never switches on for
already-provisioned tenants.

### 4. Component structure

```
apps/web/src/objectSpec.ts                    pure: def types, fetchSpec(), field classing, humanize
apps/web/src/objectSpec.test.ts
apps/web/src/b1Lines.ts                       pure: recalcLine/recalcTotals/itemDefaults
apps/web/src/b1Lines.test.ts
apps/web/src/components/EntityObjectPage.tsx  floorplan, edit state, general + struct forms
apps/web/src/components/ObjectLinesTable.tsx  one collection: toolbar + editable table
apps/web/src/components/FieldPicker.tsx       the picker Dialog
```

`FieldPicker` is `ListReport`'s existing Columns dialog (checkbox + drag reorder + label rename)
lifted out. Third consumer is header fields / general fields / line columns, so the rule of three is
satisfied; `ListReport` switches over to it rather than keeping a copy.

```
ObjectPage mode="Default"
  titleArea  ObjectPageTitle
    breadcrumbs   Quotations ▸ 142
    header        <Title>{record[def.title]}</Title>
    subHeader     CardCode · CardName
    children      <VariantManagement/>
    actionsBar    <Toolbar>
                    <ToolbarButton icon="action-settings">Header fields</ToolbarButton>
                    <ToolbarButton icon="edit">Edit</ToolbarButton>
                  </Toolbar>
  headerArea  ObjectPageHeader → def.header as Label + ObjectStatus facets
  footerArea  Bar design="FloatingFooter" → Save / Cancel   (edit mode only)
  children    ObjectPageSection id="general"        → Form
              ObjectPageSection id="DocumentLines"  → ObjectLinesTable   (many: true)
              ObjectPageSection id="<struct>"       → Form               (many: false)
```

Two API constraints confirmed against the UI5 Web Components React MCP (v2.24.1) that shape this:

- **`Toolbar` accepts only `ToolbarButton | ToolbarSelect | ToolbarSeparator | ToolbarSpacer`.**
  `VariantManagement` cannot be a child. It goes in `ObjectPageTitle.children` (the middle area);
  the toolbar carries the buttons.
- **`ObjectPageSection.header` is documented for non-focusable content.** Each collection's toolbar
  (Add row / Delete row / Columns) is therefore the section's first child, above the table.

The lines table is the plain UI5 v2 `Table`, not `AnalyticalTable`: a focused `Input` inside a
virtualized, cell-memoized row loses focus on re-render, and `B1S-ReplaceCollectionsOnPatch` forces
every line into memory anyway, so windowing buys nothing on documents of tens of lines.

The `?section=` deep-link machinery from the previous implementation carries over verbatim, comment
included — `onBeforeNavigate` rather than `onSelectedSectionChange` (the latter also fires from the
scroll spy with a stale section id), and the mount-time value applied on a 400ms settle delay because
section offsets are only correct once the tables below have laid out.

### 5. Edit mode

A single `draft: Record<string, unknown> | null`. `null` is display mode; entering edit clones the
record; create mode starts at `{...initialValues}` with no record behind it.

Props:

```ts
{
  entity: string;
  recordKey?: string;                         // absent → create mode
  initialValues?: Record<string, unknown>;    // quote step seeds CardCode + lines
  onSaved?: (record: Record<string, unknown>) => void;
}
```

`EditField` switches on the Edm type, in this order:

| Condition | Control |
|---|---|
| `p.lookup` | `ValueHelp` against `p.lookup.entitySet` |
| `p.options` | `Select` (enum members) |
| bool | `CheckBox` |
| date/time | `DatePicker` |
| numeric | `Input type="Number"` |
| otherwise | `Input` |

`p.lookup` is the `ReferentialConstraint`-derived target from §1 — no hand-maintained field→entity
map anywhere in the codebase. `ValueHelp` reads its options from `entities.list` on
`p.lookup.entitySet`, projecting the target's key plus its name-ish field.

Reuses the existing `apps/web/src/components/ValueHelp.tsx` unchanged — its `DomainOption
{value,label}` and `ResolvedTable {columns,rows}` are structurally satisfiable from an
`entities.list` page, and it already supports remote `onSearch`. The adapter is a few lines.

One caveat worth stating: a lookup target must itself be an **enabled** entity for `entities.list` to
serve it (`loadEnabled` throws `FORBIDDEN` otherwise). A field whose target is not enabled degrades to
a plain `Input` rather than erroring — checked when building the field, not on click.

### 6. B1 line logic

`apps/web/src/b1Lines.ts`, pure and unit-tested:

```ts
recalcLine(line)    // LineTotal = round(Quantity * UnitPrice * (1 - DiscountPercent/100), 2)
recalcTotals(doc)   // DocTotal = Σ LineTotal (+ VatSum where a tax rate is known)
itemDefaults(item)  // ItemName→ItemDescription, SalesUnit→UoMCode, sales/purchase dimensions,
                    // SalesVATGroup→VatGroup, DefaultWarehouse→WarehouseCode
```

Picking an `ItemCode` issues `entities.get("Items", code, {select: [...]})`, merges `itemDefaults`
into the line, then `recalcLine` → `recalcTotals`. Editing `Quantity`, `UnitPrice` or
`DiscountPercent` runs the same last two steps.

`itemDefaults` **is** a hand-written field mapping, and unlike the FK lookups it has to be: which
`Item` field seeds which `Document_Lines` field is B1 application semantics, not a relationship, and
appears nowhere in `$metadata`. It stays a small explicit table with a `ponytail:` comment, extended
as fields come up. `entities.get` on `Items` is reached through the derived `lookup.entitySet`, not a
hardcoded `"Items"` string.

### 7. Save

**Existing record** — `entities.update` → agent `PATCH` with header `B1S-ReplaceCollectionsOnPatch: true`
whenever the body carries an array. Body is the changed header fields plus **complete** collection
arrays: the header makes what we send a replacement, so every line must be present. This is precisely
why the variant governs collection *columns* and never collection *rows* — a fetch that dropped rows
would delete them on save. Then re-GET with the same `fetchSpec` and clear the draft, so B1's totals
overwrite the optimistic ones.

**New record** — `entities.create` → `POST` → `onSaved(created)`; the route caller navigates to
`/$entity/{key}`.

### 8. Error handling

- Agent offline or B1 error → `MessageStrip design="Negative"` in the page. `runRequest` already
  produces user-readable text ("The on-prem agent for this tenant is offline (last seen 120s ago)").
- Save rejected by B1 → `MessageStrip` above the footer, draft preserved so nothing is retyped.
- `nullable: false` field left empty → Save disabled and the field gets `valueState="Negative"`.
- Save disabled while a mutation is in flight (also the only guard against duplicate creates).
- No ETag concurrency. `ponytail:` last-write-wins; add `If-Match` when two users actually collide.

## Accepted risks

**`entities.create` bypasses outbox idempotency.** CLAUDE.md names the outbox + `dedupKey` sync loop
the architecture proof — "a duplicate B1 document physically impossible". `entities.create` is the
direct agent-request path and has no dedup key, so a retried request can produce two Quotations. This
spec mitigates only with a disabled-while-pending Save button. Routing configurator quote creation
through the outbox is a separate spec and a deliberate decision for the user, not a silent widening
of this one.

**`discover` payload growth.** Covered above: log the size, dedupe child types only if it fires.

## Testing

`bun test apps/web`, matching the configurator's existing `*.test.ts` convention (`formHelpers.test.ts`,
`runView.test.ts`, `structureOps.test.ts`).

- `objectSpec.test.ts` — `fetchSpec` puts keys in `select` and never in columns; a collection's select
  always carries `LineNum`; an empty def yields no `select`/`expand` (fetch everything).
- `b1Lines.test.ts` — LineTotal with and without discount, rounding at 2dp, totals over empty and
  mixed line sets, `itemDefaults` mapping.

**Note:** the code comments in `service-layer-client.ts` point `parseEdmx`/`buildListPath` self-checks
at `scripts/e2e.ts --unit`, and `package.json` still has an `e2e` script — **but that file no longer
exists.** The parser tests go to a new `apps/agent/src/service-layer-client.test.ts` with a
`test:agent` script alongside `test:engine`/`test:server`/`test:web`, and the stale comments get
corrected in passing.

- `service-layer-client.test.ts` — against a **real `$metadata` fixture** (see build order):
  enum property carries `options`; `DocumentLines` is `many: true` with its own keys; a reverse
  association like `ChartOfAccount.Quotations` is **absent** from `collections`; `CardCode` carries
  `lookup: {entitySet: "BusinessPartners", valueField: "CardCode"}`; `buildGetPath` emits nested
  `$expand=X($select=...)`.

## Build order

0. **Dump a real `$metadata` from the B1 sandbox to a trimmed fixture** (a document entity, its lines
   type, one enum, one reverse association, one `ReferentialConstraint`). Every classification rule in
   §1 is a claim about what B1 actually emits; the fixture is what turns them from assumptions into
   assertions. Do this before writing parser code.
1. `parseEdmx` + the three type/zod declarations in lockstep, tested against the fixture. Nothing
   consumes it yet.
2. `entities.get` `select`/`expand` + `buildGetPath` + validation. Optional params, so no caller breaks.
3. `ObjectVariantDefZ` reshape + `seedObjectDef` + the empty-Standard overwrite branch.
4. `objectSpec.ts` + `b1Lines.ts` + their tests.
5. `FieldPicker.tsx` extracted; `ListReport` switched over.
6. `EntityObjectPage.tsx` + `ObjectLinesTable.tsx`.
7. `EntityListPage.tsx:29` key-in-select fix.
8. Wire the configurator quote step to the create-mode page.
