# Configurador — Business Logic

## 1. State Machine (`Variant.jsx`)

The entire configurator lives in one context with this shape:

```
Variant
├── Parameters: { WhsCode, MetodoMec, FormatoDimension, AnchoFormato, LargoFormato, Adhesivo, Plastico }
├── Calculated: { Formatos, m2formato, PiezasFormato, PiezasFormatoManual }
├── Items[]:    { ItemCode, ItemName, ItemLength, ItemWidth, ItemHeight, Quantity, UnitCost, Price }
├── BOM[]:      { Type(MP|MCP|PLA|ADH), Material, Price, PriceUnit, Quantity, Cost }
├── Operations[]: { OperationId, OpGroup, SetupTime, ProductionTime, ProductionUnit, CostRate, Cost }
├── Cost:       { MaterialCost, OperationsCost, StructureCost%, AuxiliaryCost%, Margin%, TotalCost, Other }
├── ui:         { Montaje, Piezas }
└── _isLoadingVariant  ← guards all reactive effects during hydration
```

---

## 2. Reactive Calculation Pipeline

All effects are debounced 100ms and skip when `_isLoadingVariant` is true.

```
AnchoFormato × LargoFormato
  → m2formato = (L × A) / 1_000_000

Items[0].Quantity / PiezasFormato
  → Formatos = ceil(Q/P)  [or 1 if Montaje mode]

BOM rows × Formatos
  → BOM[].Cost  (EUR/ud | EUR/KG | EUR/m2 variants)

Operations × Formatos/Quantity
  → Operation[].Cost = ((SetupTime + ProductionTime × scale) / 60) × CostRate

All costs
  → materialCost = ΣBOMcosts + Other.MaterialCost + (Other.UnitMaterialCost × Qty) + Other.Embalajes
  → operationCost = ΣOpCosts + (Other.WorkTime × 21/60)     ← €21/hr hardcoded labor rate
  → transformationCost = materialCost + operationCost
  → totalProductionCost = transformationCost × (1 + StructureCost% + AuxiliaryCost%)
  → TotalCost = totalProductionCost / (1 – Margin%)         ← standard cost-plus; Margin=100 special-cased
```

`Cost.jsx` duplicates the final step locally via `useMemo` for display, then writes computed `UnitCost`/`Price` back to `variant.Items` — this silently overwrites any manual price entries.

---

## 3. BOM Management

| Type | Source | Rules |
|------|--------|-------|
| `MP` | User selects | Cannot be removed (only cleared); selecting MP propagates `ItemHeight` to all Items |
| `MCP` | User adds | First row cannot be removed |
| `ADH` | Auto-managed when `Parameters.Adhesivo` set | Upserted/removed automatically; filter: `Properties22=Y AND ItemCode like ADH` |
| `PLA` | Auto-managed when `Parameters.Plastico` set | Hardcoded item `MCP_PLA_1TR`; upserted/removed automatically |

Quantity per BOM row: `FormatoArea / (material.Length × material.Width)`.

---

## 4. Operations System

**Grouping rule** (`OpGroup`):
- `CB` → independent checkbox (multiple can be active in the same section)
- Any other group code → mutually exclusive radio (selecting one replaces the previous in that group)

**Company scoping**: only operations where `op.Company === WhsCode OR op.Company === ''` are shown.

**`FOR`-material suppression**: if any BOM `MP` row has `Material` starting with `'FOR'`, the entire `TRATAMIENTO` section is hidden.

**`_ruleSource` badge**: operations (and BOM rows) added by the rules engine carry a `_ruleSource` field, rendered as a badge in the UI.

### Time calculation per operation type

| Operation | Formula |
|-----------|---------|
| `Embalado` | `Cost = TipoEmbalaje × Embalajes` (flat cost, no time) |
| `Fresado` | `timePieza = (PPiezaRecorte/vRecorte)×Pasadas + (PPiezaRebaje/vRebaje)×Pasadas + holes×holeTime` |
| `Mecanizado` | `time = baseTime + rows×10/60 + Σrow.times×PiezasFormato`; row time = `ceil((perimetro×qty/vel)×pasadas)` seconds |
| `Pernos/Agujeros` | `time = unitTime × cantidad` |
| `Plegado` | `time = pliegues × (storedTotal / storedPliegues)` — scales setup AND production linearly |
| `Punzonado` | `time = ceil(tiempoCambio + (golpes×PiezasFormato/vel)/60)`; `golpes` auto = `ceil(L/32)×2 + ceil(W/32)×2` |
| `SMART/Plotter` | `time = (m2formato / pasadas) × 60`; doubled for `IMP_SMART_DOBLE` |
| `Tratamientos` | `cost = formatoPrice × Formatos`; `time = cost / CostRate × 60`; price is 2-tier by thickness (≤1mm / >1mm) |
| `Impresion3D` | `time = baseTime + (1/cantidadCiclo) × tiempoCiclo` |

---

## 5. Format Layout (Bin-Packing, `Formato.jsx`)

Maximal-rectangles algorithm:

- Usable area = format − 2×margin per axis
- Tries both orientations per piece (normal + rotated 90°); places the first that fits
- Sorted largest-area-first; best-fit bottom-left scoring (`y×width + x`)
- After each placement: splits remaining free space into up to 4 sub-rectangles, prunes contained ones
- `PiezasFormato` = placed count, unless user manually overrode (`PiezasFormatoManual: true`)
- Format dimension change resets the manual override (unless `_isLoadingVariant`)
- `paso`/`margen` (kerf/spacing) from `metodoMec` config, company-scoped (specific `WhsCode` beats `null`)

---

## 6. Historic Suggestions

### Entry points

| Trigger | Type | Source |
|---------|------|--------|
| Selecting a known item in General | Exact match → `isExactMatch: true` | `historicDataService.getItemHistory` |
| Any relevant param change (debounced 500ms) | Similarity search → `isSimilarMatch: true` | `historicDataService.getSimilarItemHistory` |

### Similarity scoring (0–100+)

| Criterion | Max pts | Logic |
|-----------|---------|-------|
| Material | 30 (mandatory) | Score = 0 if no match → record excluded |
| DimensionFormato | 25 | Linear within `TOLERANCE_DIMENSION` (default 5%) |
| DimensionPieza | 20 | Linear within `TOLERANCE_DIMENSION_PIEZA` (default 5%) |
| Piezas | 20 | Linear within `TOLERANCE_PIEZAS` (default 10%) |
| Formatos | 15 | Linear within `TOLERANCE_FORMATOS` (default 15%) |
| Adhesivo | 5 | Exact match or 2.5 partial |
| Plastico | 5 | Exact boolean match or 2.5 partial |
| Same customer | +10 | Bonus only |

Returns top `VITE_MAX_SUGGESTIONS` (default 10) results.

### Two-level click model (`SuggestionsPanel.jsx`)

- **Click card body** → loads item parameters (material, dimensions, quantity, formato)
- **Click operations table inside card** → loads operations only (independent; does not overwrite parameters)

`loadSuggestion` re-derives `productionTime` from actual BEAS work order times, normalised by unit (`OF` / `Planchas` / `Piezas`).

---

## 7. Quotation → Sales Order Flow (`quotationService.js`)

```
Variant state
  → transformVariantData()
      maps Items[] to DocumentLines (ItemCode = 'CONFIGWEB', real code → U_DNA_Codigo)
  → postQuotation() → SAP B1 POST /Quotations (ObjType 23)

postSalesOrder() — 3 phases:

  Phase 1: For each CONFIG line
    → createItem(U_DNA_Codigo + variantData)
    → createBOM(variantData.BOM)  per non-empty material row
    → createRouting(variantData.Operations) sorted by Sort
        TimesPer: 'Planchas' → PiezasFormato | 'OF' → 0 | else → 1

  Phase 2: Back-patch source quotation lines
    patchQuotation(BaseEntry) to update ItemCode ← U_DNA_Codigo

  Phase 3: POST /Orders with real ItemCodes

patchQuotation / patchSalesOrder — line deletion rule:
  current lines < Raw.DocumentLines → PUT (full replace; SAP B1 cannot PATCH-delete lines)
  otherwise → PATCH
```

---

## 8. Embedded Business Constants

| Constant | Value | File | Meaning |
|----------|-------|------|---------|
| Labor rate | `21` EUR/hr | `Variant.jsx`, `Cost.jsx` | Applied to `Other.WorkTime` |
| StructureCost default | 20% | `defaultVariant` | Overhead cost percentage |
| AuxiliaryCost default | 15% | `defaultVariant` | Auxiliary cost percentage |
| Margin default | 30% | `defaultVariant` | Gross margin target |
| Similarity search debounce | 500ms | `Configurador.jsx` | Search trigger delay |
| Suggestion cache TTL | 5 min | `Configurador.jsx` | In-memory Map expiry |
| Punch pitch | 32mm | `Punzonado.jsx` | Nibbling step distance |
| Thickness tiers | ≤1mm / >1mm | `Tratamientos.jsx` | Surface treatment price bands |

---

## 9. Known Issues

| Issue | Location |
|-------|----------|
| `cancelQuotation` loop `return`s after first entry — only cancels first DocEntry | `quotationService.js` |
| `Price` silently reset to `UnitCost` on any cost change | `Cost.jsx:164` |
| `handleCrear` missing `isLoading` guard → double-create risk | `Cost.jsx` |
| `General.jsx` local `company`/`formatType` not initialized from loaded variant | `General.jsx` |
| `Tratamientos.jsx` guard uses `&&` instead of `\|\|` (logic error, benign in practice) | `Tratamientos.jsx` |
| `BOM.addBOMRow` mutates `variant.BOM` in-place before `setState` | `BOM.jsx` / `bomService` |
| `Fresado.jsx` dep array uses `item.ItemHeight` but calculation uses `bom.MaterialHeight` | `Fresado.jsx` |
| `Math.round(value, 2)` — second arg silently ignored (rounds to integer) | `Mecanizado.jsx` |
| `console.log('Patata')` left in production | `Fresado.jsx:100` |
| "Aplicar Reglas" button is comment-blocked → dead code | `Cost.jsx:454–460` |
