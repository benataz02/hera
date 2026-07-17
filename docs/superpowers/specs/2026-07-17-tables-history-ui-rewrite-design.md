# TablesTab + HistoryTab UI rewrite — design

Date: 2026-07-17
Scope: `apps/web/src/components/configurator/TablesTab.tsx`, `HistoryTab.tsx`, new `QueryEditor.tsx`.
Presentation-only rewrite: all state logic, oRPC calls, mutation flow, paste/typed-cell logic, and
`issueFor` validation wiring stay behaviorally identical.

## Decisions (from brainstorming)

- **Layout**: card-based sections (`Card` + `CardHeader`) on `var(--sapBackgroundColor)`, stacked
  with 1rem gap. TablesTab editor max-width 64rem; HistoryTab 56rem.
- **Query editor**: monospace growing `TextArea` (`growing`, `growingMaxRows={6}`) with example
  placeholder — replaces the single-line `Input` for OData/SQLQueries paths in both tabs.
- **Rows grid**: keep inline cell editing (Input per cell), paste-from-spreadsheet, delete row action.
- **HistoryTab**: numbered cards (1–5), all always visible; later cards show an inline hint until
  prerequisites exist (e.g. "Run Test fetch in step 2 first").

## Shared component: `QueryCard` (`QueryEditor.tsx`)

Replaces the inline query editor in TablesTab **and** the `QueryTestFetch` export HistoryTab imports
today (that export is deleted). One card containing:

- `CardHeader`: title + target `Select` (B1/Beas) as header action; optional extra header actions
  (Remove/Delete supplied by the caller).
- Body: monospace growing `TextArea` for the path.
- Footer row: `Test fetch` button + `Tag` for fetch state (`✓ N columns` / error message via
  `MessageStrip`).
- Result preview inside a collapsed `Panel` ("Preview — N rows") with the existing read-only table.

Props: `{ target, path, columns, onChange(patch), title?, headerActions? }` — shaped so both tabs
pass their existing state through unchanged.

## TablesTab

- **Sidebar** (~17rem): one `List` with two `ListItemGroup`s ("Lookup tables", "Queries — this
  model"), selected item highlighted, `+` new-item buttons, one-line hint when a group is empty.
- **Empty state** (nothing selected): `IllustratedMessage`.
- **Table editor**: header `Toolbar` (name Input, Save, Delete) → Card: Columns (key/label/type
  rows on a labeled grid, Add column in card header) → Card: Rows (inline-editable grid, row count
  in header, paste tip as subtitle, paste hint prominent when empty).
- **Query editor**: name field + Delete in a header toolbar, then the shared `QueryCard`, then the
  "columns = first is key, second is label" status line.

## HistoryTab

Numbered cards, single column:

1. **Exact help** — item-code param `Select`; explanatory text as card subtitle.
2. **History query** — shared `QueryCard` with Remove in header; body is just the "Add history
   query" button when `h.query` is unset.
3. **Parameter mappings** — existing table (param/column/match/weight) in a card; hint
   `MessageStrip` in the body when no columns are fetched yet.
4. **Display columns** — `MultiComboBox` with a `Label`.
5. **Data** — Sync button, `Tag` row count, last-synced text, `dirty` hint.

Validation `MessageStrip`s render inside the card the issue belongs to (same `issueFor` paths).

## Component availability (verified against installed @ui5/webcomponents-react 2.23.1)

`Card`, `CardHeader`, `TextArea`, `IllustratedMessage`, `Tag`, `Panel`, `Toolbar` family,
`SegmentedButton` all present. `ObjectStatus` is **not** in the 2.x wrapper set — use `Tag`.

## Testing

Visual/manual: run the web app, open the model builder Tables and History tabs, exercise
create/edit/paste/test-fetch/save/delete and the history mapping flow. No new unit tests — no new
logic is introduced.
