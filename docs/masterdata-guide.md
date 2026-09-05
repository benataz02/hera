# Masterdata — the tables models read

**Masterdata** is where the values behind a configurator model live: price lists you maintain by
hand, and live reads from SAP. It sits in the side navigation under **Configurator**, next to
Configurator models, and is **owner/admin only** — the server enforces the same boundary.

A masterdata table belongs to the workspace, not to a model. Every model that names it reads the
same definition, so a price list is maintained once.

---

## The list

`/masterdata` is a list report: filter, sort and save views like any other list.

| Column | Meaning |
|---|---|
| **Name** | what expressions and domains reference. |
| **Kind** | **Table** (values maintained here) or **Query** (read live from SAP). |
| **Source** | `Maintained here`, or `B1 · Items` for a query. |
| **Columns** / **Rows** | size; a query says `Live` — its rows come from SAP at read time. |

- Click a row to open it.
- Tick rows and press **Delete** to remove several at once. Deletion is immediate and cannot be
  undone: a model that references a deleted name fails its lookups the next time it resolves them
  (names live inside the model document, so nothing can check them for you first).
- **Create** opens an empty table on its own page.

---

## Creating one

**Create** → give it a **name** (this is what `LOOKUP()` and parameter domains reference) and pick
the **kind**. The kind decides which editor you get, and is fixed once saved — the two kinds store
different things, so switching would throw away either your rows or your query. To change kind,
create a new table and delete the old one.

Nothing is written until **Save**. Leaving with unsaved changes prompts first.

### Kind: Table

1. Define **columns** — key, label, and type (`string`/`number`/`boolean`). The first column is
   the lookup key.
2. Add rows manually, or **paste straight from a spreadsheet** — copy cells in Excel/Sheets and
   paste anywhere in the grid; each column's type is applied automatically.
3. **Save**. A duplicate name is rejected with a message.

### Kind: Query

A B1/Beas dataset read live. Five fields, in the order you fill them in:

| Field | What it does |
|---|---|
| **Source** | B1 or Beas. |
| **Entity set** | e.g. `Items`. |
| **Select** | the fields to read, comma-separated — this **is** the `$select`. First field is the key, second the label. Leave it empty and **Test fetch** fills it with every field the response returned; narrow it afterwards. |
| **Filter** | OData `$filter`, e.g. `ItemType eq 'itItems'`. |
| **Sort** | OData `$orderby`. |

**Test fetch** runs the query as defined and previews the first rows — a field name SAP does not
know comes back as its error, so a query that fetches is a query that works. Per-column **labels**
and **value help** visibility are set below; dropping a field from Select drops its label with it.
Reads page at 100 rows and the value help pages on scroll, so there is no page-size setting.

---

## Using one from a model

Both kinds share one namespace: a model references either by name.

- **Parameter domain → Table**: pick the table, its value column and an optional label column.
- **Parameter domain → Query**: pick the query; the first Select field is the key, the second the
  label. The field gets a searchable value help that pages against SAP.
- **`LOOKUP("<name>", "<key column>", <value>, "<result column>")`** in any expression, for either
  kind.

Every other column of the picked row is bound as `<parameter>_<column>` and can be used in
expressions — that is how a price or a weight follows a material choice.

New and renamed tables are picked up by the builder immediately: validation and the domain pickers
see them on the next load. A model only reads the tables it names, so a workspace can hold as many
live queries as it likes without slowing down a model that uses none.
