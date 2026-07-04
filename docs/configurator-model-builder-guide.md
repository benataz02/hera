# Configurator Model Builder — User Guide

The Model Builder is where an **admin** defines a configurable product: the questions a
salesperson answers, the rules between those answers, and the bill of materials, routing and
price that fall out of them. You build against a **live test-drive** — the right-hand pane is
the real configurator running your unsaved draft on every keystroke, so you always see exactly
what a user will see.

> **Who can use it:** organization **owners/admins** only. The "Configurator models" item in the
> side navigation is hidden for regular members, and the server enforces the same boundary.

---

## 1. Getting in

1. Sign in and open your tenant (e.g. `acme.lvh.me`).
2. In the left navigation, click **Configurator models** (below Settings).
3. You land on the **models list**. Click **New model**, give it a name, **Create** — you're
   dropped straight into the builder for the new model.

To edit an existing model, click its row. To delete one, use the row's delete action. A model
that is already used by a saved configuration can't be deleted — you'll get a message saying so.

A brand-new model starts minimal but valid: one empty section, a default price of `unitCost * 1.2`,
and batch sizes `1, 10, 100`. Nothing is required until you add it.

---

## 2. The builder at a glance

```
┌──────────────────────────────────────────────────────────────────────┐
│ Cable assembly        ● Unsaved changes         [▲ 2]   [ Save model ] │  ← header
├───────────────────────────────┬──────────────────────────────────────┤
│ Parameters Rules BOM Routing … │  Live preview            [Reset]      │
│                               │                                        │
│   (the editor for the         │   (the actual configurator form,       │
│    selected tab)              │    running the real engine on your     │
│                               │    current draft)                      │
│                               │                                        │
│                               │  ✓ Consistent · 3 open · ~24 candidates│  ← status line
└───────────────────────────────┴──────────────────────────────────────┘
```

**Header:**
- **Model name** and an **"Unsaved changes"** marker when the draft differs from what's saved.
- **Message button `[▲ N]`** — the number of problems in the whole model. Click it to see the
  list; click any item to jump to the exact field that's wrong.
- **Save model** — **disabled while the model has any errors** or when there's nothing to save.
  If it's green, the model is valid and the save cannot be rejected.

**Tabs** each carry a red badge with a count when that tab contains errors, so you always know
where to look.

**Live preview (right):** the same form your users get, driven by your draft. The **status line**
at the bottom answers one question continuously:

- `✓ Consistent · N open · ~M candidates` — the model is coherent; `N` params still unanswered,
  roughly `M` valid combinations remain.
- A red strip instead — the current selections conflict; the message names the rule.

Use **Reset** to clear the test-drive's answers and start poking at it fresh.

> While the draft has errors, the preview keeps showing the **last valid version** (with a hint),
> so one half-typed expression never blanks your test-drive.

---

## 3. Expression fields

Many fields are **expressions**, not plain values — they're shown in a monospace font. An
expression can reference parameters, computed values, and functions.

- **Errors are underlined precisely.** Type `unitCost *` and the field turns red with
  `expected … — at «end»`; the message button counts it; Save is blocked until you fix it.
- **Suggestions.** As you type an identifier, a popover offers matching parameters, computed
  values, and functions (`IF`, `MIN`, `MAX`, `ROUND`, `CEIL`, `FLOOR`, `ABS`, `CONCAT`, `HAS`,
  `LOOKUP`). Click one to complete it; functions insert an opening `(`.

**What's in scope depends on the field:**

| Field | Can reference |
|-------|---------------|
| Computed values, constraints, parameter defaults/visibility | parameters + computed values |
| BOM and routing expressions | the above **+ `qty`** (the batch size) |
| Unit price expression | the above **+ `qty` + `unitCost`** |

Examples:
- Quantity: `cross_section * 0.01`
- Item code (a string expression): `material == "steel" ? "CBL-STL" : "CBL-ALU"`
- Price from a table: `LOOKUP("prices", "material", material, "price_per_mm2")`

---

## 4. Parameters tab — the form your users fill in

This tab defines both **what** users answer and **how it's laid out**.

### Structure

The form is a tree: **sections → groups → parameters**. Build it top-down:

1. **Add section** → **Add group** (adds to the last section) → **Add parameter**.
2. **Rename** a section or group by clicking its edit action and typing a new title.
3. **Reorder / move** by dragging rows. The drop marker only appears on **legal** targets:
   - a **parameter** can drop *into* a group, or before/after another parameter;
   - a **group** can drop *into* a section, or before/after another group;
   - a **section** can reorder before/after another section.
4. **Delete** a row with its delete action. Deleting a **group or section** keeps its parameter
   *definitions* — they just become unplaced (see below).

If a parameter isn't in any group, a yellow strip lists it: *"Not shown on the form: … — drag
them into a group or edit them to place them."* Unplaced parameters don't appear to users.

### Adding / editing a parameter

The parameter dialog captures:

- **Key** — a valid identifier (letters, digits, underscore; can't start with a digit). This is
  what expressions reference. It's fixed once created.
- **Label** — what the user sees.
- **Type** — `string`, `number`, or `boolean`.
- **Control** — how it's rendered: `input`, `select`, `radio`, `checkbox`, `multicombo`, `step`.
- **Place in** — which group it goes into (new parameters only).
- **Value domain** — where its allowed values come from (see below).
- **Default (expression)**, **Visible when**, **Required when** — optional expressions.
- **Unit** and **Help text** — optional display hints.

### Value domains

The **domain** decides which values are offered:

| Domain | Use it for | You provide |
|--------|-----------|-------------|
| **None (free entry)** | open text/number | nothing |
| **Manual list** | a fixed short list | value + optional label rows (numeric values stay numeric) |
| **Table** | values from a lookup table | table name, value column, optional label column |
| **Query (B1/Beas)** | values pulled live from SAP | target (B1/Beas), OData path, value field, optional label field |
| **Number range** | a bounded number | min, max, step |

For **manual/table/query** domains, click **Preview options** to resolve the source live and see
the first 20 results — the same resolution a real run uses. If the on-prem agent is offline (for
query domains), you'll see that message here instead.

### Computed values

Below the structure, **Computed values** are named expressions derived from parameters (e.g.
`area = cross_section * 1.1`). They're read-only in the preview and usable anywhere a parameter
key is. Add, rename, edit, or delete them here.

---

## 5. Rules tab — relationships between answers

Two kinds of rules:

### Expression constraints

Each row is: **When (optional)** · **Must hold** · **Message**.

- *Must hold* is a boolean expression that has to be `true` for a valid configuration, e.g.
  `material == "alu" ? cross_section >= 16 : true`.
- *When* limits the rule to certain configurations (leave empty to always apply).
- *Message* is shown to the user when the rule is violated.

A typo'd identifier turns the field red, badges the Rules tab, and the message button jumps you
straight to it.

### Combination tables

For "these specific combinations are (dis)allowed" logic that's easier as a grid than a formula:

1. **Add combination table**, then in the dialog pick **2+ parameters** (only parameters with a
   finite domain — selects, manual lists, or booleans — are eligible).
2. Choose a **mode**: **Forbid these** (block the listed rows) or **Allow only these** (nothing
   outside the list is permitted).
3. **Add row** and fill each cell. Cells with a known option list become dropdowns; otherwise
   they're free entry. Leave a cell as `—` to mean "any value".

Example: forbid `material = alu` together with `coating = silicone`.

In the live preview, a value made impossible by a constraint or combination table appears
**greyed out** with the rule's name in its tooltip, and the candidate count updates immediately.

---

## 6. BOM & Routing tabs — what it costs

These are **"150%" definitions**: list every line that *could* apply, and let each line's
**condition** decide whether it applies to a given configuration.

**BOM** — each line has:
- **Id** (stable handle), **Item code** (expression), **Description** (optional),
- **Condition** (optional; empty = always), **Qty per unit**, **Unit price**, **Scrap %**.

Item, qty and price are expressions with parameters and `qty` in scope, so:
`qty = cross_section * 0.01`, `price = LOOKUP("prices", "material", material, "price_per_mm2")`.

**Routing** — each operation has **Resource**, **Condition**, **Setup (min)**, **Run/unit (min)**,
**Rate/hour**. Times and rate are expressions; setup is amortized across the batch by the engine.

Break an expression and the tab badges + the save gate stop you, pointing at the exact token —
e.g. `LOOKUP("nope", …)` flags *unknown table 'nope'* on the literal.

---

## 7. Tables tab — reusable lookup data

Tenant-wide lookup tables that `LOOKUP()` and **Table** domains reference by name. They're saved
**independently** of the model, so several models can share one table.

1. Click **＋** to create a table, or pick one from the list to edit it.
2. Give it a **name** (this is what expressions reference).
3. Define **columns** — key, label, and type (`string`/`number`/`boolean`).
4. Add rows manually, or **paste straight from a spreadsheet** — copy cells in Excel/Sheets and
   paste anywhere in the grid; each column's type is applied automatically.
5. **Save table.** New/renamed tables are picked up by the builder immediately (validation and
   the domain pickers see them right away). A duplicate name is rejected with a message.

---

## 8. Settings tab — the model's frame

- **Name** — the model's display name.
- **Default batch sizes** — comma-separated positive integers (e.g. `1, 10, 100`) offered when a
  configuration is created. At least one is required.
- **Unit price expression** — how the sell price is derived, with `unitCost` and `qty` in scope
  (e.g. `unitCost * 1.4`).
- **Quote item code** — the SAP item code the resulting quote line uses.
- **Query tables** — B1/Beas datasets snapshotted for `LOOKUP()` and table domains: a **name**,
  **target** (B1/Beas), OData **path**, and the **columns** to keep.

---

## 9. Saving

When the model is valid (**message button green, no tab badges**), **Save model** is enabled.
Saving runs the same validation on the server, so a green save can't be rejected for model
errors. After saving, "Unsaved changes" clears; reload the page any time — your model persists.

If you left something broken, open the **message button**, click a problem to jump to its field,
fix it, and Save lights up.

---

## Quick reference

| I want to… | Go to |
|------------|-------|
| Ask the user a question | **Parameters** → Add parameter |
| Offer a fixed list of choices | Parameter → domain **Manual list** |
| Offer choices from SAP | Parameter → domain **Query**, or a **Query table** in Settings |
| Offer choices from a spreadsheet | **Tables** tab → create table → Parameter → domain **Table** |
| Enforce a rule between answers | **Rules** → Add constraint (or combination table) |
| Add a material / price line | **BOM** → Add line |
| Add a labor step | **Routing** → Add operation |
| Set the sell price / batch sizes | **Settings** |
| See what the user will see | The **Live preview** pane (always on) |
