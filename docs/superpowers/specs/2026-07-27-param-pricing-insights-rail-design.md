# Per-parameter pricing + the insights rail

Date: 2026-07-27
Branch: `claude/configurator-ui-improvements-4zjskv`

## Problem

A model's price is currently produced in exactly one place — `computeOutputs` in
`packages/config-engine/src/output.ts` — from BOM lines and routing operations, and only *after*
a run has enumerated candidates. While filling the form the user sees no money at all: no
indication that picking a coating adds 85 € or that a 1200 mm cut is the expensive choice. The
first number appears on the Candidates tab, after Calculate.

Separately, `ConfigProcessPage` puts its supplementary content (B1 document history, similar past
configurations) in a `SplitterLayout` pane behind a "History" toggle, with a hand-rolled
flex-basis slide animation (`PANE_ANIM`, `animating`, `paneOverride`).

## Goal

1. A parameter can carry a **price formula**; its result shows at the top-right of that field.
2. A parameter can be flagged **read-only**.
3. The **cost elements** for the whole configuration are listed in a card, alongside Documents
   and Similars, in a persistent right-hand rail.
4. The rail replaces the splitter and its toggle.

## Non-goals

- **Parameter prices do not enter the calculated price.** `unitCost` stays `materialPerUnit +
  laborPerUnit`; `pricing.priceExpr` is untouched. These figures are an informational read-out,
  not a third cost bucket. (Decided explicitly — the alternative would have rippled through
  `computeOutputs`, the candidates matrix, the run snapshot and the server.)
- No server, oRPC, or DB change. `ModelDefZ` gains optional fields only, so persisted models
  parse unchanged.
- No cost-elements card in the model builder's preview pane. The per-field badges already let you
  test formulas while editing.
- Currency conversion. The currency is a display label; every number is in it already.

## Key constraint discovered

`ObjectPage` collects sub-tabs from **direct children only**
(`ObjectPage/index.js:682`, v2.24.1):

```js
const subTabs = safeGetChildrenArray(section.props.children)
  .filter(s => isValidElement(s) && s?.type?.displayName === 'ObjectPageSubSection');
```

So a side rail placed *inside* `ObjectPageSection id="configure"` would have to wrap the
subsections, and Configure would silently lose its sub-anchor tabs (General · each model section ·
Batch quantities). Keeping the sub-tabs therefore requires the rail to sit **outside** the
`ObjectPage`, wrapping it. That is also the Fiori-prescribed arrangement: `DynamicSideContent`
exists for content that is "relevant … but not critical for users to complete a task", and the
ObjectPage floorplan has no side area of its own.

---

## 1 · Schema — `packages/config-engine/src/model.ts`

```ts
// ParamZ
priceExpr: z.string().optional(),
readonly: z.boolean().optional(),

// ModelDefZ.pricing
currency: z.string().optional(),
```

`currency` is **optional, not `.default("EUR")`**. A zod default lands in the inferred output type
as a required field, which would force a new key into all 15 `ModelDef` literals across tests,
seeds, `portal.ts`, `usePreviewLookups.ts` and `ModelBuilderPage`'s `EMPTY_MODEL`. One `?? "EUR"`
inside `money()` — the single formatting site — beats 13 edits.

`check.ts` gets one line beside the sibling expression checks:

```ts
checkExpr(p.priceExpr, `parameters[${i}].priceExpr`, base);
```

Scope is `base`, **not** `withQty`/`pricingScope`: the badge is a per-unit figure shown before any
batch exists, so `qty` and `unitCost` are legitimately out of scope. `tabOf` already routes
`parameters[*]` to the Parameters tab, so a bad formula raises the tab's issue count with no
further wiring.

## 2 · Model builder

**`ParamsTab.tsx` → `ParamDialog`**, in the existing *Behavior* group: an `ExprInput optional` for
*Price formula* and a `CheckBox` for *Read-only*. Matches the neighbouring `defaultExpr` /
`visibleWhen` / `requiredWhen` fields, which pass no `issue` prop — errors surface through the tab
counter rather than inline.

**`SettingsTab.tsx`**, in the *Pricing* group: one `Input` for *Currency*, placeholder `EUR`.
Free text, because B1 currency codes are free text.

## 3 · `costElements.ts` (new)

The single source both the badges and the card read, so they cannot disagree.

```ts
export type CostElement = { key: string; label: string; amount: number };

export function money(n: number, currency = "EUR"): string {
  try { return new Intl.NumberFormat(undefined, { style: "currency", currency }).format(n); }
  // currency is free text a user typed in Settings — never let it throw the form away
  catch { return `${n.toFixed(2)} ${currency}`; }
}

export function paramPrices(model: ModelDef, prop: Propagation, tables: ResolvedLookups["tables"]): CostElement[] {
  const out: CostElement[] = [];
  for (const p of model.parameters) {
    if (!p.priceExpr || !prop.visible[p.key]) continue;
    try {
      const v = evaluate(p.priceExpr, { vars: prop.values, tables });
      if (typeof v === "number" && Number.isFinite(v)) out.push({ key: p.key, label: p.label, amount: v });
    } catch { /* undecidable while inputs are open — same silence as every other expr here */ }
  }
  return out;
}
```

Hidden parameters are skipped: a field the rules have switched off must not bill for itself.
Non-numeric and unevaluable results are skipped rather than shown as errors, matching how
`bindings()` already treats a formula whose inputs are not yet bound.

## 4 · Price badge and read-only — `ConfiguratorForm.tsx`

`FORM_PROPS` sets `labelSpan: "S12 M12 L12 XL12"`, so each label already occupies its own
full-width row directly above its control — the right end of that row *is* the input's top-right
corner. `labelContent` becomes a flex row: `<Label>` left, `<ObjectStatus>` right.

```
Cutting length (mm)                    85,00 €
┌──────────────────────────────────────────┐
│ 1200                                  ▲▼ │
└──────────────────────────────────────────┘
```

`paramPrices` is called once per render and indexed into a `Map<key, amount>`.

**Read-only maps to the native `readonly` prop, not `disabled`.** Verified present on every
control this form renders — `Input`, `Select` (since v1.21), `MultiComboBox`, `StepInput`,
`CheckBox`, `RadioButton`. A read-only field stays focusable, copyable and announced by screen
readers; a disabled one is none of those, and these fields exist precisely to be read.
`ValueHelp` (`apps/web/src/components/ValueHelp.tsx`) gets a one-line `readonly` passthrough
beside its existing `disabled`.

## 5 · The insights rail — `ConfigProcessPage.tsx` + `InsightsRail.tsx` (new)

`DynamicSideContent` replaces `SplitterLayout` at the exact spot the splitter occupies today:

```tsx
<DynamicSideContent sideContentVisibility="AlwaysShow" hideSideContent={step === 2}
  sideContent={<InsightsRail open={openPanels} onToggle={toggle} … />}>
  <ObjectPage mode="IconTabBar" …>   {/* untouched — sub-tabs intact */}
</DynamicSideContent>
```

```
[Configure] [Candidates] [Create quote]
┌─ ObjectPage ───────────────────┐┌─ side ─────┐
│  General                       ││ ▼ Costs    │
│  Dimensions                    ││   Cutting  │
│  Finish                        ││   Coating  │
│  Batch quantities              ││   ─────────│
│                                ││   1.240 €  │
│                                │├────────────┤
│                                ││ ▶ Documents│
│                                │├────────────┤
│ [✓ Consistent]     [Calculate] ││ ▶ Similars │
└────────────────────────────────┘└────────────┘
```

`hideSideContent={step === 2}` scopes the rail to Configure and Candidates using state that
already exists. `DynamicSideContent` handles the responsive behaviour itself — the rail drops
below the main content on narrow viewports — so no media queries and no animation code.

Three `Panel`s, not custom cards: `collapsed` and `onToggle` are native, and `fixed` on a panel
that is the only open one enforces **at least one always expanded** with no accordion state
machine:

```ts
const [openPanels, setOpenPanels] = useState(new Set(["costs"]));
const toggle = (k: string) => setOpenPanels((o) => {
  if (!o.has(k)) return new Set(o).add(k);
  if (o.size === 1) return o;                      // last one open — Panel's `fixed` blocks this anyway
  const n = new Set(o); n.delete(k); return n;
});
// <Panel collapsed={!openPanels.has(k)} fixed={openPanels.has(k) && openPanels.size === 1} …>
```

State lives in `ConfigProcessPage` so switching Configure ↔ Candidates does not reset it.

`HistoryPane.tsx` loses its `TabContainer` wrapper and exports `DocHistory` and `Similar`
directly, which become the Documents and Similars panels. `DocHistory`'s existing `paneOpen` prop
— which gates the live B1 agent query — becomes "the Documents panel is expanded", preserving the
rule that nothing nobody is looking at generates agent traffic.

**Deleted:** `SplitterLayout`, `SplitterElement`, `paneOverride`, `paneOpen`, `animating`,
`PANE_ANIM`, `onTransitionEnd`, and the History `ToggleButton`.

## 6 · Verification

`costElements.test.ts` (bun test, alongside the existing `exprHelpers.test.ts` /
`formHelpers.test.ts`):

- two priced parameters and a set of entries → the expected rows and total
- a parameter whose `priceExpr` yields a string → skipped, not thrown
- a parameter hidden by `visibleWhen` → excluded from the total
- `money(85, "XYZ")` with an invalid code → falls back instead of throwing

That is the whole non-trivial branch surface; the rest is markup.

## Files

| File | Change |
|---|---|
| `packages/config-engine/src/model.ts` | `priceExpr`, `readonly`, `pricing.currency` |
| `packages/config-engine/src/check.ts` | one `checkExpr` line |
| `apps/web/src/components/configurator/costElements.ts` | **new** |
| `apps/web/src/components/configurator/costElements.test.ts` | **new** |
| `apps/web/src/components/configurator/InsightsRail.tsx` | **new** |
| `apps/web/src/components/configurator/ConfiguratorForm.tsx` | badge + `readonly` |
| `apps/web/src/components/configurator/ParamsTab.tsx` | two dialog fields |
| `apps/web/src/components/configurator/SettingsTab.tsx` | currency input |
| `apps/web/src/components/configurator/ConfigProcessPage.tsx` | rail replaces splitter |
| `apps/web/src/components/configurator/HistoryPane.tsx` | drop `TabContainer`, export both panes |
| `apps/web/src/components/ValueHelp.tsx` | `readonly` passthrough |

No server, oRPC, DB or agent files.

## Assumption flagged for review

`PortalRequestPage` renders the same `ConfiguratorForm`, so **the price badge will also appear to
portal customers.** This spec treats that as intended — the field-level figure is a *price*
(the user's word), and per-option pricing is normal customer-facing CPQ behaviour. If these are
meant as internal cost, the fix is a `showPrices?: boolean` prop on `ConfiguratorForm` that the
portal passes `false`; say so before implementation and it costs one line.
