# Entity Object Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build one schema-driven SAP B1 object editor for document and master-data records, reuse it
in the entity route and configurator quote step, and deliver all writes through a confirmed,
idempotent agent queue.

**Architecture:** A server-owned metadata/profile contract compiles variants into safe header and
complex-collection projections. A controlled `EntityObjectEditor` renders the projection in either
a standalone `ObjectPage` shell or an embedded configurator step. Generic durable write commands are
profile-validated, delivered by the on-prem agent, confirmed through SAP reads, and watched by the
browser.

**Tech Stack:** Bun workspaces, TypeScript, React, UI5 Web Components React 2.24.1, oRPC, TanStack
Query/Router, Zod, Drizzle/PostgreSQL, SAP Business One Service Layer v2.

**Design specification:** `docs/superpowers/specs/2026-07-27-entity-object-page-design.md`

## Global Constraints

- Do not use git or create commits for this work.
- Keep `POST /$metadata`; send `Accept: application/xml` and reject non-XML responses.
- Treat B1 nested structures as complex properties; `DocumentLines` is not `$expand`-able.
- Fetch identity dependencies independently of rendered fields. `DocEntry` and `LineNum` stay hidden
  unless a variant explicitly renders them.
- Use validated `$crossjoin` paths for profiled collections and a documented full-record fallback
  for unprofiled display-only collections.
- Use a custom `ResponsivePopover`; do not render UI5 React `VariantManagement` on the object page.
- Use UI5 v2 `Table`, not `AnalyticalTable`, for object collections.
- Do not nest an `ObjectPage` inside `ConfigProcessPage`.
- Metadata discovery never grants write access. Only server-owned profiles do.
- All creates and updates use `agent_request(kind="write")`; do not add quotation-specific queue
  kinds.
- When a changed collection is present, PATCH with `B1S-ReplaceCollectionsOnPatch: true`; never
  infer row deletion from hidden columns.
- Never ack a write without a confirmed SAP record; never blindly re-POST a create.
- Exact taxes, freight, special prices, and final totals remain SAP-authoritative after save.
- Support one-level collections and single-key routes only in this version.
- Do not add dependencies unless an existing platform/library cannot supply the required behavior.

---

## Phase 1: Metadata and projection

### Task 1: Define and parse the rich entity schema

**Files:**
- Create: `packages/db/src/schema/entity.ts`
- Create: `apps/agent/test/fixtures/entity-metadata.edmx`
- Create: `apps/agent/test/service-layer-metadata.test.ts`
- Create: `packages/db/src/schema/entity.test.ts`
- Modify: `packages/db/src/schema/tenant.ts:1-24`
- Modify: `packages/db/src/schema/index.ts:1-6`
- Modify: `apps/agent/src/service-layer-client.ts:7-66,291-296`
- Modify: `apps/server/src/orpc/routers/entities.ts:67-69,111-132`

**Interfaces:**
- Produces:

```ts
export type EnumOption = { value: string; text: string; numericValue?: number };
export type EntityProperty = {
  name: string;
  type: string;
  nullable: boolean;
  options?: EnumOption[];
  lookup?: { entitySet: string; valueField: string; labelField?: string };
};
export type CollectionSchema = {
  name: string;
  typeName: string;
  many: boolean;
  properties: EntityProperty[];
};
export type EntitySchema = {
  name: string;
  typeName: string;
  keys: string[];
  properties: EntityProperty[];
  collections: CollectionSchema[];
};
export const EntitySchemaZ: z.ZodType<EntitySchema>;
```

- Preserves `EnabledEntity = EntitySchema & { editable: boolean }`.
- `parseEdmx(xml)` emits one-level complex collections, exact enum member names, and validated lookup
  constraints while excluding reverse entity-set navigation.

- [ ] **Step 1: Add the trimmed real EDMX fixture and failing parser tests**

Cover:

```ts
expect(schema.name).toBe("Quotations");
expect(schema.keys).toEqual(["DocEntry"]);
expect(schema.collections.find((x) => x.name === "DocumentLines")?.properties)
  .toContainEqual(expect.objectContaining({ name: "LineNum" }));
expect(schema.properties.find((x) => x.name === "DocumentStatus")?.options)
  .toContainEqual(expect.objectContaining({ value: "bost_Open" }));
expect(schema.properties.find((x) => x.name === "CardCode")?.lookup)
  .toEqual({ entitySet: "BusinessPartners", valueField: "CardCode" });
```

Also assert that a reverse `Quotations` navigation on a master-data type does not become a
collection section.

- [ ] **Step 2: Run the parser tests and confirm the scalar parser fails them**

Run:

```powershell
bun test apps/agent/test/service-layer-metadata.test.ts packages/db/src/schema/entity.test.ts
```

Expected: failures for missing collections, options, lookup metadata, and shared Zod types.

- [ ] **Step 3: Implement the shared Zod/types and EDMX indexes**

Parse the document in passes:

1. Enum local name to members.
2. complex/entity type local name to properties.
3. entity type to keys/navigation constraints.
4. entity type to entity-set name.
5. entity sets to resolved `EntitySchema`.

Use enum member `Name` as `value`; keep numeric `Value` only in `numericValue`.

- [ ] **Step 4: Harden metadata transport**

Keep:

```ts
this.request("POST", "/$metadata", undefined, { Accept: "application/xml" });
```

Before parsing, require an XML content type or a body whose first non-whitespace character is `<`.
Throw `SlError` with code `BAD_METADATA_RESPONSE` otherwise.

- [ ] **Step 5: Mirror the contract through persistence and server validation**

Move persisted metadata types out of `tenant.ts`, re-export them, and use `EntitySchemaZ`/
`EnabledEntityZ` in `entities.setEnabled`. Verify nested fields survive Zod parsing and JSONB round
trip.

- [ ] **Step 6: Run the focused gate**

```powershell
bun test apps/agent/test/service-layer-metadata.test.ts packages/db/src/schema/entity.test.ts
bunx tsc --noEmit -p packages/db/tsconfig.json
bunx tsc --noEmit -p apps/agent/tsconfig.json
```

Expected: all pass.

### Task 2: Add server-owned entity profiles and Standard object seeds

**Files:**
- Create: `apps/server/src/entity-profiles.ts`
- Create: `apps/server/src/objectSeed.ts`
- Create: `apps/server/test/entity-profiles.test.ts`
- Modify: `packages/db/src/schema/entity.ts`
- Modify: `packages/db/src/schema/variant.ts:30-36`
- Modify: `apps/server/src/seed-variants.ts:8-40`
- Modify: `apps/server/src/orpc/routers/variants.ts:12-24,62-120`
- Modify: `apps/server/src/orpc/routers/entities.ts:117-132`

**Interfaces:**
- Produces:

```ts
export type EntityProfile = {
  entity: string;
  family: "sales-document" | "purchase-document" | "master-data";
  titleField?: string;
  subtitleFields: string[];
  fields: {
    editableHeader: string[];
    requiredOnCreate: string[];
    readOnly: string[];
    collectionEditable: Record<string, string[]>;
    editWhen: Array<{ field: string; allowed: Array<string | number | boolean> }>;
  };
  create?: { dedupField: string; resultKey: string };
  collections: Record<string, {
    parentKey: string;
    childParentKey: string;
    rowKey: string;
    editable: boolean;
  }>;
};
export type EntityCapabilities = {
  canEdit: boolean;
  canCreate: boolean;
  reason?: string;
};
export function getEntityProfile(entity: string): EntityProfile | null;
export function seedObjectDef(schema: EntitySchema, profile: EntityProfile | null): ObjectVariantDef;
```

- Profiles initially cover shared sales/purchase documents, `Quotations`, `Orders`, `Items`, and
  `BusinessPartners`.
- Unknown entities/fields are display-only.
- `EntityProfile` and `EntityCapabilities` are shared serializable types; the registry and all
  authorization decisions remain server-owned.

- [ ] **Step 1: Write failing profile and seed tests**

Assert:

```ts
expect(getEntityProfile("Quotations")?.collections.DocumentLines)
  .toEqual(expect.objectContaining({ parentKey: "DocEntry", rowKey: "LineNum", editable: true }));
expect(getEntityProfile("Unknown")?.fields).toBeUndefined();
expect(seed.header.map((x) => x.name)).toContain("DocTotal");
expect(seed.sections.find((x) => x.id === "DocumentLines")?.fields.map((x) => x.name))
  .toEqual(expect.arrayContaining(["ItemCode", "Quantity", "UnitPrice", "LineTotal"]));
expect(seed.header.some((x) => x.name === "DocEntry")).toBe(false);
```

- [ ] **Step 2: Expand `ObjectVariantDefZ`**

Implement:

```ts
const FieldDefZ = z.object({
  name: z.string(),
  visible: z.boolean(),
  label: z.string().optional(),
  width: z.number().positive().max(2000).optional(),
});
export const ObjectVariantDefZ = z.object({
  header: z.array(FieldDefZ),
  sections: z.array(z.object({
    id: z.string(),
    visible: z.boolean(),
    fields: z.array(FieldDefZ),
  })),
});
```

- [ ] **Step 3: Implement conservative profiles and SAP-aware seeding**

Intersect every preferred field with actual metadata. Never seed unknown properties. Treat totals,
keys, status, audit fields, and line identities as read-only even if discovered.

- [ ] **Step 4: Upgrade only empty Standard variants**

Define "empty" as the legacy `{ fields: [], sections: [] }` or the new shape with no visible fields.
`ensureStandardVariants(entity, schema, profile)` replaces only an empty Standard object definition.
Protect Standard from rename/delete in the server procedures, not only the UI.

- [ ] **Step 5: Run the focused gate**

```powershell
bun test apps/server/test/entity-profiles.test.ts
bunx tsc --noEmit -p apps/server/tsconfig.json
```

Expected: profiles, seed intersection, empty-only upgrade, and Standard protection pass.

### Task 3: Compile and execute minimal object projections

**Files:**
- Create: `apps/server/src/entity-fetch.ts`
- Create: `apps/server/test/entities-projection.test.ts`
- Create: `apps/agent/test/service-layer-fetch.test.ts`
- Modify: `apps/server/src/orpc/routers/entities.ts:73-94,185-190`
- Modify: `apps/agent/src/service-layer-client.ts:84-135,320-325`
- Modify: `apps/agent/src/sync.ts:7-21,36-64`

**Interfaces:**
- Produces:

```ts
export type ObjectFetchRequest = {
  entity: string;
  key: string;
  keyQuoted: boolean;
  select: string[];
  collections: Array<{
    name: string;
    select: string[];
    parentKey: string;
    childParentKey: string;
    rowKey: string;
  }>;
  fullRecordFallback: boolean;
};
export function compileObjectFetch(
  schema: EnabledEntity,
  profile: EntityProfile | null,
  definition: ObjectVariantDef,
): Omit<ObjectFetchRequest, "entity" | "key" | "keyQuoted">;
```

- Agent adds `getEntityProjected(request): Promise<Record<string, unknown>>`.
- Server `entities.get` accepts `{ entity, key, variantId }`, loads the authorized variant itself,
  compiles the projection, and sends only validated fields to the agent. It returns
  `{ record, schema, profile }`, where `profile` is the server-owned serializable profile consumed by
  the web editor.

- [ ] **Step 1: Write failing projection and path tests**

Cover hidden dependency injection:

```ts
expect(spec.select).toContain("DocEntry");
expect(renderedFields).not.toContain("DocEntry");
expect(lines.select).toEqual(expect.arrayContaining(["DocEntry", "LineNum"]));
```

Cover escaped string keys, numeric keys, unknown field rejection, composite-key rejection, and an
unprofiled collection setting `fullRecordFallback`.

- [ ] **Step 2: Implement server compilation and provenance**

Do not accept raw `select`, collection join keys, or target variant definitions from the browser.
Load the enabled schema and visible variant by tenant/user rules, then compile.

Change `setEnabled` input to entity names/editable flags only. Re-run metadata discovery on save
(using a short in-process tenant cache if needed), select those names server-side, and persist the
trusted schemas. Do not make browser-invented properties become future authorization.

- [ ] **Step 3: Implement agent path builders**

Add pure builders for:

- Header `GET /Entity(key)?$select=...`.
- Profiled collection `$crossjoin`.
- Dedicated field escaping/identifier validation.

Flatten each crossjoin pair into the collection value and merge it into the header record. If
`fullRecordFallback` is true, use one full entity GET and project only for rendering.

- [ ] **Step 4: Extend the request port and router**

Add an `object-get` read kind carrying `ObjectFetchRequest`. Keep metadata/list/read requests on the
existing request-reply `fulfill`/`fail` path.

- [ ] **Step 5: Run the focused gate**

```powershell
bun test apps/server/test/entities-projection.test.ts apps/agent/test/service-layer-fetch.test.ts apps/agent/test/sync.test.ts
bunx tsc --noEmit -p apps/server/tsconfig.json
bunx tsc --noEmit -p apps/agent/tsconfig.json
```

Expected: minimal header/line payloads, validation, merging, and fallback pass.

### Task 4: Separate list identity from visible columns and add read-only object rendering

**Files:**
- Create: `apps/web/src/objectSpec.ts`
- Create: `apps/web/src/objectSpec.test.ts`
- Modify: `apps/web/src/components/EntityListPage.tsx:19-59`
- Modify: `apps/server/src/orpc/routers/entities.ts:144-183`
- Modify: `apps/web/src/components/EntityObjectPage.tsx`
- Verify: `apps/web/src/routes/_authed/_entities/$entity_.$id.tsx:1-15`

**Interfaces:**
- Produces:

```ts
export function titleForRecord(
  entity: string,
  record: Record<string, unknown>,
  schema: EntitySchema,
  profile: EntityProfile | null,
): { title: string; subtitle: string };
export function visibleObjectSections(
  schema: EntitySchema,
  definition: ObjectVariantDef,
): ObjectSectionSpec[];
```

- `EntityListPage` renders `visibleCols` but requests `unique([...schema.keys, ...visibleCols])`.

- [ ] **Step 1: Add failing hidden-key and title-fallback tests**

Assert list projection includes `DocEntry` while rendered columns do not. Assert document title
`Quotations 142`, subtitle `C0001 · Customer`, and master fallback `Items A0001` / `Item Name`.

- [ ] **Step 2: Fix list projection**

Prefer server-side key union as defense in depth and keep the client union for explicit query
identity. Disable navigation with a clear message for composite-key entities.

- [ ] **Step 3: Implement the read-only object shell**

Load enabled schema, variants, active variant, and projected record. Render `ObjectPageTitle`,
`ObjectPageHeader`, General, and collection sections. Do not add edit controls or a second page shell.

- [ ] **Step 4: Run the Phase 1 gate**

```powershell
bun test apps/web/src/objectSpec.test.ts apps/web/src/listSpec.test.ts
bun run build:web
```

Expected: build succeeds; hidden list/object keys are fetched but not rendered; quotation and Item
records render from seeded projections.

---

## Phase 2: Variants, controls, pricing, and editing

### Task 5: Implement full custom object variant management

**Files:**
- Create: `apps/web/src/components/ObjectVariantPopover.tsx`
- Create: `apps/web/src/components/FieldPicker.tsx`
- Create: `apps/web/src/components/ObjectVariantPopover.test.ts`
- Modify: `apps/web/src/variants.ts:10-86`
- Modify: `apps/server/src/orpc/routers/variants.ts:26-140`
- Modify: `apps/web/src/components/EntityObjectPage.tsx`

**Interfaces:**
- Produces:

```ts
export function useObjectVariants(entity: string): {
  variants: VariantRow[];
  selectedId: string | null;
  definition: ObjectVariantDef;
  dirty: boolean;
  select(id: string): void;
  save(definition: ObjectVariantDef): Promise<void>;
  saveAs(input: SaveAsInput): Promise<void>;
  rename(id: string, name: string): Promise<void>;
  setDefault(id: string, value: boolean): Promise<void>;
  setShared(id: string, value: boolean): Promise<void>;
  remove(id: string): Promise<void>;
};
```

- Select variants by immutable id, not name.

- [ ] **Step 1: Write failing pure interaction tests**

Test duplicate personal/shared names, selected/default/shared labels, dirty comparison, Standard
protection, owner/admin permissions, and a FieldPicker confirm that preserves ordered field arrays.

- [ ] **Step 2: Implement `useObjectVariants`**

Reuse TanStack Query invalidation patterns from `useVariants`, but keep object draft state separate
from persisted rows and normalize legacy definitions once.

- [ ] **Step 3: Implement `ResponsivePopover`**

Use a stable opener ref, UI5 `List` in single-selection mode, and active `ListItemStandard` items.
Provide Save, Save As, and Manage actions. Put rename/default/share/delete in a dialog.

- [ ] **Step 4: Implement `FieldPicker`**

Support checkbox visibility, drag reorder, label override, numeric pixel width, and "Reset to
Auto/Fit Content". Apply only on confirm.

- [ ] **Step 5: Run the focused gate**

```powershell
bun test apps/web/src/components/ObjectVariantPopover.test.ts apps/web/src/objectSpec.test.ts
bun run build:web
```

Expected: full workflow works without `VariantManagement`.

### Task 6: Add validated value help and SAP item context

**Files:**
- Create: `apps/web/src/b1Lines.ts`
- Create: `apps/web/src/b1Lines.test.ts`
- Create: `apps/web/src/components/EntityValueHelp.tsx`
- Create: `apps/agent/test/object-reads.test.ts`
- Create: `apps/server/test/entities-object.test.ts`
- Modify: `apps/agent/src/service-layer-client.ts:298-350`
- Modify: `apps/agent/src/sync.ts:7-91`
- Modify: `apps/server/src/orpc/routers/entities.ts:185-204`

**Interfaces:**
- Produces:

```ts
type ValueHelpInput = { entity: string; field: string; search: string; skip: number };
type ValueHelpResult = {
  rows: Array<{ key: string; label: string; defaults?: Record<string, unknown> }>;
  hasMore: boolean;
};
type ItemContextInput = {
  entity: string;
  itemCode: string;
  cardCode?: string;
  inventoryQuantity?: number;
  uomEntry?: number;
  uomQuantity?: number;
  date?: string;
  currency?: string;
  priceList?: number;
};
type ItemContextResult = {
  defaults: Record<string, unknown>;
  price?: { value: number; currency?: string; discount?: number };
};
```

- Server resolves target entity/fields and sales/purchase mappings; browser cannot choose them.

- [ ] **Step 1: Write failing server/agent tests**

Assert unauthorized lookup targets/fields are rejected, only profiled Item fields are selected, and
the SAP action body uses `InventoryQuantity` rather than `Quantity`.

- [ ] **Step 2: Implement agent reads/actions**

Add dedicated Service Layer methods for lookup paging, selected Item fields, and
`POST /CompanyService_GetItemPrice`. Normalize date to `DateTimeOffset` only when valid.

- [ ] **Step 3: Implement narrow server procedures**

Add `entities.valueHelp` and `entities.itemContext`. Resolve relation/profile from the source schema,
then send fixed target fields to the agent.

- [ ] **Step 4: Implement pure line helpers**

Export immutable helpers:

```ts
applyItemDefaults(line, defaults, family, dirtyPaths)
recalcLine(line)
recalcDocumentTotals(document)
shouldReprice(priceSource, changedPath)
```

Cover sales/purchase dimensions and the `"sap" | "config" | "manual"` precedence from the spec.

- [ ] **Step 5: Implement `EntityValueHelp`**

Reuse the UX discipline of the configurator `ValueHelp`: controlled key/label, remote search,
explicit selection, and no unvalidated free-text key.

- [ ] **Step 6: Run the focused gate**

```powershell
bun test apps/web/src/b1Lines.test.ts apps/agent/test/object-reads.test.ts apps/server/test/entities-object.test.ts
```

Expected: lookups, item defaults, price payload, source precedence, and arithmetic pass.

### Task 7: Build content-aware UI5 fields and line tables

**Files:**
- Create: `apps/web/src/components/EntityField.tsx`
- Create: `apps/web/src/components/ObjectLinesTable.tsx`
- Create: `apps/web/src/components/ObjectLinesTable.test.ts`
- Modify: `apps/web/src/objectSpec.ts`
- Modify: `apps/web/src/objectSpec.test.ts`

**Interfaces:**
- Produces:

```ts
export function autoColumnWidths(input: {
  fields: FieldDef[];
  properties: EntityProperty[];
  rows: Record<string, unknown>[];
  mode: "display" | "edit";
  measure: (text: string) => number;
}): Record<string, number | "flex">;
```

- Exactly one description-like column may return `"flex"`; explicit variant widths always win.

- [ ] **Step 1: Write failing width/control tests**

Cover compact numeric/date/code widths, wider lookup/description widths, min/max clamping, edit-mode
padding, explicit override, and reset-to-auto.

- [ ] **Step 2: Implement deterministic sizing**

Measure labels and formatted values with an injected adapter. In the browser adapter, use the current
computed UI5 font and recompute after `document.fonts.ready`, theme change, rows, mode, label, or
variant change.

- [ ] **Step 3: Implement `EntityField`**

Map lookup, enum, boolean, date/time, numeric, and text metadata to UI5 controls. Unsupported or
profile-read-only fields render text.

- [ ] **Step 4: Implement `ObjectLinesTable`**

Use `TableHeaderRow`, `TableHeaderCell`, `TableRow`, and `TableCell` with scroll overflow. Fill inputs
to cell width, use one-line text plus tooltip, set `rowKey` from `LineNum` or a local draft UUID, and
add row actions only in edit mode.

On ItemCode/context changes, debounce `itemContext`, abort/sequence stale calls, merge only non-dirty
defaults, and preserve config/manual price sources unless "Refresh SAP Price" is confirmed.

- [ ] **Step 5: Run the focused gate**

```powershell
bun test apps/web/src/objectSpec.test.ts apps/web/src/components/ObjectLinesTable.test.ts apps/web/src/b1Lines.test.ts
bun run build:web
```

Expected: stable editable cells and content-aware columns.

### Task 8: Assemble the controlled editor and standalone edit shell

**Files:**
- Create: `apps/web/src/components/EntityObjectEditor.tsx`
- Create: `apps/web/src/components/EntityObjectEditor.test.ts`
- Modify: `apps/web/src/components/EntityObjectPage.tsx`
- Modify: `apps/web/src/objectSpec.ts`

**Interfaces:**
- Produces:

```ts
type EntityObjectEditorProps = {
  entity: string;
  schema: EntitySchema;
  profile: EntityProfile | null;
  record: Record<string, unknown>;
  draft: Record<string, unknown> | null;
  dirtyPaths: Set<string>;
  variant: ObjectVariantDef;
  capabilities: EntityCapabilities;
  onDraftChange(next: Record<string, unknown>, dirtyPaths: Set<string>): void;
  onVariantChange(id: string): void;
  onSubmit(draft: Record<string, unknown>): void;
  onCancel(): void;
};
```

- The editor does not navigate and does not render `ObjectPage`.

- [ ] **Step 1: Write failing state tests**

Cover Edit clone, Save validation, Cancel restoration, status-lock disablement, hidden-field retention,
missing projection merge without dirty overwrite, line add/remove, and no mutation of query data.

- [ ] **Step 2: Implement the controlled editor**

Render header facets, General form, struct sections, and collection tables from the active variant.
Use profile capabilities for editability and required fields.

- [ ] **Step 3: Upgrade the standalone shell**

Own query/refetch, title/header/footer, draft state, and variant-driven projection. Keep submit as a
callback boundary until Phase 3 supplies durable writes.

- [ ] **Step 4: Run the Phase 2 gate**

```powershell
bun test apps/web/src/components/EntityObjectEditor.test.ts apps/web/src
bun run build:web
```

Expected: existing quotation, order, Item, and BusinessPartner shapes can display/edit locally with
no synchronous write call.

---

## Phase 3: Generic durable writes

### Task 9: Persist and report create capabilities

**Files:**
- Create: `apps/agent/src/write-capabilities.ts`
- Create: `apps/agent/test/write-capabilities.test.ts`
- Create: `apps/server/test/write-capabilities.test.ts`
- Create: `docs/sap-b1-durable-writes.md`
- Modify: `packages/db/src/schema/tenant.ts:14-24`
- Modify: `apps/server/src/orpc/routers/sync.ts:44-62`
- Modify: `apps/server/src/orpc/routers/entities.ts`
- Modify: `apps/agent/src/index.ts:7-80`
- Generate: `packages/db/drizzle/*write-capabilities*`

**Interfaces:**
- Produces:

```ts
export type WriteCapability = { entity: string; dedupField: string };
export function parseWriteCapabilities(value: string | undefined): WriteCapability[];
export function validateWriteCapabilities(
  configured: WriteCapability[],
  schemas: EntitySchema[],
): { valid: WriteCapability[]; errors: string[] };
```

- Adds `tenant_integration.write_capabilities jsonb` and
  `write_capabilities_checked_at timestamptz`.
- Adds authenticated `sync.heartbeat({ capabilities })` and
  `entities.capabilities({ entity })`.

- [ ] **Step 1: Write failing parser/freshness tests**

Cover malformed pairs, duplicates, missing entity/UDF, stale report, current report, and an update
remaining allowed when create capability is absent.

- [ ] **Step 2: Add schema columns and generate the migration**

Run:

```powershell
bun --cwd packages/db drizzle-kit generate --name write-capabilities
```

Inspect the generated SQL: it must add only the two nullable capability columns and Drizzle metadata.
Do not apply it to a non-test database as part of this task.

- [ ] **Step 3: Implement agent configuration and heartbeat**

Parse:

```text
B1_CREATE_CAPABILITIES=Quotations:U_HERA_DedupKey,Orders:U_HERA_DedupKey
```

Validate against parsed EDMX at startup and after metadata refresh. Report only valid pairs.

- [ ] **Step 4: Implement server freshness/capability output**

Persist the authenticated report and timestamp. Return explicit create disable reasons: no profile,
agent offline/stale report, entity not reported, or UDF mismatch.

- [ ] **Step 5: Write the operator runbook**

Document UDF/index requirements for each enabled SAP document table, the env syntax, startup
validation, a duplicate-key smoke check in a designated test company, and mandatory post-upgrade
re-verification. State clearly that Service Layer cannot inspect index uniqueness.

- [ ] **Step 6: Run the focused gate**

```powershell
bun test apps/agent/test/write-capabilities.test.ts apps/server/test/write-capabilities.test.ts
bunx tsc --noEmit -p packages/db/tsconfig.json
```

Expected: capability parsing, reporting, freshness, and migration shape pass.

### Task 10: Enqueue, watch, and fence generic write commands

**Files:**
- Create: `apps/server/src/writes.ts`
- Create: `apps/server/test/entity-writes.test.ts`
- Modify: `packages/db/src/schema/agent-request.ts:5-38`
- Modify: `apps/server/src/orpc/routers/entities.ts:39-65,192-204`
- Modify: `apps/server/src/orpc/routers/sync.ts:20-119`
- Reuse: `packages/db/src/listener.ts:42-70`

**Interfaces:**
- Produces:

```ts
export type WritePayload = {
  operation: "create" | "update";
  entity: string;
  key?: string;
  data: Record<string, unknown>;
  commandId: string;
  idempotency?: { field: string; value: string };
  origin?: {
    kind: "config-document";
    projectId: string;
    runId: string;
    selectionVersion: number;
  };
};
export type WriteState = {
  requestId: string;
  status: "pending" | "in_flight" | "done" | "failed";
  result?: unknown;
  docEntry?: string;
  error?: string;
};
export type WriteResult = {
  key: string;
  record: Record<string, unknown>;
};
```

- Browser input never contains `idempotency.field` or a trusted `origin`; server derives both.
- `entities.write` returns `{ requestId }`.
- `entities.watchWrite` yields `WriteState`.
- Agent callbacks include `{ id, attempt }`.

- [ ] **Step 1: Write failing enqueue/watch/fencing tests**

Cover:

```ts
// same tenant/entity/commandId returns the same request
// caller-supplied unknown/write-protected fields are rejected
// create disabled without a fresh matching capability
// stale attempt cannot ack/nack/fail a newer lease
// watcher emits current state immediately and after notification
```

- [ ] **Step 2: Implement profile-derived command normalization**

Strip computed/read-only fields and UI-only keys such as `priceSource`/local row ids, retain allowed
header/collection changes, inject the dedup UDF for create, and require the known key for update.
Set:

```ts
dedupKey = `write:${entity}:${commandId}`;
```

- [ ] **Step 3: Enqueue atomically**

Insert-or-select the tenant-scoped dedup row and `pg_notify(outboxChannel(tenantId), '')` in one
transaction. Return immediately; never call `runRequest` for writes.

- [ ] **Step 4: Implement attempt-fenced callbacks**

`ack`/`nack` update only:

```sql
WHERE id = :id
  AND tenant_id = :tenant
  AND status = 'in_flight'
  AND attempts = :attempt
```

Ack stores confirmed result/key and notifies the request channel. Keep `fulfill`/`fail` only for read
request-reply kinds.

- [ ] **Step 5: Implement the SSE watcher**

Read tenant-scoped state, yield it immediately, then wait on `requestChannel(id)` in a loop until done,
failed, or the client disconnects.

- [ ] **Step 6: Run the focused gate**

```powershell
bun test apps/server/test/entity-writes.test.ts apps/server/test/scoping.test.ts
bunx tsc --noEmit -p apps/server/tsconfig.json
```

Expected: dedup, authorization, attempt fencing, and event delivery pass.

### Task 11: Deliver and confirm writes on the agent

**Files:**
- Create: `apps/agent/src/write-sync.ts`
- Create: `apps/agent/test/write-sync.test.ts`
- Modify: `apps/agent/src/service-layer-client.ts:328-342`
- Modify: `apps/agent/src/sync.ts:7-91`
- Modify: `apps/agent/src/index.ts:56-80`

**Interfaces:**
- Produces:

```ts
export async function processWrite(
  request: RequestRow & { attempts: number; dedupKey: string },
  sl: WriteServiceLayerPort,
  cloud: WriteCloudPort,
): Promise<void>;
```

- Service Layer port includes `createEntity`, `updateEntity`, `getEntity`, and
  `findByDedup(entity, field, value, resultKey)`.

- [ ] **Step 1: Write the delivery matrix as failing tests**

Add separate tests for:

1. First create: POST, confirm GET, ack.
2. Retry found: GET, no POST, ack.
3. Retry absent: GET, one POST, confirm, ack.
4. Unique conflict: GET exactly one, ack.
5. Unique conflict with zero/multiple matches: permanent nack.
6. Update without collection changes: PATCH, GET, ack.
7. Update with collection changes: PATCH with `B1S-ReplaceCollectionsOnPatch: true`, GET, ack.
8. Ambiguous timeout/5xx: transient nack.
9. Confirmed validation 4xx: permanent nack.
10. Confirm GET failure: no ack.

- [ ] **Step 2: Add dedicated dedup lookup**

Validate the profile-derived identifier and query at most two rows. Exactly one matching dedup value
is confirmation; zero is absent; two is an invariant failure.

- [ ] **Step 3: Implement `processWrite`**

Use `attempts === 1` for the first-create branch and GET-before-POST for every later attempt. Treat
network ambiguity as transient. Do not treat 409 as success until lookup confirms one record.
For updates, set `B1S-ReplaceCollectionsOnPatch: true` only when the normalized payload contains a
changed collection.

- [ ] **Step 4: Split read and write dispatch**

Read request kinds continue through `processRequest` and `fulfill`/`fail`; `kind === "write"` goes only
through `processWrite` and `ack`/`nack`.

- [ ] **Step 5: Run the focused gate**

```powershell
bun test apps/agent/test/write-sync.test.ts apps/agent/test/sync.test.ts apps/agent/test/service-layer-error.test.ts
bunx tsc --noEmit -p apps/agent/tsconfig.json
```

Expected: every invariant path passes.

### Task 12: Connect the standalone editor to durable writes

**Files:**
- Modify: `apps/web/src/components/EntityObjectPage.tsx`
- Modify: `apps/web/src/components/EntityObjectEditor.tsx`
- Modify: `apps/web/src/objectSpec.ts`
- Create: `apps/web/src/components/EntityObjectWrite.test.ts`

**Interfaces:**
- Uses `entities.write` and `entities.watchWrite`.
- Update `commandId` is stable for one edit draft.
- Create mode remains available to controlled callers only.

- [ ] **Step 1: Write failing write-state tests**

Cover pending/in-flight message strips, Save disablement, permanent failure preserving the draft,
done re-fetch replacing optimistic totals, Cancel before enqueue, and navigation-away not cancelling
the command.

- [ ] **Step 2: Add command-id lifecycle**

Create a UUID when entering edit mode, retain it through retries, and clear it only on cancel before
enqueue or confirmed completion.

- [ ] **Step 3: Submit and watch**

Enqueue the profile-filtered draft, subscribe to the returned request id, and show explicit Pending,
Retrying/In flight, Failed, and Done states. After Done, invalidate/refetch the active projection and
exit edit mode.

- [ ] **Step 4: Run the Phase 3 gate**

```powershell
bun test apps/web/src/components/EntityObjectWrite.test.ts apps/web/src
bun run build:web
bun run build:agent
```

Expected: object updates no longer call synchronous `entities.update`.

---

## Phase 4: Configurator quotation creation

### Task 13: Fence selections and build a server-authoritative quote draft

**Files:**
- Create: `apps/server/src/config-quote.ts`
- Create: `apps/server/test/config-quote.test.ts`
- Modify: `apps/server/src/orpc/routers/configs.ts:294-334,363-393`
- Modify: `apps/server/src/orpc/routers/portal.ts:347-362`
- Modify: `packages/db/src/schema/configurator.ts:41-95`
- Modify: `apps/server/src/writes.ts`
- Modify: `apps/server/src/orpc/routers/sync.ts`

**Interfaces:**
- Produces:

```ts
export function configDocumentCommandId(input: {
  tenantId: string;
  projectId: string;
  runId: string;
  selectionVersion: number;
}): string;
export function buildQuoteSeed(project: ConfigProject, run: ConfigRun): Record<string, unknown>;
```

- Adds `configs.quoteDraft({ projectId })`.
- Adds `configs.createQuote({ projectId, runId, selectionVersion, data })`, which derives command id,
  origin, entity, and dedup field server-side.
- Adds an internal `completeWriteOrigin(tx, payload, confirmed)` helper called inside the existing
  Drizzle transaction so its transaction type is inferred from the callback.

- [ ] **Step 1: Write failing fencing/seed/completion tests**

Cover:

- Selection pair must exist in the stored candidate/batch list.
- Duplicate candidate/batch pairs are rejected.
- `expectedSelectionVersion` must match under `FOR UPDATE`.
- `draft`, `rejected`, and `quoted` cannot enqueue a quote.
- `calculated` and `requested` may transition to quoted.
- Pending/in-flight config writes block update/run/select.
- Quote seed maps customer, currency fallback, `quoteItemCode`, quantity, and recomputed initial price.
- Repeated ack cannot append duplicate events.
- Portal result reads the specifically acknowledged run.

- [ ] **Step 2: Fence configuration mutations**

Add expected version to `configs.select`, lock the run, validate selections, and reject late
update/run/select while a config-document write is pending/in-flight or after project status is
quoted.

- [ ] **Step 3: Build quote seed from persisted data**

Re-run `applySelection` from the immutable model/lookup/run snapshot. Return the canonical initial
draft. On create, accept only profile-writable user edits, then inject the deterministic command id
and dedup UDF.

- [ ] **Step 4: Complete the origin atomically**

In the same successful attempt-fenced ack transaction:

1. Mark request done and store confirmed SAP result/key.
2. Set the exact run's `b1DocEntry` and `quotedAt`.
3. Set project status `quoted`.
4. Append one `quoted` event.
5. Notify the watcher.

If the run/version no longer matches, mark the write done but record an origin-conflict error rather
than mutating a different selection. Fencing should make this branch unreachable in normal use.

- [ ] **Step 5: Run the focused gate**

```powershell
bun test apps/server/test/config-quote.test.ts apps/server/test/configurator.test.ts apps/server/test/transitions.test.ts
```

Expected: stable command identity, mutation fencing, seed mapping, and atomic completion pass.

### Task 14: Embed the shared editor in `StepCreateQuote`

**Files:**
- Create: `apps/web/src/components/configurator/StepCreateQuote.tsx`
- Create: `apps/web/src/components/configurator/quoteDraft.ts`
- Create: `apps/web/src/components/configurator/quoteDraft.test.ts`
- Modify: `apps/web/src/components/configurator/ConfigProcessPage.tsx:77-90,206-218,315-331`
- Modify: `apps/web/src/components/configurator/configProcessState.ts:3-27`

**Interfaces:**
- `StepCreateQuote` consumes `configs.quoteDraft`, `configs.createQuote`, and
  `entities.watchWrite`.
- Session key includes tenant host, project id, run id, and selection version.
- The deterministic server command id replaces a random draft id for this caller.

- [ ] **Step 1: Write failing quote-step state tests**

Cover quote-tab eligibility, canonical seed display, one line per persisted selection, draft restore
for matching version, stale draft discard, existing request watch after reload, failure retention,
completion cleanup, and "Open quotation" navigation.

- [ ] **Step 2: Implement session draft helpers**

Persist only editable draft data, deterministic command id, request id, and last status. Accept the
stored value only when run id and selection version match.

- [ ] **Step 3: Implement `StepCreateQuote`**

Render `EntityObjectEditor` directly inside the existing configurator `ObjectPage`. Do not render
another `ObjectPage`. Preserve configurator-seeded prices as `priceSource="config"`; SAP refresh is
explicit.

- [ ] **Step 4: Wire process navigation**

After successful candidate selection, invalidate/refetch the persisted run and navigate to
`?section=quote`. Keep Quote locked until customer, run, non-empty persisted selection, and current
`Quotations:U_HERA_DedupKey` capability are present.

After completion, navigate on demand with:

```ts
navigate({
  to: "/$entity/$id",
  params: { entity: "Quotations", id: String(docEntry) },
});
```

- [ ] **Step 5: Run the Phase 4 gate**

```powershell
bun test apps/web/src/components/configurator/quoteDraft.test.ts apps/web/src/components/configurator/configProcessState.test.ts
bun test apps/server/test/config-quote.test.ts
bun run build:web
```

Expected: the embedded quote step restores safely and creates/watches one generic write command.

---

## Final verification

### Task 15: Run the complete regression and sandbox smoke gates

**Files:**
- Verify: all files above
- Update if behavior changed: `docs/sap-b1-durable-writes.md`

- [ ] **Step 1: Run all repository tests**

```powershell
bun run test:engine
bun run test:server
bun run test:web
bun test apps/agent
bun test packages/db
```

Expected: all pass.

- [ ] **Step 2: Run explicit type checks**

```powershell
bunx tsc --noEmit -p packages/db/tsconfig.json
bunx tsc --noEmit -p apps/agent/tsconfig.json
bunx tsc --noEmit -p apps/server/tsconfig.json
bunx tsc --noEmit -p apps/web/tsconfig.json
```

Expected: zero TypeScript errors.

- [ ] **Step 3: Build both deployable apps**

```powershell
bun run build:web
bun run build:agent
```

Expected: both builds complete.

- [ ] **Step 4: Run read-only SAP smoke checks**

Against the configured sandbox:

- POST metadata returns XML and the parser finds Quotations/DocumentLines/enums.
- Projected quotation fetch returns selected header and line fields plus hidden keys.
- Item context returns Item defaults and `Price/Currency/Discount`.
- No SAP create/update is performed in this read-only smoke step.

- [ ] **Step 5: Run a designated test-company write smoke only after DBA provisioning**

With `Quotations:U_HERA_DedupKey` reported current:

1. Enqueue one test quotation.
2. Confirm one SAP record and one done request.
3. Replay the same command id.
4. Confirm the agent performs lookup without a second POST and SAP still contains one matching
   quotation.
5. Update that record, confirm PATCH+GET, then remove/close it according to the test-company cleanup
   policy.

If the UDF/index is not provisioned, verify create remains disabled and record that external
prerequisite rather than bypassing the gate.
