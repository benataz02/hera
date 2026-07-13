# Configurator improvements — design

Date: 2026-07-13 · Branch: `config-engine` · Source brief: `prompts/configurator-improvements.md`

One spec, two phases. Phase 1 is pure web UI (runtime wizard). Phase 2 touches the
config-engine schema, propagation, and the builder UI. Phase 1 ships first.

## Constraints discovered (UI5 Web Components 2.24)

- `Wizard` has no slot for custom content in its navigation bar; `WizardStep` only exposes
  `titleText` / `subtitleText` / `icon` there. The header must be a CSS overlay.
- `SelectDialog` accepts only list items (~3 visible fields), no Table. A true n-column
  value help must be a hand-built `Dialog` + search + `Table`.
- `Form` supports `headerText`/`header` → section = one `Form`, group = `FormGroup`,
  param = `FormItem`. Sections and groups both survive without ObjectPage/Panel.
- `Table` has no toolbar/title slot (only `features`/`headerRow`/`noData`); toolbars stay
  siblings above the table.
- `PortalRequestPage` reuses `StepConfigure`, `StepBatches`, `StepCandidates` with its own
  4-step arrangement. Step components stay reusable; only `ConfigProcessPage` merges steps.
  The portal keeps its flow and inherits the new form rendering.

## Phase 1 — Runtime wizard restructure

### Steps: 5 → 3

1. **Configure** — form + batch quantities (merges old Configure + Batches).
2. **Candidates** — price matrix + editable outputs (merges old Candidates + Review outputs).
3. **Create quote** — disabled placeholder, unchanged.

### Full height + header

- The standalone header `Bar` is removed. Project name · model name · status render in a
  compact div absolutely positioned over the right side of the wizard navigator row
  (`::part(navigator)` gets padding-right to reserve the space). With 3 steps there is room.
- The "requested" review banner (requester info + Reject button/dialog) stays a strip above
  the wizard — it is an alert, not chrome.
- Step content fills the remaining viewport height and scrolls internally; each step's
  floating bar is pinned at the bottom of the step.

### Step 1 — Configure

- Content: `ExtractPanel`, then the rewritten `ConfiguratorForm`, then batches as one more
  `Form` section at the end ("Batch quantities": Tokenizer + StepInput + Add button —
  reusing today's `StepBatches` internals; the `StepBatches` component itself remains for
  the portal).
- Floating bar (one per step): **left** = consistency line (`✓ Consistent · N open ·
  ~M candidates`, or the conflict message in red) plus the stale-run hint when the last run
  is outdated; **right** = `Calculate` (Emphasized).
- `Calculate` persists entries + batches (as today: `update` then `run`), then lands on
  step 2. Disabled while conflicted, while batches are empty, or while running.

### Step 2 — Candidates

- The price matrix is unchanged (toggle cells = selection, green = lowest per column,
  capped-run message strip).
- Below the matrix, each **selected** cell renders its editable output panel — today's
  `StepReview` panel (BOM + operations, edit/remove/add/reset, per-panel totals footer).
- The read-only `CandidateDetail` row-click view is dropped from this page (the component
  stays; the portal uses its own detail). Row clicks on unselected rows do nothing.
- Floating bar: **left** = grand total across selected lines; **right** = `Save selection`.
- Save semantics unchanged: selection + cleaned overrides → `configs.select`; server
  recomputes from the run snapshot.

### ConfiguratorForm rewrite

- Props: `model`, `lookups`, `entries`, `onChange`. The `layout: "flow" | "page"` prop,
  `ObjectPage`, `ObjectPageSection`, and `Panel` are all removed.
- Rendering: one `Form` per model section (`headerText` = section title, `headerLevel`
  H5-ish), `FormGroup` per group, `FormItem` per visible param. Computed values are a final
  `Form` ("Computed"). Controls (radio/checkbox/multicombo/step/select/input) unchanged in
  Phase 1.
- The consistency/conflict line moves out of the component. A small exported helper
  (e.g. `consistencyLine(prop)`) produces the identical string for all callers:
  `ConfigProcessPage` step bar, `PreviewPane` footer, portal `StepConfigure` footer.

## Phase 2 — Builder lookups: columns, value help, dialogs

### Engine schema (`packages/config-engine/src/model.ts`)

- Query domain refs change shape to reference a named query table:
  `{ source: "query", table: <queryTableName>, valueCol: string, labelCol?: string }` —
  symmetric with table refs. Inline `target`/`path`/`valueField` disappear from refs.
- Both table and query refs gain `columns?: string[]`: extra columns exposed for the
  parameter. Absent = all source columns except `valueCol`; the param dialog lets the user
  trim the list.
- `queryTables` keep their shape (`name`, `target: b1|beas`, `path`, `columns: string[]`)
  and finally get an editor.
- **Breaking change, no migration.** Pre-production: existing models with inline query refs
  must be re-edited; seeds are updated. No migration script.

### Engine behavior

- `propagate` and every expression environment (computed, constraints, BOM, routing,
  pricing — check/enumerate/output) expose each ref column as a derived value named
  `<paramKey>_<column>` (e.g. `material_density`), resolved by looking up the selected
  value's row in the source table/query — an auto-generated LOOKUP. Underscore naming: the
  DSL has no dot notation.
- Derived values are recomputed, never stored in `entries`. Run snapshots already freeze
  `lookupSnapshot`, so pricing stays reproducible.
- `check.ts` new issues: unknown table/query name in a ref; unknown column in a ref;
  derived-name collision with an existing parameter or computed key.

### Runtime controls (`ConfiguratorForm`)

- **Query-sourced param** → read-only `Input` with value-help icon opening a custom
  **ValueHelpDialog**: `Dialog` + search field + UI5 `Table` (key + display columns as
  headers), single-select row, OK/Cancel. Search filters client-side over the
  already-resolved lookup rows (server resolves + caches lookups as today).
- **Table-sourced param** → keeps `Select`; extra columns join into each `Option`'s
  `additionalText` with " · ". Accepted limitation: Select has no real columns; the value
  help is the n-column experience.

### Builder UI

- **TablesTab** receives `draft`/`update` and shows two lists in the left rail: tenant-level
  "Lookup tables" (unchanged editor) and "Queries (this model)" — editor for name, target,
  path, columns, with the existing preview-options pattern. All table/query definition
  lives here.
- **ParamDialog** regrouped into: **Basics** (key, label, type, control, unit) /
  **Domain** (source: none · manual · table · query · range; for table/query: named source
  picker, value column, label column, display-columns MultiComboBox defaulting to all) /
  **Behavior** (default expr, visible when, required when) / **Help** (help text,
  extraction hint). Inline path/valueField editors are gone.
- **ParamsTab "Form structure" bar** stays a sibling `Bar` directly above the structure
  table, styled flush (zero gap, shared border) so it reads as the table's toolbar — UI5
  `Table` has no toolbar slot.

## Testing

- Engine: unit tests for derived-value resolution (table + query refs, missing row →
  null/absent, collision issues in `check.ts`), reusing the existing engine test style.
- Web: existing `runView`/`structureOps` test suites stay green; ValueHelpDialog gets a
  small interaction test only if a web test harness already exists (none today — manual
  verification via the dev server otherwise).

## Out of scope

- Portal wizard flow changes (it keeps 4 steps; inherits ConfiguratorForm rendering).
- Migration tooling for old query refs.
- Server-side search for value help (client-side filter over resolved rows is enough at
  current lookup sizes; revisit if a query returns thousands of rows).
