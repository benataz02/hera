# Configurator Builder UI Implementation Plan (Phase 3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **First action of Task 1:** copy this plan file to `docs/superpowers/plans/2026-07-03-configurator-builder-ui.md` (repo-standard location; plan mode could only write to `~/.claude/plans/`).

**Goal:** The admin Model Builder — routes `models/` (list) + `models/$id` (builder): TabContainer editor (Parameters hierarchy with drag-reorder, Rules, BOM, Routing, Tables designer, Settings), a shared `ExprInput` with span-accurate errors + suggestions, and a live preview pane running the real engine (`propagate`) against the unsaved draft — spec phase 3 of `docs/superpowers/specs/2026-07-03-configurator-design.md`.

**Architecture:** Everything data goes through the existing oRPC client (`orpc.models.*`, admin-gated server-side by `adminProcedure`); the engine (`@hera/config-engine`) runs **in the browser** for validation (`checkModel`) and live preview (`propagate`) — the dep is already declared in `apps/web/package.json`, currently unused. The builder holds one draft `ModelDef` in React state; `checkModel(draft, tableNames)` runs on every change and drives per-field `valueState`, per-tab error badges, a header MessageView, and the save gate. One new server procedure, `models.previewLookups`, resolves a *draft* definition's lookups (reusing the already-tested `resolveLookups`) so the preview sees query domains and queryTables exactly as a run would.

**Tech Stack:** React 19, `@ui5/webcomponents-react` 2.23.1 (all component APIs verified against the ui5-wcr MCP at 2.23.2), TanStack Router (file-based) + TanStack Query via `@orpc/tanstack-query`, `@hera/config-engine` (pure TS), bun test for pure helpers. **No new dependencies.**

## Global Constraints

- Repo root `/home/benataz02/dev/hera`; run all commands there. Commit after every task (style: `feat(web): …`, matching `git log`).
- The engine **as built** is the source of truth (not the spec sketch): `pricing.priceExpr`, `LookupRef` variants `manual{options[{value,label?}]} | table{table,valueCol,labelCol?} | query{target,path,valueField,labelField?}`, `ModelDef.queryTables`, `Param.domain = {kind:"options",ref} | {kind:"range",min,max,step?}`, expr fields are plain strings (`BomLine.qty/price/itemCode/desc/condition`, `Operation.setupMin/runMinPerUnit/ratePerHour/condition`).
- Expression scopes mirror `check.ts`: params/computed/constraints → param+computed keys; bom/routing exprs additionally see `qty`; `pricing.priceExpr` additionally sees `qty` and `unitCost`.
- Web conventions (from the live code, do not invent new ones): thin route files delegating to components; `orpc.x.y.queryOptions({input})` / `.mutationOptions()`; invalidation via `qc.invalidateQueries({queryKey: orpc.x.y.queryOptions().queryKey})`; errors as inline `<MessageStrip design="Negative">`; loading via `BusyIndicator`/`isPending`; inline `style={{}}` objects, no CSS files; icons by string name (global `AllIcons.js` import exists).
- Admin gating: nav item hidden behind the existing `isAdmin` check in `AppShell.tsx` (`["active-member-role"]` query); the server's `adminProcedure` is the real boundary — no route-level guard (same as `/settings`).
- New web files live in `apps/web/src/components/configurator/`; routes in `apps/web/src/routes/_authed/models/`. `routeTree.gen.ts` is auto-generated — never edit it.
- UI5 gotchas already verified: `Option` supports `disabled` at runtime via `ListItemBase` but the React typing omits it — pass through a typed spread; `MultiComboBoxItem` has **no** `disabled` — filter eliminated options out instead; `Table` drag-reorder = `TableRow movable rowKey` + `Table onMoveOver` (`preventDefault()` to accept) / `onMove` with `e.detail.{source,destination}` where `destination.placement ∈ "Before"|"After"|"On"`; row actions need `rowActionCount` on `Table` + `actions` slot on `TableRow`.
- Typecheck per task: `bunx tsc --noEmit -p apps/web` (plus `-p apps/server` / engine tests where touched).
- **Verification servers:** `bun dev` serves web on `http://acme.lvh.me:5173` (tenant) — sign in as the seeded admin. Browser verification steps use the chrome-devtools MCP when available, otherwise do them manually and record what you saw.

## Design intent (read before building UI)

The design language is SAP Fiori Horizon — distinctiveness comes from **one signature element**: the live test-drive. The left half is a quiet, disciplined editor; the right half is the *actual product configurator* running the real engine on every keystroke, with a status line that always answers "is this model consistent and how big is it?" (`✓ Consistent · 3 open · ~24 candidates`). Expression fields are the second voice: monospace, span-accurate errors, suggestion popover — they should feel like a tiny IDE embedded in Fiori, nothing else should try to be clever.

Microcopy rules: sentence case; buttons name the action outcome ("Save model", "Add parameter", "Preview options"); errors name the field path and the offending token; empty states say what to do next ("Add a section to start structuring the form."). Tab error state = `design="Negative"` + issue count in `additionalText` — no extra iconography.

## File structure

```
packages/config-engine/src/check.ts               MODIFY: export FUNCS
packages/config-engine/src/index.ts               MODIFY: re-export FUNCS
apps/server/src/orpc/routers/models.ts            MODIFY: + previewLookups
apps/web/src/components/AppShell.tsx              MODIFY: admin nav item
apps/web/src/routes/_authed/models/index.tsx      CREATE: thin route → ModelsPage
apps/web/src/routes/_authed/models/$id.tsx        CREATE: thin route → ModelBuilderPage
apps/web/src/components/configurator/
  exprHelpers.ts        CREATE: suggestion candidates + trailing-token completion (pure)
  exprHelpers.test.ts   CREATE: bun tests
  ExprInput.tsx         CREATE: monospace Input + parse-on-change + suggestion Popover
  useDraftModel.ts      CREATE: draft state, checkModel wiring, save mutation, issue helpers
  usePreviewLookups.ts  CREATE: lookup-skeleton + previewLookups query
  ModelsPage.tsx        CREATE: list page (DynamicPage + Table)
  ModelBuilderPage.tsx  CREATE: builder shell (Bar + MessageView + TabContainer + Splitter)
  SettingsTab.tsx       CREATE: name / pricing / batches / queryTables
  structureOps.ts       CREATE: pure structure flatten/move/remove helpers
  structureOps.test.ts  CREATE: bun tests
  ParamsTab.tsx         CREATE: hierarchy table + drag + param Dialog (+ LookupRefEditor)
  RulesTab.tsx          CREATE: expr constraints + combination-table Dialog
  LinesTabs.tsx         CREATE: BomTab + RoutingTab (shared inline-expr table pattern)
  TablesTab.tsx         CREATE: config_table designer + TSV paste
  ConfiguratorForm.tsx  CREATE: shared param form + status bar (preview now, wizard in phase 4)
  PreviewPane.tsx       CREATE: last-good draft + lookups + ConfiguratorForm
```

---

### Task 1: Server — `models.previewLookups` (+ plan file copy)

The builder previews the **unsaved draft**, so it can't use `configs.lookups({modelId})` (saved models only). One thin admin procedure resolves a posted definition with the same helper the run path uses. No new logic → no new test; `resolveLookups`/`optionsFromRef` are already unit-tested in `apps/server/test/lookups.test.ts`.

**Files:**
- Copy: this plan → `docs/superpowers/plans/2026-07-03-configurator-builder-ui.md`
- Modify: `apps/server/src/orpc/routers/models.ts`

**Interfaces:**
- Consumes: `resolveLookups` (`../../lookups.ts`), existing `tenantTables`, `agentFetcher`, `adminProcedure`, `ModelDefZ`.
- Produces: `orpc.models.previewLookups({ definition: ModelDef }) → ResolvedLookups` (`{domains: Record<key, {value,label}[]>, tables: Record<name, {columns, rows}>}`). Agent-offline surfaces as the existing `assertAgentReady` `SERVICE_UNAVAILABLE` (thrown inside `agentFetcher`, only when a query source exists); other resolution failures → `BAD_GATEWAY` with the source-naming message from `lookups.ts`.

- [ ] **Step 1: Copy the plan file into the repo**

```bash
cp ~/.claude/plans/implement-phase-3-check-rustling-lemon.md docs/superpowers/plans/2026-07-03-configurator-builder-ui.md
```

- [ ] **Step 2: Add the procedure**

In `apps/server/src/orpc/routers/models.ts`: add `resolveLookups` to the existing `../../lookups.ts` import, then add to `modelsRouter` (after `lookupPreview`):

```ts
  // Live preview for the (possibly unsaved) builder draft: same resolver as configs.lookups/run,
  // keyed by the posted definition instead of a saved model id. Client sends a stripped-down
  // "lookup skeleton" so typing in expression fields doesn't refetch.
  previewLookups: adminProcedure
    .input(z.object({ definition: ModelDefZ }))
    .handler(async ({ input, context }) => {
      try {
        return await resolveLookups(input.definition, await tenantTables(context.tenantId), agentFetcher(context.tenantId));
      } catch (e) {
        if (e instanceof ORPCError) throw e; // agent offline etc. — keep the specific message
        throw new ORPCError("BAD_GATEWAY", { message: e instanceof Error ? e.message : String(e) });
      }
    }),
```

- [ ] **Step 3: Typecheck + existing tests**

Run: `bunx tsc --noEmit -p apps/server && bun test apps/server`
Expected: tsc exits 0; all server tests PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/server docs/superpowers/plans/2026-07-03-configurator-builder-ui.md
git commit -m "feat(server): models.previewLookups for the builder's live draft preview"
```

---

### Task 2: ExprInput — engine FUNCS export, pure helpers + tests, component

**Files:**
- Modify: `packages/config-engine/src/check.ts:6` (export FUNCS)
- Modify: `packages/config-engine/src/index.ts`
- Create: `apps/web/src/components/configurator/exprHelpers.ts`
- Test: `apps/web/src/components/configurator/exprHelpers.test.ts`
- Create: `apps/web/src/components/configurator/ExprInput.tsx`

**Interfaces:**
- Consumes: engine `parse`, `DslError`, `Issue`, `ModelDef`; new `FUNCS: Set<string>`.
- Produces (used by Tasks 4–8):
  - `scopeSuggestions(model: ModelDef, extraVars?: string[]): Suggestion[]`, `matches(all, src): Suggestion[]`, `complete(src, s): string`, `trailingIdent(src): string` where `Suggestion = { text: string; kind: "param"|"computed"|"var"|"function" }`
  - `<ExprInput value onChange model extraVars? placeholder? optional? issue? fieldId? />` — `value: string|undefined`, `onChange(v: string|undefined)`; when `optional`, empty input emits `undefined`; `fieldId` becomes the DOM id (`expr-<path>`) the MessageView jumps to.

- [ ] **Step 1: Export FUNCS from the engine**

`packages/config-engine/src/check.ts` line 6 — add `export`:

```ts
export const FUNCS = new Set(["IF", "MIN", "MAX", "ROUND", "CEIL", "FLOOR", "ABS", "CONCAT", "HAS", "LOOKUP"]);
```

`packages/config-engine/src/index.ts` — extend the check line:

```ts
export { checkModel, FUNCS } from "./check";
```

Run: `bun test packages/config-engine`
Expected: PASS (no behavior change).

- [ ] **Step 2: Write the failing helper tests**

`apps/web/src/components/configurator/exprHelpers.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import type { ModelDef } from "@hera/config-engine";
import { complete, matches, scopeSuggestions, trailingIdent } from "./exprHelpers.ts";

const model = {
  name: "m",
  parameters: [
    { key: "material", label: "Material", type: "string", ui: "select" },
    { key: "length_mm", label: "Length", type: "number", ui: "input" },
  ],
  structure: { sections: [] },
  computed: [{ key: "area", expr: "1" }],
  constraints: [], bom: [], routing: [], queryTables: [],
  pricing: { priceExpr: "unitCost", quoteItemCode: "X" },
  batchDefaults: [1],
} as ModelDef;

describe("exprHelpers", () => {
  test("scopeSuggestions: params + computed + extras + functions", () => {
    const all = scopeSuggestions(model, ["qty"]);
    const names = all.map((s) => s.text);
    expect(names).toContain("material");
    expect(names).toContain("area");
    expect(names).toContain("qty");
    expect(names).toContain("LOOKUP");
    expect(all.find((s) => s.text === "area")!.kind).toBe("computed");
  });

  test("trailingIdent grabs the fragment being typed", () => {
    expect(trailingIdent("len")).toBe("len");
    expect(trailingIdent("material == mat")).toBe("mat");
    expect(trailingIdent("1 + ")).toBe("");
    expect(trailingIdent("ROUND(le")).toBe("le");
  });

  test("matches filters case-insensitively and drops exact hits", () => {
    const all = scopeSuggestions(model, []);
    expect(matches(all, "material == mat").map((s) => s.text)).toEqual(["material"]);
    expect(matches(all, "material").map((s) => s.text)).toEqual([]); // already complete
    expect(matches(all, "look").map((s) => s.text)).toEqual(["LOOKUP"]);
    expect(matches(all, "1 + ")).toEqual([]); // no fragment -> no noise
  });

  test("complete replaces the fragment; functions get an open paren", () => {
    const all = scopeSuggestions(model, []);
    const mat = all.find((s) => s.text === "material")!;
    const lookup = all.find((s) => s.text === "LOOKUP")!;
    expect(complete("material == mat", mat)).toBe("material == material");
    expect(complete("look", lookup)).toBe("LOOKUP(");
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `bun test apps/web/src/components/configurator/exprHelpers.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement `exprHelpers.ts`**

```ts
import { FUNCS, type ModelDef } from "@hera/config-engine";

// Suggestion machinery for ExprInput. Completion targets the TRAILING identifier of the
// value — the common typing flow. // ponytail: caret-aware mid-expression completion needs
// shadow-DOM selectionStart poking; add if authors ask for it.

export type Suggestion = { text: string; kind: "param" | "computed" | "var" | "function" };

export function scopeSuggestions(model: ModelDef, extraVars: string[] = []): Suggestion[] {
  return [
    ...model.parameters.map((p) => ({ text: p.key, kind: "param" as const })),
    ...model.computed.map((c) => ({ text: c.key, kind: "computed" as const })),
    ...extraVars.map((v) => ({ text: v, kind: "var" as const })),
    ...[...FUNCS].map((f) => ({ text: f, kind: "function" as const })),
  ];
}

export function trailingIdent(src: string): string {
  return /([a-zA-Z_][a-zA-Z0-9_]*)$/.exec(src)?.[1] ?? "";
}

export function matches(all: Suggestion[], src: string): Suggestion[] {
  const frag = trailingIdent(src);
  if (!frag) return [];
  const lower = frag.toLowerCase();
  return all.filter((s) => s.text.toLowerCase().startsWith(lower) && s.text !== frag);
}

export function complete(src: string, s: Suggestion): string {
  const frag = trailingIdent(src);
  const done = src.slice(0, src.length - frag.length) + s.text;
  return s.kind === "function" ? done + "(" : done;
}
```

- [ ] **Step 5: Run helper tests**

Run: `bun test apps/web/src/components/configurator/exprHelpers.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Implement `ExprInput.tsx`**

```tsx
import { useId, useMemo, useState, type CSSProperties } from "react";
import { Input, List, ListItemStandard, Popover } from "@ui5/webcomponents-react";
import { DslError, parse, type Issue, type ModelDef } from "@hera/config-engine";
import { complete, matches, scopeSuggestions, type Suggestion } from "./exprHelpers.ts";

// The one expression editor used everywhere in the builder: monospace, parse-on-change with
// span-accurate messages, trailing-token suggestions in a Popover (spec: "suggestion Popover").

export function ExprInput({
  value,
  onChange,
  model,
  extraVars,
  placeholder,
  optional = false,
  issue,
  fieldId,
  style,
}: {
  value: string | undefined;
  onChange: (v: string | undefined) => void;
  model: ModelDef;
  extraVars?: string[];
  placeholder?: string;
  /** empty input -> undefined (for condition/when/default fields) */
  optional?: boolean;
  /** semantic issue from checkModel for this field, shown when the text parses */
  issue?: Issue;
  /** DOM id (MessageView jump target); defaults to a generated one */
  fieldId?: string;
  style?: CSSProperties;
}) {
  const autoId = useId().replace(/[^a-zA-Z0-9_-]/g, "_"); // ui5 Popover opener needs a plain id
  const id = fieldId ?? `expr-${autoId}`;
  const [focused, setFocused] = useState(false);
  const text = value ?? "";
  const all = useMemo(() => scopeSuggestions(model, extraVars), [model, extraVars]);

  const parseError = useMemo(() => {
    if (text.trim() === "") return null; // emptiness is the caller's concern (optional/required)
    try {
      parse(text);
      return null;
    } catch (e) {
      return e instanceof DslError ? e : null;
    }
  }, [text]);
  const error = parseError ?? issue ?? null;
  const errorText = error
    ? `${error.message}${error.from !== undefined ? ` — at «${text.slice(error.from, error.to) || "end"}»` : ""}`
    : "";

  const sugg = focused ? matches(all, text).slice(0, 8) : [];
  const pick = (s: Suggestion) => onChange(complete(text, s));

  return (
    <>
      <Input
        id={id}
        style={{ width: "100%", ...style }}
        className="hera-expr" // fontFamily via CSS part is unavailable; monospace set inline below
        value={text}
        placeholder={placeholder}
        valueState={error ? "Negative" : "None"}
        valueStateMessage={<div>{errorText}</div>}
        onInput={(e) => {
          const v = e.target.value ?? "";
          onChange(v === "" && optional ? undefined : v);
        }}
        onFocus={() => setFocused(true)}
        // Delay so a click on a suggestion lands before the popover unmounts.
        onBlur={() => setTimeout(() => setFocused(false), 200)}
        data-expr-input
      />
      {sugg.length > 0 && (
        <Popover opener={id} open placement="Bottom" preventInitialFocus hideArrow>
          <List
            onItemClick={(e) => {
              const t = (e.detail.item as HTMLElement).dataset.suggest;
              const s = sugg.find((x) => x.text === t);
              if (s) pick(s);
            }}
          >
            {sugg.map((s) => (
              <ListItemStandard key={s.text} data-suggest={s.text} additionalText={s.kind}>
                {s.text}
              </ListItemStandard>
            ))}
          </List>
        </Popover>
      )}
    </>
  );
}
```

Monospace: the UI5 `Input` exposes a CSS part named `input`. Add once, in this file, a module-level style injection (no CSS files in this app; keep it colocated):

```tsx
// Monospace inside the shadow DOM via the exposed `input` CSS part.
if (typeof document !== "undefined" && !document.getElementById("hera-expr-style")) {
  const el = document.createElement("style");
  el.id = "hera-expr-style";
  el.textContent = `.hera-expr::part(input){font-family:ui-monospace,SFMono-Regular,Menlo,monospace;}`;
  document.head.appendChild(el);
}
```

- [ ] **Step 7: Typecheck**

Run: `bunx tsc --noEmit -p apps/web`
Expected: exits 0.

- [ ] **Step 8: Commit**

```bash
git add packages/config-engine apps/web/src/components/configurator
git commit -m "feat(web): ExprInput with span-accurate errors and suggestion popover"
```

---

### Task 3: Models list — routes, nav item, ModelsPage

**Files:**
- Create: `apps/web/src/routes/_authed/models/index.tsx`
- Create: `apps/web/src/routes/_authed/models/$id.tsx`
- Create: `apps/web/src/components/configurator/ModelsPage.tsx`
- Modify: `apps/web/src/components/AppShell.tsx` (nav item next to Settings)

**Interfaces:**
- Consumes: `orpc.models.list/save/remove`.
- Produces: `/models` list; `/models/$id` renders `ModelBuilderPage` (created Task 4 — until then use a placeholder, replaced in Task 4). `starterModel(name): ModelDef` export reused nowhere else (list-local).

- [ ] **Step 1: Routes**

`apps/web/src/routes/_authed/models/index.tsx`:

```tsx
import { createFileRoute } from "@tanstack/react-router";
import { ModelsPage } from "../../../components/configurator/ModelsPage.tsx";

export const Route = createFileRoute("/_authed/models/")({ component: ModelsPage });
```

`apps/web/src/routes/_authed/models/$id.tsx` (placeholder body; Task 4 swaps the import):

```tsx
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/_authed/models/$id")({ component: Builder });

function Builder() {
  const { id } = Route.useParams();
  return <div style={{ padding: "1rem" }}>Builder for {id} (Task 4)</div>;
}
```

- [ ] **Step 2: Nav item**

In `apps/web/src/components/AppShell.tsx`, inside the `isAdmin ? (...)` block, wrap the existing Settings item and the new one in a fragment:

```tsx
          {isAdmin ? (
            <>
              <SideNavigationItem
                text="Configurator models"
                icon="tree"
                data-to="/models"
                selected={pathname === "/models" || pathname.startsWith("/models/")}
              />
              <SideNavigationItem
                text="Settings"
                icon="action-settings"
                data-to="/settings"
                selected={pathname === "/settings"}
              />
            </>
          ) : null}
```

- [ ] **Step 3: ModelsPage**

`apps/web/src/components/configurator/ModelsPage.tsx`:

```tsx
import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Bar, Button, BusyIndicator, Dialog, DynamicPage, DynamicPageTitle, Input, Label, MessageStrip,
  Table, TableCell, TableHeaderCell, TableHeaderRow, TableRow, TableRowAction, Text, Title,
} from "@ui5/webcomponents-react";
import type { ModelDef } from "@hera/config-engine";
import { orpc } from "../../orpc.ts";

// Minimal valid model a new draft starts from; passes checkModel (unitCost is in pricing scope).
export function starterModel(name: string): ModelDef {
  return {
    name,
    parameters: [],
    structure: { sections: [{ key: "main", title: "General", groups: [{ key: "general", title: "General", params: [] }] }] },
    computed: [],
    constraints: [],
    bom: [],
    routing: [],
    queryTables: [],
    pricing: { priceExpr: "unitCost * 1.2", quoteItemCode: "CFG" },
    batchDefaults: [1, 10, 100],
  };
}

export function ModelsPage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const models = useQuery(orpc.models.list.queryOptions());
  const invalidate = () => qc.invalidateQueries({ queryKey: orpc.models.list.queryOptions().queryKey });

  const [newOpen, setNewOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const create = useMutation(
    orpc.models.save.mutationOptions({
      onSuccess: (r) => {
        invalidate();
        navigate({ to: "/models/$id", params: { id: r.id } });
      },
    }),
  );
  const remove = useMutation(orpc.models.remove.mutationOptions({ onSuccess: invalidate }));

  if (models.isPending) return <BusyIndicator active delay={0} style={{ width: "100%", marginTop: "4rem" }} />;

  return (
    <DynamicPage
      titleArea={
        <DynamicPageTitle
          heading={<Title level="H3">Configurator models</Title>}
          actionsBar={
            <Bar design="Header" endContent={
              <Button design="Emphasized" onClick={() => { setNewName(""); setNewOpen(true); }}>New model</Button>
            } />
          }
        />
      }
    >
      {models.error ? <MessageStrip design="Negative" hideCloseButton>{models.error.message}</MessageStrip> : null}
      {remove.error ? <MessageStrip design="Negative" hideCloseButton>{remove.error.message}</MessageStrip> : null}

      <Table
        noDataText="No models yet — create one to start."
        rowActionCount={1}
        onRowClick={(e) => {
          const id = (e.detail.row as HTMLElement).dataset.id;
          if (id) navigate({ to: "/models/$id", params: { id } });
        }}
        onRowActionClick={(e) => {
          const id = ((e.detail.row as unknown) as HTMLElement).dataset.id;
          // ponytail: no confirm dialog — server refuses deletion of in-use models anyway
          if (id) remove.mutate({ id });
        }}
        headerRow={
          <TableHeaderRow sticky>
            <TableHeaderCell><span>Name</span></TableHeaderCell>
            <TableHeaderCell><span>Last changed</span></TableHeaderCell>
          </TableHeaderRow>
        }
      >
        {(models.data ?? []).map((m) => (
          <TableRow key={m.id} rowKey={m.id} data-id={m.id} interactive
            actions={<TableRowAction icon="delete" text="Delete" />}>
            <TableCell><Text>{m.name}</Text></TableCell>
            <TableCell><Text>{new Date(m.updatedAt).toLocaleString()}</Text></TableCell>
          </TableRow>
        ))}
      </Table>

      <Dialog
        open={newOpen}
        headerText="New model"
        onClose={() => setNewOpen(false)}
        footer={
          <Bar design="Footer" endContent={
            <>
              <Button design="Emphasized" disabled={!newName.trim() || create.isPending}
                onClick={() => create.mutate({ definition: starterModel(newName.trim()) })}>
                {create.isPending ? "Creating…" : "Create"}
              </Button>
              <Button onClick={() => setNewOpen(false)}>Cancel</Button>
            </>
          } />
        }
      >
        <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem", padding: "0.5rem 0" }}>
          {create.error ? <MessageStrip design="Negative" hideCloseButton>{create.error.message}</MessageStrip> : null}
          <Label for="new-model-name" required>Name</Label>
          <Input id="new-model-name" value={newName} onInput={(e) => setNewName(e.target.value)} />
        </div>
      </Dialog>
    </DynamicPage>
  );
}
```

- [ ] **Step 4: Typecheck + browser check**

Run: `bunx tsc --noEmit -p apps/web`
Expected: exits 0.

Run `bun dev` (background), open `http://acme.lvh.me:5173` as the admin:
- "Configurator models" appears in the side nav (admin only), navigates to `/models`.
- "New model" → name → Create lands on `/models/<uuid>` placeholder; the list shows the row; Delete removes it.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src
git commit -m "feat(web): configurator models list, routes, admin nav item"
```

---

### Task 4: Builder shell — useDraftModel, ModelBuilderPage, SettingsTab

The full edit→validate→save loop, end to end, with one real tab (Settings). Other tabs land as stubs and fill in over Tasks 5–9.

**Files:**
- Create: `apps/web/src/components/configurator/useDraftModel.ts`
- Create: `apps/web/src/components/configurator/ModelBuilderPage.tsx`
- Create: `apps/web/src/components/configurator/SettingsTab.tsx`
- Modify: `apps/web/src/routes/_authed/models/$id.tsx` (swap placeholder)

**Interfaces:**
- Consumes: `orpc.models.get/save`, `orpc.models.tables.list`, engine `checkModel`/`Issue`/`ModelDef`, `ExprInput` (Task 2).
- Produces (used by Tasks 5–9):
  - `useDraftModel(id)` → `{ draft, update, issues, serverIssues, dirty, save, saving, saveError, loading, tables }` where `update(fn: (d: ModelDef) => ModelDef): void`, `issues: Issue[]` (client `checkModel(draft, tableNames)`), `tables: {id,name,columns,rows,...}[]`.
  - `issueFor(issues: Issue[], path: string): Issue | undefined`; `tabOf(path: string): TabKey`; `type TabKey = "params"|"rules"|"bom"|"routing"|"tables"|"settings"`.
  - Every tab component receives `{ draft, update, issues }` (plus extras where noted). ExprInput `fieldId` convention: `expr-<checkModel path>` (e.g. `expr-bom[0].qty`).

- [ ] **Step 1: `useDraftModel.ts`**

```ts
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { checkModel, type Issue, type ModelDef } from "@hera/config-engine";
import { orpc } from "../../orpc.ts";

export type TabKey = "params" | "rules" | "bom" | "routing" | "tables" | "settings";

export const issueFor = (issues: Issue[], path: string) => issues.find((i) => i.path === path);

export function tabOf(path: string): TabKey {
  if (path.startsWith("parameters") || path.startsWith("structure") || path.startsWith("computed") || path === "model")
    return "params";
  if (path.startsWith("constraints")) return "rules";
  if (path.startsWith("bom")) return "bom";
  if (path.startsWith("routing")) return "routing";
  return "settings"; // pricing.*
}

// One draft ModelDef in memory; checkModel on every change is the same gate the server runs
// on save, so "0 issues" here means the save cannot be rejected for model errors.
export function useDraftModel(id: string) {
  const qc = useQueryClient();
  const rec = useQuery(orpc.models.get.queryOptions({ input: { id } }));
  const tablesQ = useQuery(orpc.models.tables.list.queryOptions());
  const [draft, setDraft] = useState<ModelDef | null>(null);
  const [dirty, setDirty] = useState(false);
  const [serverIssues, setServerIssues] = useState<Issue[]>([]);

  useEffect(() => {
    if (rec.data && draft === null) setDraft(rec.data.definition);
  }, [rec.data, draft]);

  const tables = tablesQ.data ?? [];
  const issues = useMemo(
    () => (draft ? checkModel(draft, tables.map((t) => t.name)) : []),
    [draft, tables],
  );

  const saveMut = useMutation(
    orpc.models.save.mutationOptions({
      onSuccess: () => {
        setDirty(false);
        setServerIssues([]);
        qc.invalidateQueries({ queryKey: orpc.models.list.queryOptions().queryKey });
        qc.invalidateQueries({ queryKey: orpc.models.get.queryOptions({ input: { id } }).queryKey });
      },
      onError: (e) => {
        // models.save rejects invalid definitions with BAD_REQUEST + data.issues (span Issues).
        const data = (e as { data?: { issues?: Issue[] } }).data;
        setServerIssues(data?.issues ?? []);
      },
    }),
  );

  return {
    draft,
    update: (fn: (d: ModelDef) => ModelDef) => {
      setDraft((d) => (d ? fn(d) : d));
      setDirty(true);
      setServerIssues([]);
    },
    issues,
    serverIssues,
    dirty,
    save: () => draft && saveMut.mutate({ id, definition: draft }),
    saving: saveMut.isPending,
    saveError: saveMut.error as Error | null,
    loading: rec.isPending,
    loadError: rec.error as Error | null,
    tables,
  };
}
```

- [ ] **Step 2: `SettingsTab.tsx`**

```tsx
import { useState } from "react";
import { Button, Form, FormGroup, FormItem, Input, Label, Option, Select, Table, TableCell, TableHeaderCell, TableHeaderRow, TableRow, TableRowAction, Text } from "@ui5/webcomponents-react";
import type { Issue, ModelDef } from "@hera/config-engine";
import { ExprInput } from "./ExprInput.tsx";
import { issueFor } from "./useDraftModel.ts";

export function SettingsTab({ draft, update, issues }: {
  draft: ModelDef;
  update: (fn: (d: ModelDef) => ModelDef) => void;
  issues: Issue[];
}) {
  // Batches edited as CSV; parse on change, ignore junk. // ponytail: token editor if CSV annoys
  const [batchText, setBatchText] = useState(draft.batchDefaults.join(", "));
  const setBatches = (text: string) => {
    setBatchText(text);
    const nums = text.split(",").map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n > 0);
    update((d) => ({ ...d, batchDefaults: nums }));
  };

  const setQt = (i: number, patch: Partial<ModelDef["queryTables"][number]>) =>
    update((d) => ({ ...d, queryTables: d.queryTables.map((q, j) => (j === i ? { ...q, ...patch } : q)) }));

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "1rem", padding: "1rem" }}>
      <Form labelSpan="S12 M4" layout="S1 M1 L2 XL2">
        <FormGroup headerText="Model">
          <FormItem labelContent={<Label required>Name</Label>}>
            <Input value={draft.name} onInput={(e) => update((d) => ({ ...d, name: e.target.value }))} />
          </FormItem>
          <FormItem labelContent={<Label>Default batch sizes</Label>}>
            <Input value={batchText} placeholder="1, 10, 100" onInput={(e) => setBatches(e.target.value)}
              valueState={draft.batchDefaults.length ? "None" : "Negative"}
              valueStateMessage={<div>At least one positive integer batch size</div>} />
          </FormItem>
        </FormGroup>
        <FormGroup headerText="Pricing">
          <FormItem labelContent={<Label required>Unit price expression</Label>}>
            <ExprInput value={draft.pricing.priceExpr} model={draft} extraVars={["qty", "unitCost"]}
              fieldId="expr-pricing.priceExpr" issue={issueFor(issues, "pricing.priceExpr")}
              onChange={(v) => update((d) => ({ ...d, pricing: { ...d.pricing, priceExpr: v ?? "" } }))} />
          </FormItem>
          <FormItem labelContent={<Label required>Quote item code</Label>}>
            <Input value={draft.pricing.quoteItemCode}
              valueState={draft.pricing.quoteItemCode ? "None" : "Negative"}
              onInput={(e) => update((d) => ({ ...d, pricing: { ...d.pricing, quoteItemCode: e.target.value } }))} />
          </FormItem>
        </FormGroup>
      </Form>

      <Text>Query tables — B1/Beas datasets snapshotted for LOOKUP() and table domains.</Text>
      <Table
        noDataText="No query tables. Add one to pull rows from B1 or Beas."
        rowActionCount={1}
        onRowActionClick={(e) => {
          const i = Number(((e.detail.row as unknown) as HTMLElement).dataset.idx);
          update((d) => ({ ...d, queryTables: d.queryTables.filter((_, j) => j !== i) }));
        }}
        headerRow={
          <TableHeaderRow>
            <TableHeaderCell><span>Name</span></TableHeaderCell>
            <TableHeaderCell><span>Target</span></TableHeaderCell>
            <TableHeaderCell width="40%"><span>Path</span></TableHeaderCell>
            <TableHeaderCell><span>Columns (CSV)</span></TableHeaderCell>
          </TableHeaderRow>
        }
      >
        {draft.queryTables.map((q, i) => (
          <TableRow key={i} rowKey={`qt-${i}`} data-idx={String(i)} actions={<TableRowAction icon="delete" text="Delete" />}>
            <TableCell><Input value={q.name} onInput={(e) => setQt(i, { name: e.target.value })} /></TableCell>
            <TableCell>
              <Select value={q.target} onChange={(e) => setQt(i, { target: (e.detail.selectedOption as HTMLElement).dataset.v as "b1" | "beas" })}>
                <Option value="b1" data-v="b1">B1</Option>
                <Option value="beas" data-v="beas">Beas</Option>
              </Select>
            </TableCell>
            <TableCell><Input value={q.path} placeholder="/Items?$select=ItemCode,ItemName" onInput={(e) => setQt(i, { path: e.target.value })} /></TableCell>
            <TableCell><Input value={q.columns.join(", ")} onInput={(e) => setQt(i, { columns: e.target.value.split(",").map((s) => s.trim()).filter(Boolean) })} /></TableCell>
          </TableRow>
        ))}
      </Table>
      <Button icon="add" style={{ alignSelf: "start" }}
        onClick={() => update((d) => ({ ...d, queryTables: [...d.queryTables, { name: "", target: "b1", path: "", columns: [] }] }))}>
        Add query table
      </Button>
    </div>
  );
}
```

- [ ] **Step 3: `ModelBuilderPage.tsx`**

```tsx
import { useState } from "react";
import {
  Bar, Button, BusyIndicator, MessageStrip, MessageItem, MessageView, MessageViewButton,
  ObjectStatus, ResponsivePopover, SplitterElement, SplitterLayout, Tab, TabContainer, Text, Title,
} from "@ui5/webcomponents-react";
import type { Issue } from "@hera/config-engine";
import { tabOf, useDraftModel, type TabKey } from "./useDraftModel.ts";
import { SettingsTab } from "./SettingsTab.tsx";

// Tab components land in Tasks 5-9; until then a stub renders in their place.
const Stub = ({ name }: { name: string }) => <Text style={{ padding: "1rem" }}>{name} — next task.</Text>;

export function ModelBuilderPage({ id }: { id: string }) {
  const m = useDraftModel(id);
  const [tab, setTab] = useState<TabKey>("params");
  const [msgOpen, setMsgOpen] = useState(false);
  const allIssues: Issue[] = [...m.issues, ...m.serverIssues];
  const count = (t: TabKey) => allIssues.filter((i) => tabOf(i.path) === t).length;

  if (m.loading || !m.draft) {
    return m.loadError
      ? <MessageStrip design="Negative" hideCloseButton style={{ margin: "1rem" }}>{m.loadError.message}</MessageStrip>
      : <BusyIndicator active delay={0} style={{ width: "100%", marginTop: "4rem" }} />;
  }
  const draft = m.draft;

  // Jump from a MessageView item to its field: switch tab, then focus by the expr-<path> id.
  const jumpTo = (path: string) => {
    setTab(tabOf(path));
    setMsgOpen(false);
    setTimeout(() => document.getElementById(`expr-${path}`)?.focus(), 120);
  };

  const tabProps = (key: TabKey, text: string) => ({
    text,
    "data-key": key,
    selected: tab === key,
    additionalText: count(key) ? String(count(key)) : undefined,
    design: count(key) ? ("Negative" as const) : ("Default" as const),
  });

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column" }}>
      <Bar
        design="Header"
        startContent={
          <>
            <Title level="H4">{draft.name || "Untitled model"}</Title>
            {m.dirty ? <ObjectStatus state="Critical">Unsaved changes</ObjectStatus> : null}
          </>
        }
        endContent={
          <>
            <MessageViewButton id="model-msgs" counter={allIssues.length}
              type={allIssues.length ? "Negative" : "Positive"} onClick={() => setMsgOpen((o) => !o)} />
            <Button design="Emphasized" disabled={m.issues.length > 0 || !m.dirty || m.saving} onClick={m.save}>
              {m.saving ? "Saving…" : "Save model"}
            </Button>
          </>
        }
      />
      {m.saveError && m.serverIssues.length === 0 ? (
        <MessageStrip design="Negative" hideCloseButton>{m.saveError.message}</MessageStrip>
      ) : null}

      <ResponsivePopover opener="model-msgs" open={msgOpen} onClose={() => setMsgOpen(false)}>
        <MessageView showDetailsPageHeader={false}>
          {allIssues.map((i, idx) => (
            <MessageItem key={idx} type="Negative" titleText={i.message} subtitleText={i.path}
              onClick={() => jumpTo(i.path)} />
          ))}
        </MessageView>
        {allIssues.length === 0 ? <Text style={{ padding: "1rem" }}>Model is valid.</Text> : null}
      </ResponsivePopover>

      {/* Signature layout: editor left, live test-drive right. */}
      <SplitterLayout style={{ flex: "1 1 0", minHeight: 0, width: "100%" }}>
        <SplitterElement size="58%" minSize={480}>
          <TabContainer
            style={{ height: "100%", width: "100%" }}
            contentBackgroundDesign="Transparent"
            onTabSelect={(e) => setTab(((e.detail.tab as HTMLElement).dataset.key ?? "params") as TabKey)}
          >
            <Tab {...tabProps("params", "Parameters")}><Stub name="Parameters" /></Tab>
            <Tab {...tabProps("rules", "Rules")}><Stub name="Rules" /></Tab>
            <Tab {...tabProps("bom", "BOM")}><Stub name="BOM" /></Tab>
            <Tab {...tabProps("routing", "Routing")}><Stub name="Routing" /></Tab>
            <Tab {...tabProps("tables", "Tables")}><Stub name="Tables" /></Tab>
            <Tab {...tabProps("settings", "Settings")}>
              <SettingsTab draft={draft} update={m.update} issues={allIssues} />
            </Tab>
          </TabContainer>
        </SplitterElement>
        <SplitterElement minSize={320}>
          <Stub name="Live preview (Task 9)" />
        </SplitterElement>
      </SplitterLayout>
    </div>
  );
}
```

Note: a plain `Bar` header instead of the spec's `DynamicPage` — the builder is a fixed-height workbench (splitter + tabs); `DynamicPage`'s scroll-collapsing header has nothing to collapse and fights the splitter's height. The list page (Task 3) keeps `DynamicPage` per spec.

If `MessageViewButton`'s props differ (it's a small React helper), fall back to a plain `<Button id="model-msgs" icon="message-error" ...>{String(allIssues.length)}</Button>` — the popover/MessageView part is what matters.

- [ ] **Step 4: Swap the route placeholder**

`apps/web/src/routes/_authed/models/$id.tsx`:

```tsx
import { createFileRoute } from "@tanstack/react-router";
import { ModelBuilderPage } from "../../../components/configurator/ModelBuilderPage.tsx";

export const Route = createFileRoute("/_authed/models/$id")({ component: Builder });

function Builder() {
  const { id } = Route.useParams();
  return <ModelBuilderPage key={id} id={id} />;
}
```

- [ ] **Step 5: Typecheck + browser check**

Run: `bunx tsc --noEmit -p apps/web`
Expected: exits 0.

In the browser (`bun dev`): open a model →
- Settings tab edits name/pricing; typing `unitCost *` in the price expression turns the field Negative with `expected …` and the message button counts 1; Save disabled.
- Completing to `unitCost * 1.4` clears it; “Unsaved changes” shows; Save persists (reload → new value).
- Suggestion popover appears while typing `unit…` and click-completes.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src
git commit -m "feat(web): model builder shell — draft state, validation loop, save gate, settings tab"
```

---

### Task 5: Parameters tab — hierarchy, drag-reorder, param dialog

**Files:**
- Create: `apps/web/src/components/configurator/structureOps.ts`
- Test: `apps/web/src/components/configurator/structureOps.test.ts`
- Create: `apps/web/src/components/configurator/ParamsTab.tsx`
- Modify: `apps/web/src/components/configurator/ModelBuilderPage.tsx` (mount tab)

**Interfaces:**
- Consumes: `useDraftModel` contract, `ExprInput`, `orpc.models.lookupPreview` (raw `client`), `orpc.models.tables.list` data (passed as `tables`).
- Produces:
  - `structureOps.ts`: `type RowRef = {kind:"section",s:number} | {kind:"group",s:number,g:number} | {kind:"param",key:string}`; `parseRowKey(k: string): RowRef`; `rowKeyOf(r: RowRef): string` (`s:0`, `g:0.1`, `p:material`); `canDrop(def, srcKey, dstKey, placement): boolean`; `applyMove(def, srcKey, dstKey, placement): ModelDef`; `removeFromStructure(def, ref): ModelDef`; `placeParam(def, paramKey, s, g): ModelDef`; `unplacedParams(def): string[]`.
  - `<ParamsTab draft update issues tables />` mounted in the "params" Tab.

- [ ] **Step 1: Failing tests for the pure structure ops**

`structureOps.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import type { ModelDef } from "@hera/config-engine";
import { applyMove, canDrop, parseRowKey, placeParam, removeFromStructure, unplacedParams } from "./structureOps.ts";

const def = {
  name: "m",
  parameters: [
    { key: "a", label: "A", type: "string", ui: "input" },
    { key: "b", label: "B", type: "string", ui: "input" },
    { key: "c", label: "C", type: "string", ui: "input" },
    { key: "loose", label: "L", type: "string", ui: "input" },
  ],
  structure: {
    sections: [
      { key: "s1", title: "S1", groups: [{ key: "g1", title: "G1", params: ["a", "b"] }] },
      { key: "s2", title: "S2", groups: [{ key: "g2", title: "G2", params: ["c"] }] },
    ],
  },
  computed: [], constraints: [], bom: [], routing: [], queryTables: [],
  pricing: { priceExpr: "unitCost", quoteItemCode: "X" }, batchDefaults: [1],
} as ModelDef;

describe("structureOps", () => {
  test("parseRowKey round-trips", () => {
    expect(parseRowKey("s:1")).toEqual({ kind: "section", s: 1 });
    expect(parseRowKey("g:0.0")).toEqual({ kind: "group", s: 0, g: 0 });
    expect(parseRowKey("p:a")).toEqual({ kind: "param", key: "a" });
  });

  test("canDrop: param On group yes, param On section no, group Before group yes", () => {
    expect(canDrop(def, "p:a", "g:1.0", "On")).toBe(true);
    expect(canDrop(def, "p:a", "s:1", "On")).toBe(false);
    expect(canDrop(def, "g:0.0", "g:1.0", "Before")).toBe(true);
    expect(canDrop(def, "s:0", "s:1", "After")).toBe(true);
    expect(canDrop(def, "s:0", "g:1.0", "On")).toBe(false);
  });

  test("param dropped On another group moves across", () => {
    const out = applyMove(def, "p:a", "g:1.0", "On");
    expect(out.structure.sections[0]!.groups[0]!.params).toEqual(["b"]);
    expect(out.structure.sections[1]!.groups[0]!.params).toEqual(["c", "a"]);
  });

  test("param dropped Before a param in another group inserts there", () => {
    const out = applyMove(def, "p:b", "p:c", "Before");
    expect(out.structure.sections[1]!.groups[0]!.params).toEqual(["b", "c"]);
    expect(out.structure.sections[0]!.groups[0]!.params).toEqual(["a"]);
  });

  test("section reorder", () => {
    const out = applyMove(def, "s:1", "s:0", "Before");
    expect(out.structure.sections.map((s) => s.key)).toEqual(["s2", "s1"]);
  });

  test("removing a group keeps its params as unplaced", () => {
    const out = removeFromStructure(def, { kind: "group", s: 0, g: 0 });
    expect(out.structure.sections[0]!.groups).toEqual([]);
    expect(out.parameters.map((p) => p.key)).toContain("a"); // defs stay
    expect(unplacedParams(out)).toEqual(expect.arrayContaining(["a", "b", "loose"]));
  });

  test("placeParam appends and removes from any previous spot", () => {
    const out = placeParam(def, "loose", 1, 0);
    expect(out.structure.sections[1]!.groups[0]!.params).toEqual(["c", "loose"]);
    expect(unplacedParams(out)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test apps/web/src/components/configurator/structureOps.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `structureOps.ts`**

```ts
import type { ModelDef } from "@hera/config-engine";

// Pure structure-tree edits for the Parameters tab. All functions return new ModelDefs.

export type RowRef =
  | { kind: "section"; s: number }
  | { kind: "group"; s: number; g: number }
  | { kind: "param"; key: string };

export const rowKeyOf = (r: RowRef): string =>
  r.kind === "section" ? `s:${r.s}` : r.kind === "group" ? `g:${r.s}.${r.g}` : `p:${r.key}`;

export function parseRowKey(k: string): RowRef {
  if (k.startsWith("s:")) return { kind: "section", s: Number(k.slice(2)) };
  if (k.startsWith("g:")) {
    const [s, g] = k.slice(2).split(".").map(Number);
    return { kind: "group", s: s!, g: g! };
  }
  return { kind: "param", key: k.slice(2) };
}

export type Placement = "Before" | "After" | "On";

export function canDrop(_def: ModelDef, srcKey: string, dstKey: string, placement: Placement): boolean {
  const src = parseRowKey(srcKey);
  const dst = parseRowKey(dstKey);
  if (srcKey === dstKey) return false;
  if (src.kind === "param") return (dst.kind === "group" && placement === "On") || (dst.kind === "param" && placement !== "On");
  if (src.kind === "group") return (dst.kind === "section" && placement === "On") || (dst.kind === "group" && placement !== "On");
  return dst.kind === "section" && placement !== "On";
}

const stripParam = (def: ModelDef, key: string): ModelDef => ({
  ...def,
  structure: {
    sections: def.structure.sections.map((s) => ({
      ...s,
      groups: s.groups.map((g) => ({ ...g, params: g.params.filter((p) => p !== key) })),
    })),
  },
});

/** section/group indices of the group that contains a param, or null. */
function findParam(def: ModelDef, key: string): { s: number; g: number; i: number } | null {
  for (let s = 0; s < def.structure.sections.length; s++)
    for (let g = 0; g < def.structure.sections[s]!.groups.length; g++) {
      const i = def.structure.sections[s]!.groups[g]!.params.indexOf(key);
      if (i >= 0) return { s, g, i };
    }
  return null;
}

const editGroup = (def: ModelDef, s: number, g: number, fn: (params: string[]) => string[]): ModelDef => ({
  ...def,
  structure: {
    sections: def.structure.sections.map((sec, si) =>
      si !== s ? sec : { ...sec, groups: sec.groups.map((gr, gi) => (gi !== g ? gr : { ...gr, params: fn(gr.params) })) },
    ),
  },
});

export function applyMove(def: ModelDef, srcKey: string, dstKey: string, placement: Placement): ModelDef {
  if (!canDrop(def, srcKey, dstKey, placement)) return def;
  const src = parseRowKey(srcKey);
  const dst = parseRowKey(dstKey);

  if (src.kind === "param") {
    const without = stripParam(def, src.key);
    if (dst.kind === "group") return editGroup(without, dst.s, dst.g, (ps) => [...ps, src.key]);
    const at = findParam(without, (dst as { key: string }).key);
    if (!at) return def;
    return editGroup(without, at.s, at.g, (ps) => {
      const i = ps.indexOf((dst as { key: string }).key) + (placement === "After" ? 1 : 0);
      return [...ps.slice(0, i), src.key, ...ps.slice(i)];
    });
  }

  if (src.kind === "group") {
    const grp = def.structure.sections[src.s]!.groups[src.g]!;
    const sections = def.structure.sections.map((s, si) =>
      si === src.s ? { ...s, groups: s.groups.filter((_, gi) => gi !== src.g) } : s,
    );
    if (dst.kind === "section")
      return { ...def, structure: { sections: sections.map((s, si) => (si === dst.s ? { ...s, groups: [...s.groups, grp] } : s)) } };
    // Before/After another group: recompute dst indices against the filtered array
    const dstGrpKey = def.structure.sections[dst.s]!.groups[(dst as { g: number }).g]!.key;
    return {
      ...def,
      structure: {
        sections: sections.map((s) => {
          const gi = s.groups.findIndex((g) => g.key === dstGrpKey);
          if (gi < 0) return s;
          const at = gi + (placement === "After" ? 1 : 0);
          return { ...s, groups: [...s.groups.slice(0, at), grp, ...s.groups.slice(at)] };
        }),
      },
    };
  }

  // section reorder
  const sec = def.structure.sections[src.s]!;
  const rest = def.structure.sections.filter((_, i) => i !== src.s);
  const dstSecKey = def.structure.sections[(dst as { s: number }).s]!.key;
  const at = rest.findIndex((s) => s.key === dstSecKey) + (placement === "After" ? 1 : 0);
  return { ...def, structure: { sections: [...rest.slice(0, at), sec, ...rest.slice(at)] } };
}

export function removeFromStructure(def: ModelDef, ref: RowRef): ModelDef {
  if (ref.kind === "param") return stripParam(def, ref.key);
  if (ref.kind === "group")
    return {
      ...def,
      structure: {
        sections: def.structure.sections.map((s, si) =>
          si === ref.s ? { ...s, groups: s.groups.filter((_, gi) => gi !== ref.g) } : s,
        ),
      },
    };
  return { ...def, structure: { sections: def.structure.sections.filter((_, si) => si !== ref.s) } };
}

export function placeParam(def: ModelDef, key: string, s: number, g: number): ModelDef {
  return editGroup(stripParam(def, key), s, g, (ps) => [...ps, key]);
}

export function unplacedParams(def: ModelDef): string[] {
  const placed = new Set(def.structure.sections.flatMap((s) => s.groups.flatMap((g) => g.params)));
  return def.parameters.map((p) => p.key).filter((k) => !placed.has(k));
}
```

- [ ] **Step 4: Run the tests**

Run: `bun test apps/web/src/components/configurator/structureOps.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Implement `ParamsTab.tsx`**

```tsx
import { useState } from "react";
import {
  Bar, Button, BusyIndicator, CheckBox, Dialog, Input, Label, List, ListItemStandard, MessageStrip,
  Option, Select, StepInput, Table, TableCell, TableHeaderCell, TableHeaderRow, TableRow,
  TableRowAction, Text, Title,
} from "@ui5/webcomponents-react";
import type { Issue, LookupRef, ModelDef, Option as EngineOption, Param } from "@hera/config-engine";
import { client } from "../../orpc.ts";
import { ExprInput } from "./ExprInput.tsx";
import { issueFor } from "./useDraftModel.ts";
import { applyMove, canDrop, parseRowKey, placeParam, removeFromStructure, rowKeyOf, unplacedParams, type Placement } from "./structureOps.ts";

type Tables = { name: string; columns: { key: string }[] }[];
type Update = (fn: (d: ModelDef) => ModelDef) => void;

const UI_KINDS = ["input", "select", "radio", "checkbox", "multicombo", "step"] as const;

const emptyParam = (): Param => ({ key: "", label: "", type: "string", ui: "select" });

export function ParamsTab({ draft, update, issues, tables }: {
  draft: ModelDef; update: Update; issues: Issue[]; tables: Tables;
}) {
  const [editing, setEditing] = useState<{ param: Param; isNew: boolean } | null>(null);

  const rows: { key: string; depth: number; label: string; detail: string; ref: ReturnType<typeof parseRowKey> }[] = [];
  draft.structure.sections.forEach((s, si) => {
    rows.push({ key: `s:${si}`, depth: 0, label: s.title, detail: `section · ${s.key}`, ref: { kind: "section", s: si } });
    s.groups.forEach((g, gi) => {
      rows.push({ key: `g:${si}.${gi}`, depth: 1, label: g.title, detail: `group · ${g.key}`, ref: { kind: "group", s: si, g: gi } });
      g.params.forEach((pk) => {
        const p = draft.parameters.find((x) => x.key === pk);
        rows.push({
          key: `p:${pk}`, depth: 2, label: p?.label || pk,
          detail: p ? `${p.type} · ${p.ui}${p.domain ? (p.domain.kind === "range" ? " · range" : ` · ${p.domain.ref.source}`) : ""}` : "missing definition",
          ref: { kind: "param", key: pk },
        });
      });
    });
  });
  const loose = unplacedParams(draft);

  const saveParam = (p: Param, isNew: boolean, place?: { s: number; g: number }) =>
    update((d) => {
      const parameters = isNew
        ? [...d.parameters, p]
        : d.parameters.map((x) => (x.key === editing!.param.key || x.key === p.key ? p : x));
      let out = { ...d, parameters };
      if (isNew && place) out = placeParam(out, p.key, place.s, place.g);
      return out;
    });

  const deleteRow = (ref: ReturnType<typeof parseRowKey>) =>
    update((d) => {
      let out = removeFromStructure(d, ref);
      if (ref.kind === "param") out = { ...out, parameters: out.parameters.filter((p) => p.key !== ref.key) };
      return out;
    });

  const addKey = (base: string, taken: string[]) => {
    let k = base, n = 2;
    while (taken.includes(k)) k = `${base}${n++}`;
    return k;
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem", padding: "1rem" }}>
      <Bar design="Subheader"
        startContent={<Title level="H5">Form structure</Title>}
        endContent={
          <>
            <Button icon="add" onClick={() => update((d) => ({
              ...d,
              structure: { sections: [...d.structure.sections, { key: addKey("section", d.structure.sections.map((s) => s.key)), title: "New section", groups: [] }] },
            }))}>Add section</Button>
            <Button icon="add" disabled={!draft.structure.sections.length} onClick={() => update((d) => ({
              ...d,
              structure: {
                sections: d.structure.sections.map((s, i, arr) => i !== arr.length - 1 ? s : {
                  ...s, groups: [...s.groups, { key: addKey("group", s.groups.map((g) => g.key)), title: "New group", params: [] }],
                }),
              },
            }))}>Add group</Button>
            <Button icon="add" design="Emphasized" disabled={!draft.structure.sections.some((s) => s.groups.length)}
              onClick={() => setEditing({ param: emptyParam(), isNew: true })}>Add parameter</Button>
          </>
        }
      />

      <Table
        noDataText="Add a section to start structuring the form."
        rowActionCount={2}
        onMoveOver={(e) => {
          const src = (e.detail.source.element as HTMLElement | null)?.getAttribute("row-key");
          const dst = (e.detail.destination.element as HTMLElement | null)?.getAttribute("row-key");
          const placement = e.detail.destination.placement as Placement;
          if (src && dst && canDrop(draft, src, dst, placement)) e.preventDefault();
        }}
        onMove={(e) => {
          const src = (e.detail.source.element as HTMLElement | null)?.getAttribute("row-key");
          const dst = (e.detail.destination.element as HTMLElement | null)?.getAttribute("row-key");
          const placement = e.detail.destination.placement as Placement;
          if (src && dst) update((d) => applyMove(d, src, dst, placement));
        }}
        onRowActionClick={(e) => {
          const row = (e.detail.row as unknown) as HTMLElement;
          const action = (e.detail.action as unknown) as HTMLElement;
          const ref = parseRowKey(row.getAttribute("row-key")!);
          if (action.getAttribute("icon") === "delete") deleteRow(ref);
          else if (ref.kind === "param") {
            const p = draft.parameters.find((x) => x.key === ref.key);
            if (p) setEditing({ param: structuredClone(p), isNew: false });
          } else {
            // rename section/group inline via prompt-less flow: edit title in a tiny dialog would be
            // overkill; reuse the param dialog only for params. Title edits: click-to-edit input row.
            setTitleEdit(rowKeyOf(ref));
          }
        }}
        headerRow={
          <TableHeaderRow>
            <TableHeaderCell width="45%"><span>Structure</span></TableHeaderCell>
            <TableHeaderCell><span>Details</span></TableHeaderCell>
          </TableHeaderRow>
        }
      >
        {rows.map((r) => (
          <TableRow key={r.key} rowKey={r.key} movable
            actions={
              <>
                <TableRowAction icon="edit" text="Edit" />
                <TableRowAction icon="delete" text="Delete" />
              </>
            }>
            <TableCell>
              {titleEdit === r.key && r.ref.kind !== "param" ? (
                <Input
                  value={r.label}
                  onBlur={() => setTitleEdit(null)}
                  onInput={(e) => {
                    const title = e.target.value;
                    update((d) => ({
                      ...d,
                      structure: {
                        sections: d.structure.sections.map((s, si) => {
                          if (r.ref.kind === "section") return si === r.ref.s ? { ...s, title } : s;
                          return si === (r.ref as { s: number }).s
                            ? { ...s, groups: s.groups.map((g, gi) => (gi === (r.ref as { g: number }).g ? { ...g, title } : g)) }
                            : s;
                        }),
                      },
                    }));
                  }}
                />
              ) : (
                <Text style={{ paddingInlineStart: `${r.depth * 1.5}rem`, fontWeight: r.depth === 0 ? "bold" : "normal" }}>
                  {r.label}
                </Text>
              )}
            </TableCell>
            <TableCell><Text>{r.detail}</Text></TableCell>
          </TableRow>
        ))}
      </Table>

      {loose.length ? (
        <MessageStrip design="Critical" hideCloseButton>
          Not shown on the form: {loose.join(", ")} — drag them into a group or edit them to place them.
        </MessageStrip>
      ) : null}

      <Title level="H5">Computed values</Title>
      <Table noDataText="No computed values." rowActionCount={1}
        onRowActionClick={(e) => {
          const i = Number(((e.detail.row as unknown) as HTMLElement).dataset.idx);
          update((d) => ({ ...d, computed: d.computed.filter((_, j) => j !== i) }));
        }}
        headerRow={
          <TableHeaderRow>
            <TableHeaderCell><span>Key</span></TableHeaderCell>
            <TableHeaderCell width="60%"><span>Expression</span></TableHeaderCell>
          </TableHeaderRow>
        }>
        {draft.computed.map((c, i) => (
          <TableRow key={i} rowKey={`c-${i}`} data-idx={String(i)} actions={<TableRowAction icon="delete" text="Delete" />}>
            <TableCell>
              <Input value={c.key} onInput={(e) =>
                update((d) => ({ ...d, computed: d.computed.map((x, j) => (j === i ? { ...x, key: e.target.value } : x)) }))} />
            </TableCell>
            <TableCell>
              <ExprInput value={c.expr} model={draft} fieldId={`expr-computed[${i}].expr`}
                issue={issueFor(issues, `computed[${i}].expr`)}
                onChange={(v) => update((d) => ({ ...d, computed: d.computed.map((x, j) => (j === i ? { ...x, expr: v ?? "" } : x)) }))} />
            </TableCell>
          </TableRow>
        ))}
      </Table>
      <Button icon="add" style={{ alignSelf: "start" }}
        onClick={() => update((d) => ({ ...d, computed: [...d.computed, { key: addKey("value", [...d.parameters.map((p) => p.key), ...d.computed.map((c) => c.key)]), expr: "0" }] }))}>
        Add computed value
      </Button>

      {editing ? (
        <ParamDialog
          draft={draft} tables={tables} initial={editing.param} isNew={editing.isNew}
          onCancel={() => setEditing(null)}
          onOk={(p, place) => { saveParam(p, editing.isNew, place); setEditing(null); }}
        />
      ) : null}
    </div>
  );
}
```

Add the missing `titleEdit` state near the top of `ParamsTab`:

```tsx
  const [titleEdit, setTitleEdit] = useState<string | null>(null);
```

**`ParamDialog` + `LookupRefEditor`** (same file):

```tsx
function ParamDialog({ draft, tables, initial, isNew, onOk, onCancel }: {
  draft: ModelDef; tables: Tables; initial: Param; isNew: boolean;
  onOk: (p: Param, place?: { s: number; g: number }) => void; onCancel: () => void;
}) {
  const [p, setP] = useState<Param>(initial);
  const groups = draft.structure.sections.flatMap((s, si) =>
    s.groups.map((g, gi) => ({ s: si, g: gi, label: `${s.title} / ${g.title}` })));
  const [placeIdx, setPlaceIdx] = useState(0);
  const set = (patch: Partial<Param>) => setP((x) => ({ ...x, ...patch }));
  const keyOk = /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(p.key);
  const keyTaken = isNew && draft.parameters.some((x) => x.key === p.key);

  return (
    <Dialog open headerText={isNew ? "Add parameter" : `Edit ${initial.key}`} onClose={onCancel}
      style={{ width: "min(46rem, 90vw)" }}
      footer={
        <Bar design="Footer" endContent={
          <>
            <Button design="Emphasized" disabled={!keyOk || keyTaken || !p.label}
              onClick={() => onOk(p, isNew ? groups[placeIdx] : undefined)}>OK</Button>
            <Button onClick={onCancel}>Cancel</Button>
          </>
        } />
      }>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.75rem", padding: "0.5rem 0" }}>
        <div>
          <Label required>Key</Label>
          <Input value={p.key} disabled={!isNew} valueState={keyOk && !keyTaken ? "None" : "Negative"}
            valueStateMessage={<div>{keyTaken ? "Key already exists" : "Must be a valid identifier"}</div>}
            onInput={(e) => set({ key: e.target.value })} />
        </div>
        <div>
          <Label required>Label</Label>
          <Input value={p.label} onInput={(e) => set({ label: e.target.value })} />
        </div>
        <div>
          <Label>Type</Label>
          <Select value={p.type} onChange={(e) => set({ type: (e.detail.selectedOption as HTMLElement).dataset.v as Param["type"] })}>
            {(["string", "number", "boolean"] as const).map((t) => <Option key={t} value={t} data-v={t}>{t}</Option>)}
          </Select>
        </div>
        <div>
          <Label>Control</Label>
          <Select value={p.ui} onChange={(e) => set({ ui: (e.detail.selectedOption as HTMLElement).dataset.v as Param["ui"] })}>
            {UI_KINDS.map((u) => <Option key={u} value={u} data-v={u}>{u}</Option>)}
          </Select>
        </div>
        {isNew ? (
          <div style={{ gridColumn: "1 / -1" }}>
            <Label>Place in</Label>
            <Select value={String(placeIdx)} onChange={(e) => setPlaceIdx(Number((e.detail.selectedOption as HTMLElement).dataset.v))}>
              {groups.map((g, i) => <Option key={i} value={String(i)} data-v={String(i)}>{g.label}</Option>)}
            </Select>
          </div>
        ) : null}

        <div style={{ gridColumn: "1 / -1" }}>
          <Label>Value domain</Label>
          <DomainEditor draft={draft} tables={tables} value={p.domain} onChange={(domain) => set({ domain })} />
        </div>

        <div style={{ gridColumn: "1 / -1" }}>
          <Label>Default (expression)</Label>
          <ExprInput optional value={p.defaultExpr} model={draft} onChange={(v) => set({ defaultExpr: v })} />
        </div>
        <div>
          <Label>Visible when</Label>
          <ExprInput optional value={p.visibleWhen} model={draft} onChange={(v) => set({ visibleWhen: v })} />
        </div>
        <div>
          <Label>Required when</Label>
          <ExprInput optional value={p.requiredWhen} model={draft} onChange={(v) => set({ requiredWhen: v })} />
        </div>
        <div>
          <Label>Unit</Label>
          <Input value={p.unit ?? ""} onInput={(e) => set({ unit: e.target.value || undefined })} />
        </div>
        <div>
          <Label>Help text</Label>
          <Input value={p.help ?? ""} onInput={(e) => set({ help: e.target.value || undefined })} />
        </div>
      </div>
    </Dialog>
  );
}

function DomainEditor({ draft, tables, value, onChange }: {
  draft: ModelDef; tables: Tables;
  value: Param["domain"]; onChange: (d: Param["domain"]) => void;
}) {
  const kind = value === undefined ? "none" : value.kind === "range" ? "range" : value.ref.source;
  const tableNames = [...tables.map((t) => t.name), ...draft.queryTables.map((q) => q.name)];
  const columnsOf = (name: string) =>
    tables.find((t) => t.name === name)?.columns.map((c) => c.key) ??
    draft.queryTables.find((q) => q.name === name)?.columns ?? [];

  const setKind = (k: string) => {
    if (k === "none") onChange(undefined);
    else if (k === "range") onChange({ kind: "range", min: 0, max: 100, step: 1 });
    else if (k === "manual") onChange({ kind: "options", ref: { source: "manual", options: [] } });
    else if (k === "table") onChange({ kind: "options", ref: { source: "table", table: tableNames[0] ?? "", valueCol: "" } });
    else onChange({ kind: "options", ref: { source: "query", target: "b1", path: "", valueField: "" } });
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
      <Select value={kind} onChange={(e) => setKind((e.detail.selectedOption as HTMLElement).dataset.v!)}>
        {[["none", "None (free entry)"], ["manual", "Manual list"], ["table", "Table"], ["query", "Query (B1/Beas)"], ["range", "Number range"]]
          .map(([v, l]) => <Option key={v} value={v} data-v={v}>{l}</Option>)}
      </Select>

      {value?.kind === "range" ? (
        <div style={{ display: "flex", gap: "0.5rem" }}>
          <StepInput value={value.min} onChange={(e) => onChange({ ...value, min: e.target.value ?? 0 })} />
          <StepInput value={value.max} onChange={(e) => onChange({ ...value, max: e.target.value ?? 0 })} />
          <StepInput value={value.step ?? 1} min={0} onChange={(e) => onChange({ ...value, step: e.target.value || undefined })} />
        </div>
      ) : null}

      {value?.kind === "options" && value.ref.source === "manual" ? (
        <ManualOptions ref_={value.ref} onChange={(ref) => onChange({ kind: "options", ref })} />
      ) : null}

      {value?.kind === "options" && value.ref.source === "table" ? (
        <div style={{ display: "flex", gap: "0.5rem" }}>
          <Select value={value.ref.table} onChange={(e) => onChange({ kind: "options", ref: { ...value.ref, source: "table", table: (e.detail.selectedOption as HTMLElement).dataset.v!, valueCol: "" } })}>
            {tableNames.map((n) => <Option key={n} value={n} data-v={n}>{n}</Option>)}
          </Select>
          <Select value={value.ref.valueCol} onChange={(e) => onChange({ kind: "options", ref: { ...value.ref, valueCol: (e.detail.selectedOption as HTMLElement).dataset.v! } })}>
            <Option value="" data-v="">value column…</Option>
            {columnsOf(value.ref.table).map((c) => <Option key={c} value={c} data-v={c}>{c}</Option>)}
          </Select>
          <Select value={value.ref.labelCol ?? ""} onChange={(e) => {
            const v = (e.detail.selectedOption as HTMLElement).dataset.v!;
            onChange({ kind: "options", ref: { ...value.ref, labelCol: v || undefined } });
          }}>
            <Option value="" data-v="">label column (optional)…</Option>
            {columnsOf(value.ref.table).map((c) => <Option key={c} value={c} data-v={c}>{c}</Option>)}
          </Select>
        </div>
      ) : null}

      {value?.kind === "options" && value.ref.source === "query" ? (
        <div style={{ display: "grid", gridTemplateColumns: "8rem 1fr", gap: "0.5rem" }}>
          <Select value={value.ref.target} onChange={(e) => onChange({ kind: "options", ref: { ...value.ref, target: (e.detail.selectedOption as HTMLElement).dataset.v as "b1" | "beas" } })}>
            <Option value="b1" data-v="b1">B1</Option>
            <Option value="beas" data-v="beas">Beas</Option>
          </Select>
          <Input placeholder="/Items?$select=ItemCode,ItemName" value={value.ref.path}
            onInput={(e) => onChange({ kind: "options", ref: { ...value.ref, path: e.target.value } })} />
          <Input placeholder="value field, e.g. ItemCode" value={value.ref.valueField}
            onInput={(e) => onChange({ kind: "options", ref: { ...value.ref, valueField: e.target.value } })} />
          <Input placeholder="label field (optional)" value={value.ref.labelField ?? ""}
            onInput={(e) => onChange({ kind: "options", ref: { ...value.ref, labelField: e.target.value || undefined } })} />
        </div>
      ) : null}

      {value?.kind === "options" ? <PreviewButton ref_={value.ref} /> : null}
    </div>
  );
}

function ManualOptions({ ref_, onChange }: {
  ref_: Extract<LookupRef, { source: "manual" }>;
  onChange: (r: LookupRef) => void;
}) {
  const setOpt = (i: number, patch: { value?: string; label?: string }) =>
    onChange({
      ...ref_,
      options: ref_.options.map((o, j) => {
        if (j !== i) return o;
        const raw = patch.value;
        // numbers stay numbers so table constraints compare correctly
        const value = raw === undefined ? o.value : raw !== "" && !Number.isNaN(Number(raw)) ? Number(raw) : raw;
        return { value, label: patch.label !== undefined ? patch.label || undefined : o.label };
      }),
    });
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "0.25rem" }}>
      {ref_.options.map((o, i) => (
        <div key={i} style={{ display: "flex", gap: "0.5rem" }}>
          <Input placeholder="value" value={String(o.value ?? "")} onInput={(e) => setOpt(i, { value: e.target.value })} />
          <Input placeholder="label (optional)" value={o.label ?? ""} onInput={(e) => setOpt(i, { label: e.target.value })} />
          <Button icon="delete" design="Transparent"
            onClick={() => onChange({ ...ref_, options: ref_.options.filter((_, j) => j !== i) })} />
        </div>
      ))}
      <Button icon="add" style={{ alignSelf: "start" }}
        onClick={() => onChange({ ...ref_, options: [...ref_.options, { value: "" }] })}>Add option</Button>
    </div>
  );
}

function PreviewButton({ ref_ }: { ref_: LookupRef }) {
  const [state, setState] = useState<{ busy?: boolean; options?: EngineOption[]; error?: string }>({});
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "0.25rem" }}>
      <Button icon="show" style={{ alignSelf: "start" }} disabled={state.busy}
        onClick={async () => {
          setState({ busy: true });
          try {
            const r = await client.models.lookupPreview({ ref: ref_, limit: 20 });
            setState({ options: r.options });
          } catch (e) {
            setState({ error: e instanceof Error ? e.message : String(e) });
          }
        }}>
        {state.busy ? "Loading…" : "Preview options"}
      </Button>
      {state.error ? <MessageStrip design="Negative" hideCloseButton>{state.error}</MessageStrip> : null}
      {state.options ? (
        state.options.length ? (
          <List>{state.options.map((o, i) => <ListItemStandard key={i} additionalText={String(o.value)}>{o.label}</ListItemStandard>)}</List>
        ) : <Text>No options returned.</Text>
      ) : null}
    </div>
  );
}
```

- [ ] **Step 6: Mount in ModelBuilderPage**

Replace the params stub:

```tsx
            <Tab {...tabProps("params", "Parameters")}>
              <ParamsTab draft={draft} update={m.update} issues={allIssues} tables={m.tables} />
            </Tab>
```

with the import `import { ParamsTab } from "./ParamsTab.tsx";`.

- [ ] **Step 7: Typecheck + tests + browser check**

Run: `bunx tsc --noEmit -p apps/web && bun test apps/web/src/components/configurator`
Expected: exits 0; tests PASS.

Browser: add sections/groups/params (manual + range domains), drag a param between groups (drop marker appears only on legal targets), edit a param, preview a query lookup against the live agent (or see the agent-offline message), delete a group and watch its params land in the "Not shown on the form" strip.

- [ ] **Step 8: Commit**

```bash
git add apps/web/src
git commit -m "feat(web): parameters tab — structure hierarchy, drag-reorder, param dialog with lookup preview"
```

---

### Task 6: Rules tab — expression constraints + combination tables

**Files:**
- Create: `apps/web/src/components/configurator/RulesTab.tsx`
- Modify: `apps/web/src/components/configurator/ModelBuilderPage.tsx` (mount)

**Interfaces:**
- Consumes: `useDraftModel` contract, `ExprInput`, `lookups?: ResolvedLookups` (undefined until Task 9 wires the shared query; cells fall back to literal Inputs).
- Produces: `<RulesTab draft update issues lookups? />`.

- [ ] **Step 1: Implement `RulesTab.tsx`**

```tsx
import { useState } from "react";
import {
  Bar, Button, Dialog, Input, Label, MultiComboBox, MultiComboBoxItem, Option, Select,
  Table, TableCell, TableHeaderCell, TableHeaderRow, TableRow, TableRowAction, Text, Title,
} from "@ui5/webcomponents-react";
import type { Constraint, Issue, ModelDef, ResolvedLookups, Val } from "@hera/config-engine";
import { ExprInput } from "./ExprInput.tsx";
import { issueFor } from "./useDraftModel.ts";

type Update = (fn: (d: ModelDef) => ModelDef) => void;
type TableConstraint = Extract<Constraint, { kind: "table" }>;

// "true"/"false" -> boolean, numeric -> number, "" -> null, else string.
export const parseLit = (s: string): Val =>
  s === "" ? null : s === "true" ? true : s === "false" ? false : !Number.isNaN(Number(s)) ? Number(s) : s;

export function RulesTab({ draft, update, issues, lookups }: {
  draft: ModelDef; update: Update; issues: Issue[]; lookups?: ResolvedLookups;
}) {
  const [editingTable, setEditingTable] = useState<number | null>(null);
  const setC = (i: number, c: Constraint) =>
    update((d) => ({ ...d, constraints: d.constraints.map((x, j) => (j === i ? c : x)) }));
  const removeC = (i: number) => update((d) => ({ ...d, constraints: d.constraints.filter((_, j) => j !== i) }));

  const exprs = draft.constraints.map((c, i) => [c, i] as const).filter(([c]) => c.kind === "expr");
  const tablesC = draft.constraints.map((c, i) => [c, i] as const).filter(([c]) => c.kind === "table");

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem", padding: "1rem" }}>
      <Bar design="Subheader" startContent={<Title level="H5">Expression constraints</Title>}
        endContent={<Button icon="add" onClick={() => update((d) => ({ ...d, constraints: [...d.constraints, { kind: "expr", assert: "", message: "" }] }))}>Add constraint</Button>} />
      <Table noDataText="No expression constraints." rowActionCount={1}
        onRowActionClick={(e) => removeC(Number(((e.detail.row as unknown) as HTMLElement).dataset.idx))}
        headerRow={
          <TableHeaderRow>
            <TableHeaderCell width="28%"><span>When (optional)</span></TableHeaderCell>
            <TableHeaderCell width="36%"><span>Must hold</span></TableHeaderCell>
            <TableHeaderCell><span>Message</span></TableHeaderCell>
          </TableHeaderRow>
        }>
        {exprs.map(([c, i]) => c.kind === "expr" ? (
          <TableRow key={i} rowKey={`ec-${i}`} data-idx={String(i)} actions={<TableRowAction icon="delete" text="Delete" />}>
            <TableCell>
              <ExprInput optional value={c.when} model={draft} fieldId={`expr-constraints[${i}].when`}
                issue={issueFor(issues, `constraints[${i}].when`)}
                onChange={(v) => setC(i, { ...c, when: v })} />
            </TableCell>
            <TableCell>
              <ExprInput value={c.assert} model={draft} fieldId={`expr-constraints[${i}].assert`}
                issue={issueFor(issues, `constraints[${i}].assert`)} placeholder='e.g. coating != "none" || material == "steel"'
                onChange={(v) => setC(i, { ...c, assert: v ?? "" })} />
            </TableCell>
            <TableCell>
              <Input value={c.message} placeholder="Shown when violated"
                onInput={(e) => setC(i, { ...c, message: e.target.value })} />
            </TableCell>
          </TableRow>
        ) : null)}
      </Table>

      <Bar design="Subheader" startContent={<Title level="H5">Combination tables</Title>}
        endContent={<Button icon="add" onClick={() => {
          update((d) => ({ ...d, constraints: [...d.constraints, { kind: "table", params: [], rows: [], mode: "forbid" }] }));
          setEditingTable(draft.constraints.length); // index of the appended one
        }}>Add combination table</Button>} />
      <Table noDataText="No combination tables." rowActionCount={2}
        onRowActionClick={(e) => {
          const i = Number(((e.detail.row as unknown) as HTMLElement).dataset.idx);
          const icon = ((e.detail.action as unknown) as HTMLElement).getAttribute("icon");
          if (icon === "delete") removeC(i);
          else setEditingTable(i);
        }}
        headerRow={
          <TableHeaderRow>
            <TableHeaderCell><span>Parameters</span></TableHeaderCell>
            <TableHeaderCell><span>Mode</span></TableHeaderCell>
            <TableHeaderCell><span>Rows</span></TableHeaderCell>
          </TableHeaderRow>
        }>
        {tablesC.map(([c, i]) => c.kind === "table" ? (
          <TableRow key={i} rowKey={`tc-${i}`} data-idx={String(i)}
            actions={<><TableRowAction icon="edit" text="Edit" /><TableRowAction icon="delete" text="Delete" /></>}>
            <TableCell><Text>{c.params.join(" × ") || "—"}</Text></TableCell>
            <TableCell><Text>{c.mode}</Text></TableCell>
            <TableCell><Text>{String(c.rows.length)}</Text></TableCell>
          </TableRow>
        ) : null)}
      </Table>

      {editingTable !== null && draft.constraints[editingTable]?.kind === "table" ? (
        <ComboTableDialog
          draft={draft} lookups={lookups}
          value={draft.constraints[editingTable] as TableConstraint}
          onOk={(c) => { setC(editingTable, c); setEditingTable(null); }}
          onCancel={() => setEditingTable(null)}
        />
      ) : null}
    </div>
  );
}

function ComboTableDialog({ draft, lookups, value, onOk, onCancel }: {
  draft: ModelDef; lookups?: ResolvedLookups; value: TableConstraint;
  onOk: (c: TableConstraint) => void; onCancel: () => void;
}) {
  const [c, setCLocal] = useState<TableConstraint>(structuredClone(value));
  // Only finite params can appear in a combination table (checkModel enforces the same).
  const eligible = draft.parameters.filter((p) => p.domain?.kind === "options" || p.type === "boolean");
  const optionsFor = (key: string): Val[] | null => {
    const p = draft.parameters.find((x) => x.key === key);
    if (p?.type === "boolean") return [true, false];
    if (p?.domain?.kind === "options" && p.domain.ref.source === "manual") return p.domain.ref.options.map((o) => o.value);
    const dom = lookups?.domains[key];
    return dom ? dom.map((o) => o.value) : null;
  };

  const setParams = (params: string[]) =>
    setCLocal((x) => ({
      ...x,
      params,
      rows: x.rows.map((r) => params.map((k) => r[x.params.indexOf(k)] ?? null)),
    }));

  return (
    <Dialog open headerText="Combination table" onClose={onCancel} style={{ width: "min(52rem, 92vw)" }}
      footer={
        <Bar design="Footer" endContent={
          <>
            <Button design="Emphasized" disabled={c.params.length < 2} onClick={() => onOk(c)}>OK</Button>
            <Button onClick={onCancel}>Cancel</Button>
          </>
        } />
      }>
      <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem", padding: "0.5rem 0" }}>
        <div style={{ display: "flex", gap: "0.75rem", alignItems: "end" }}>
          <div style={{ flex: 1 }}>
            <Label required>Parameters (2+)</Label>
            <MultiComboBox
              onSelectionChange={(e) => setParams(e.detail.items.map((i) => (i as HTMLElement).getAttribute("text")!))}>
              {eligible.map((p) => (
                <MultiComboBoxItem key={p.key} text={p.key} selected={c.params.includes(p.key)} />
              ))}
            </MultiComboBox>
          </div>
          <div>
            <Label>Mode</Label>
            <Select value={c.mode} onChange={(e) => setCLocal((x) => ({ ...x, mode: (e.detail.selectedOption as HTMLElement).dataset.v as "allow" | "forbid" }))}>
              <Option value="allow" data-v="allow">Allow only these</Option>
              <Option value="forbid" data-v="forbid">Forbid these</Option>
            </Select>
          </div>
        </div>

        {c.params.length >= 2 ? (
          <Table noDataText="No rows yet." rowActionCount={1}
            onRowActionClick={(e) => {
              const r = Number(((e.detail.row as unknown) as HTMLElement).dataset.idx);
              setCLocal((x) => ({ ...x, rows: x.rows.filter((_, j) => j !== r) }));
            }}
            headerRow={
              <TableHeaderRow>
                {c.params.map((k) => <TableHeaderCell key={k}><span>{k}</span></TableHeaderCell>)}
              </TableHeaderRow>
            }>
            {c.rows.map((row, ri) => (
              <TableRow key={ri} rowKey={`r-${ri}`} data-idx={String(ri)} actions={<TableRowAction icon="delete" text="Delete" />}>
                {c.params.map((k, ci) => {
                  const opts = optionsFor(k);
                  const setCell = (v: Val) =>
                    setCLocal((x) => ({ ...x, rows: x.rows.map((r, j) => (j === ri ? r.map((cell, cj) => (cj === ci ? v : cell)) : r)) }));
                  return (
                    <TableCell key={k}>
                      {opts ? (
                        <Select value={JSON.stringify(row[ci] ?? null)}
                          onChange={(e) => setCell(JSON.parse((e.detail.selectedOption as HTMLElement).dataset.j!))}>
                          <Option value="null" data-j="null">—</Option>
                          {opts.map((v, oi) => (
                            <Option key={oi} value={JSON.stringify(v)} data-j={JSON.stringify(v)}>{String(v)}</Option>
                          ))}
                        </Select>
                      ) : (
                        <Input value={String(row[ci] ?? "")} onInput={(e) => setCell(parseLit(e.target.value))} />
                      )}
                    </TableCell>
                  );
                })}
              </TableRow>
            ))}
          </Table>
        ) : <Text>Pick at least two parameters, then add rows.</Text>}

        <Button icon="add" style={{ alignSelf: "start" }} disabled={c.params.length < 2}
          onClick={() => setCLocal((x) => ({ ...x, rows: [...x.rows, x.params.map(() => null)] }))}>Add row</Button>
      </div>
    </Dialog>
  );
}
```

- [ ] **Step 2: Mount in ModelBuilderPage** (`import { RulesTab } ...`; pass `lookups={undefined}` for now — Task 9 replaces it):

```tsx
            <Tab {...tabProps("rules", "Rules")}>
              <RulesTab draft={draft} update={m.update} issues={allIssues} />
            </Tab>
```

- [ ] **Step 3: Typecheck + browser check**

Run: `bunx tsc --noEmit -p apps/web` → exits 0.
Browser: add an expr constraint with a typo'd identifier → field turns Negative, Rules tab badge shows 1, MessageView jump focuses the field. Build a 2-param combination table with manual-domain Selects in cells.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src
git commit -m "feat(web): rules tab — expression constraints and combination tables"
```

---

### Task 7: BOM + Routing tabs (shared inline-expr table)

**Files:**
- Create: `apps/web/src/components/configurator/LinesTabs.tsx` (exports `BomTab`, `RoutingTab`)
- Modify: `apps/web/src/components/configurator/ModelBuilderPage.tsx` (mount both)

**Interfaces:**
- Consumes: `useDraftModel` contract, `ExprInput` (`extraVars={["qty"]}` everywhere here).
- Produces: `<BomTab draft update issues />`, `<RoutingTab draft update issues />`.

- [ ] **Step 1: Implement `LinesTabs.tsx`**

```tsx
import { Bar, Button, Input, StepInput, Table, TableCell, TableHeaderCell, TableHeaderRow, TableRow, TableRowAction, Text, Title } from "@ui5/webcomponents-react";
import type { Issue, ModelDef } from "@hera/config-engine";
import { ExprInput } from "./ExprInput.tsx";
import { issueFor } from "./useDraftModel.ts";

type Update = (fn: (d: ModelDef) => ModelDef) => void;
type Props = { draft: ModelDef; update: Update; issues: Issue[] };

const newId = (prefix: string, taken: string[]) => {
  let n = taken.length + 1;
  while (taken.includes(`${prefix}${n}`)) n++;
  return `${prefix}${n}`;
};

// 150% BOM: every line is an expression over params (+ qty); condition filters per configuration.
export function BomTab({ draft, update, issues }: Props) {
  const set = (i: number, patch: Partial<ModelDef["bom"][number]>) =>
    update((d) => ({ ...d, bom: d.bom.map((l, j) => (j === i ? { ...l, ...patch } : l)) }));
  const cell = (i: number, field: "itemCode" | "desc" | "condition" | "qty" | "price", optional = false, placeholder?: string) => (
    <ExprInput optional={optional} value={draft.bom[i]![field]} model={draft} extraVars={["qty"]}
      placeholder={placeholder} fieldId={`expr-bom[${i}].${field}`} issue={issueFor(issues, `bom[${i}].${field}`)}
      onChange={(v) => set(i, { [field]: optional ? v : (v ?? "") } as Partial<ModelDef["bom"][number]>)} />
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem", padding: "1rem" }}>
      <Bar design="Subheader" startContent={<Title level="H5">150% bill of materials</Title>}
        endContent={<Button icon="add" design="Emphasized" onClick={() =>
          update((d) => ({ ...d, bom: [...d.bom, { id: newId("line", d.bom.map((l) => l.id)), itemCode: '""', qty: "1", price: "0", scrapPct: 0 }] }))
        }>Add line</Button>} />
      <Text>Item, quantity and price are expressions; parameters and <code>qty</code> (batch size) are in scope. Condition decides whether the line applies.</Text>
      <Table noDataText="No BOM lines." rowActionCount={1} overflowMode="Scroll"
        onRowActionClick={(e) => {
          const i = Number(((e.detail.row as unknown) as HTMLElement).dataset.idx);
          update((d) => ({ ...d, bom: d.bom.filter((_, j) => j !== i) }));
        }}
        headerRow={
          <TableHeaderRow>
            <TableHeaderCell width="6rem"><span>Id</span></TableHeaderCell>
            <TableHeaderCell minWidth="11rem"><span>Item code</span></TableHeaderCell>
            <TableHeaderCell minWidth="11rem"><span>Description</span></TableHeaderCell>
            <TableHeaderCell minWidth="11rem"><span>Condition</span></TableHeaderCell>
            <TableHeaderCell minWidth="9rem"><span>Qty per unit</span></TableHeaderCell>
            <TableHeaderCell minWidth="9rem"><span>Unit price</span></TableHeaderCell>
            <TableHeaderCell width="7rem"><span>Scrap %</span></TableHeaderCell>
          </TableHeaderRow>
        }>
        {draft.bom.map((l, i) => (
          <TableRow key={i} rowKey={`bom-${i}`} data-idx={String(i)} actions={<TableRowAction icon="delete" text="Delete" />}>
            <TableCell><Input value={l.id} onInput={(e) => set(i, { id: e.target.value })} /></TableCell>
            <TableCell>{cell(i, "itemCode", false, '"CBL-STL" or a ternary')}</TableCell>
            <TableCell>{cell(i, "desc", true)}</TableCell>
            <TableCell>{cell(i, "condition", true, "always applies when empty")}</TableCell>
            <TableCell>{cell(i, "qty")}</TableCell>
            <TableCell>{cell(i, "price", false, 'number or LOOKUP(...)')}</TableCell>
            <TableCell><StepInput value={l.scrapPct} min={0} step={0.5} onChange={(e) => set(i, { scrapPct: e.target.value ?? 0 })} /></TableCell>
          </TableRow>
        ))}
      </Table>
    </div>
  );
}

export function RoutingTab({ draft, update, issues }: Props) {
  const set = (i: number, patch: Partial<ModelDef["routing"][number]>) =>
    update((d) => ({ ...d, routing: d.routing.map((o, j) => (j === i ? { ...o, ...patch } : o)) }));
  const cell = (i: number, field: "condition" | "setupMin" | "runMinPerUnit" | "ratePerHour", optional = false, placeholder?: string) => (
    <ExprInput optional={optional} value={draft.routing[i]![field]} model={draft} extraVars={["qty"]}
      placeholder={placeholder} fieldId={`expr-routing[${i}].${field}`} issue={issueFor(issues, `routing[${i}].${field}`)}
      onChange={(v) => set(i, { [field]: optional ? v : (v ?? "") } as Partial<ModelDef["routing"][number]>)} />
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem", padding: "1rem" }}>
      <Bar design="Subheader" startContent={<Title level="H5">150% routing</Title>}
        endContent={<Button icon="add" design="Emphasized" onClick={() =>
          update((d) => ({ ...d, routing: [...d.routing, { id: newId("op", d.routing.map((o) => o.id)), resource: "", setupMin: "0", runMinPerUnit: "0", ratePerHour: "60" }] }))
        }>Add operation</Button>} />
      <Text>Times are minutes, rate is cost per hour; all are expressions with <code>qty</code> in scope. Setup is amortized over the batch by the engine.</Text>
      <Table noDataText="No operations." rowActionCount={1} overflowMode="Scroll"
        onRowActionClick={(e) => {
          const i = Number(((e.detail.row as unknown) as HTMLElement).dataset.idx);
          update((d) => ({ ...d, routing: d.routing.filter((_, j) => j !== i) }));
        }}
        headerRow={
          <TableHeaderRow>
            <TableHeaderCell width="6rem"><span>Id</span></TableHeaderCell>
            <TableHeaderCell><span>Resource</span></TableHeaderCell>
            <TableHeaderCell minWidth="11rem"><span>Condition</span></TableHeaderCell>
            <TableHeaderCell minWidth="9rem"><span>Setup (min)</span></TableHeaderCell>
            <TableHeaderCell minWidth="9rem"><span>Run / unit (min)</span></TableHeaderCell>
            <TableHeaderCell minWidth="9rem"><span>Rate / hour</span></TableHeaderCell>
          </TableHeaderRow>
        }>
        {draft.routing.map((o, i) => (
          <TableRow key={i} rowKey={`op-${i}`} data-idx={String(i)} actions={<TableRowAction icon="delete" text="Delete" />}>
            <TableCell><Input value={o.id} onInput={(e) => set(i, { id: e.target.value })} /></TableCell>
            <TableCell><Input value={o.resource} placeholder="e.g. SAW-01" onInput={(e) => set(i, { resource: e.target.value })} /></TableCell>
            <TableCell>{cell(i, "condition", true, "always runs when empty")}</TableCell>
            <TableCell>{cell(i, "setupMin")}</TableCell>
            <TableCell>{cell(i, "runMinPerUnit")}</TableCell>
            <TableCell>{cell(i, "ratePerHour")}</TableCell>
          </TableRow>
        ))}
      </Table>
    </div>
  );
}
```

- [ ] **Step 2: Mount both tabs** (replace stubs, add import):

```tsx
            <Tab {...tabProps("bom", "BOM")}><BomTab draft={draft} update={m.update} issues={allIssues} /></Tab>
            <Tab {...tabProps("routing", "Routing")}><RoutingTab draft={draft} update={m.update} issues={allIssues} /></Tab>
```

- [ ] **Step 3: Typecheck + browser check**

Run: `bunx tsc --noEmit -p apps/web` → exits 0.
Browser: add BOM lines/ops, reference a parameter in a qty expr via the suggestion popover, break one → tab badge + save gate; `LOOKUP("nope", ...)` in a price expr flags `unknown table 'nope'` on the exact literal.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src
git commit -m "feat(web): BOM and routing tabs with inline expression editing"
```

---

### Task 8: Tables tab — config_table designer with TSV paste

**Files:**
- Create: `apps/web/src/components/configurator/TablesTab.tsx`
- Modify: `apps/web/src/components/configurator/ModelBuilderPage.tsx` (mount)

**Interfaces:**
- Consumes: `orpc.models.tables.list/save/remove` (this tab persists **independently** of the model draft — tables are tenant-wide).
- Produces: `<TablesTab />` (self-contained; invalidates `models.tables.list` so `useDraftModel`'s `checkModel` sees new table names immediately).

- [ ] **Step 1: Implement `TablesTab.tsx`**

```tsx
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Bar, Button, BusyIndicator, Input, Label, List, ListItemStandard, MessageStrip, Option, Select,
  Table, TableCell, TableHeaderCell, TableHeaderRow, TableRow, TableRowAction, Text, Title,
} from "@ui5/webcomponents-react";
import type { Val } from "@hera/config-engine";
import { orpc } from "../../orpc.ts";

type Col = { key: string; label: string; type: "string" | "number" | "boolean" };
type Draft = { id?: string; name: string; columns: Col[]; rows: Val[][] };

const empty = (): Draft => ({ name: "", columns: [{ key: "key", label: "Key", type: "string" }], rows: [] });

export function TablesTab() {
  const qc = useQueryClient();
  const listQ = useQuery(orpc.models.tables.list.queryOptions());
  const invalidate = () => qc.invalidateQueries({ queryKey: orpc.models.tables.list.queryOptions().queryKey });
  const [draft, setDraft] = useState<Draft | null>(null);

  const save = useMutation(orpc.models.tables.save.mutationOptions({ onSuccess: invalidate }));
  const remove = useMutation(
    orpc.models.tables.remove.mutationOptions({
      onSuccess: () => {
        invalidate();
        setDraft(null);
      },
    }),
  );

  if (listQ.isPending) return <BusyIndicator active delay={0} style={{ width: "100%", marginTop: "2rem" }} />;

  const typed = (col: Col, raw: string): Val =>
    col.type === "number" ? (raw === "" ? null : Number(raw)) : col.type === "boolean" ? raw === "true" : raw;

  // Excel/Sheets clipboard = TSV. Types applied per column.
  const pasteRows = (text: string) => {
    const parsed = text.split(/\r?\n/).filter((l) => l.trim() !== "")
      .map((l) => l.split("\t"));
    setDraft((d) => d && ({
      ...d,
      rows: [...d.rows, ...parsed.map((cells) => d.columns.map((c, i) => typed(c, cells[i] ?? "")))],
    }));
  };

  return (
    <div style={{ display: "flex", gap: "1rem", padding: "1rem", alignItems: "flex-start" }}>
      <div style={{ width: "16rem", flexShrink: 0 }}>
        <Bar design="Subheader" startContent={<Title level="H5">Lookup tables</Title>}
          endContent={<Button icon="add" onClick={() => setDraft(empty())} tooltip="New table" />} />
        <List
          onItemClick={(e) => {
            const id = (e.detail.item as HTMLElement).dataset.id!;
            const t = (listQ.data ?? []).find((x) => x.id === id);
            if (t) setDraft({ id: t.id, name: t.name, columns: t.columns as Col[], rows: t.rows as Val[][] });
          }}>
          {(listQ.data ?? []).map((t) => (
            <ListItemStandard key={t.id} data-id={t.id} additionalText={`${(t.rows as Val[][]).length} rows`}>{t.name}</ListItemStandard>
          ))}
        </List>
      </div>

      {draft ? (
        <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: "0.75rem" }}>
          {save.error ? <MessageStrip design="Negative" hideCloseButton>{save.error.message}</MessageStrip> : null}
          {save.isSuccess ? <MessageStrip design="Positive" hideCloseButton>Saved.</MessageStrip> : null}
          <div style={{ display: "flex", gap: "0.75rem", alignItems: "end" }}>
            <div style={{ flex: 1 }}>
              <Label required>Name (referenced by LOOKUP and table domains)</Label>
              <Input value={draft.name} onInput={(e) => setDraft({ ...draft, name: e.target.value })} />
            </div>
            <Button design="Emphasized" disabled={!draft.name.trim() || !draft.columns.length || save.isPending}
              onClick={() => save.mutate({ id: draft.id, name: draft.name.trim(), columns: draft.columns, rows: draft.rows })}>
              {save.isPending ? "Saving…" : "Save table"}
            </Button>
            {draft.id ? (
              <Button design="Negative" disabled={remove.isPending} onClick={() => remove.mutate({ id: draft.id! })}>Delete</Button>
            ) : null}
          </div>

          <Title level="H6">Columns</Title>
          {draft.columns.map((c, i) => (
            <div key={i} style={{ display: "flex", gap: "0.5rem" }}>
              <Input placeholder="key" value={c.key} onInput={(e) => setDraft({ ...draft, columns: draft.columns.map((x, j) => (j === i ? { ...x, key: e.target.value } : x)) })} />
              <Input placeholder="label" value={c.label} onInput={(e) => setDraft({ ...draft, columns: draft.columns.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)) })} />
              <Select value={c.type} onChange={(e) => setDraft({ ...draft, columns: draft.columns.map((x, j) => (j === i ? { ...x, type: (e.detail.selectedOption as HTMLElement).dataset.v as Col["type"] } : x)) })}>
                {(["string", "number", "boolean"] as const).map((t) => <Option key={t} value={t} data-v={t}>{t}</Option>)}
              </Select>
              <Button icon="delete" design="Transparent" onClick={() =>
                setDraft({ ...draft, columns: draft.columns.filter((_, j) => j !== i), rows: draft.rows.map((r) => r.filter((_, j) => j !== i)) })} />
            </div>
          ))}
          <Button icon="add" style={{ alignSelf: "start" }} onClick={() =>
            setDraft({ ...draft, columns: [...draft.columns, { key: `col${draft.columns.length + 1}`, label: "", type: "string" }], rows: draft.rows.map((r) => [...r, null]) })}>
            Add column
          </Button>

          <Title level="H6">Rows</Title>
          <Text>Tip: paste cells from a spreadsheet anywhere in the grid below.</Text>
          <div onPaste={(e) => { e.preventDefault(); pasteRows(e.clipboardData.getData("text")); }}>
            <Table noDataText="No rows — add one or paste from a spreadsheet." rowActionCount={1}
              onRowActionClick={(e) => {
                const i = Number(((e.detail.row as unknown) as HTMLElement).dataset.idx);
                setDraft({ ...draft, rows: draft.rows.filter((_, j) => j !== i) });
              }}
              headerRow={
                <TableHeaderRow>
                  {draft.columns.map((c) => <TableHeaderCell key={c.key}><span>{c.key}</span></TableHeaderCell>)}
                </TableHeaderRow>
              }>
              {draft.rows.map((row, ri) => (
                <TableRow key={ri} rowKey={`row-${ri}`} data-idx={String(ri)} actions={<TableRowAction icon="delete" text="Delete" />}>
                  {draft.columns.map((c, ci) => (
                    <TableCell key={ci}>
                      <Input value={String(row[ci] ?? "")} onInput={(e) =>
                        setDraft({ ...draft, rows: draft.rows.map((r, j) => (j === ri ? r.map((cell, cj) => (cj === ci ? typed(c, e.target.value) : cell)) : r)) })} />
                    </TableCell>
                  ))}
                </TableRow>
              ))}
            </Table>
          </div>
          <Button icon="add" style={{ alignSelf: "start" }}
            onClick={() => setDraft({ ...draft, rows: [...draft.rows, draft.columns.map(() => null as Val)] })}>Add row</Button>
        </div>
      ) : (
        <Text style={{ marginTop: "2rem" }}>Select a table or create a new one.</Text>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Mount** (replace stub): `<Tab {...tabProps("tables", "Tables")}><TablesTab /></Tab>`

- [ ] **Step 3: Typecheck + browser check**

Run: `bunx tsc --noEmit -p apps/web` → exits 0.
Browser: create a table `colors` (columns code/name), paste two TSV rows from a spreadsheet, save; open a param dialog → Table domain now offers `colors` with its columns; duplicate-name save shows the server's message.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src
git commit -m "feat(web): tables tab — tenant lookup-table designer with TSV paste"
```

---

### Task 9: Live preview — usePreviewLookups, ConfiguratorForm, PreviewPane

**Files:**
- Create: `apps/web/src/components/configurator/usePreviewLookups.ts`
- Create: `apps/web/src/components/configurator/ConfiguratorForm.tsx`
- Create: `apps/web/src/components/configurator/PreviewPane.tsx`
- Modify: `apps/web/src/components/configurator/ModelBuilderPage.tsx` (mount pane; pass `lookups` to RulesTab)

**Interfaces:**
- Consumes: `orpc.models.previewLookups` (Task 1), engine `propagate`/`Propagation`/`Entries`/`ResolvedLookups`.
- Produces:
  - `usePreviewLookups(draft: ModelDef)` → TanStack query of `ResolvedLookups` keyed by a **lookup skeleton** (domain refs + queryTables only) so expression edits never refetch.
  - `<ConfiguratorForm model lookups entries onChange />` — **pure controlled component, reused verbatim by the phase-4 wizard step 1** (spec requirement). Renders sections→groups→params from `propagate()`, eliminated options disabled/filtered with the constraint name, computed values read-only, sticky status line.

- [ ] **Step 1: `usePreviewLookups.ts`**

```ts
import { useQuery } from "@tanstack/react-query";
import type { ModelDef } from "@hera/config-engine";
import { orpc } from "../../orpc.ts";

// Only domain refs and queryTables affect lookup resolution. Sending this skeleton (instead of
// the full draft) keeps the TanStack query key stable while the admin types expressions, so the
// agent is only hit when a lookup source actually changes.
export function lookupSkeleton(d: ModelDef): ModelDef {
  return {
    name: "",
    parameters: d.parameters.map((p) => ({ key: p.key, label: "", type: p.type, ui: p.ui, domain: p.domain })),
    structure: { sections: [] },
    computed: [],
    constraints: [],
    bom: [],
    routing: [],
    queryTables: d.queryTables,
    pricing: { priceExpr: "0", quoteItemCode: "X" },
    batchDefaults: [1],
  };
}

export function usePreviewLookups(draft: ModelDef) {
  return useQuery({
    ...orpc.models.previewLookups.queryOptions({ input: { definition: lookupSkeleton(draft) } }),
    staleTime: 5 * 60_000, // matches the server-side configs.lookups cache window
    retry: false, // agent-offline should show its message, not spin
  });
}
```

- [ ] **Step 2: `ConfiguratorForm.tsx`**

```tsx
import { useMemo } from "react";
import {
  Bar, CheckBox, Form, FormGroup, FormItem, Input, Label, MessageStrip, MultiComboBox,
  MultiComboBoxItem, ObjectStatus, Option, Panel, RadioButton, Select, StepInput, Text,
} from "@ui5/webcomponents-react";
import { propagate, type DomainOption, type Entries, type ModelDef, type ResolvedLookups, type Val } from "@hera/config-engine";

// The one form both the builder preview and the phase-4 wizard render. Fully controlled:
// entries in, entries out; all engine work happens in propagate().

export function ConfiguratorForm({ model, lookups, entries, onChange }: {
  model: ModelDef;
  lookups: ResolvedLookups;
  entries: Entries;
  onChange: (next: Entries) => void;
}) {
  const prop = useMemo(() => propagate(model, lookups, entries), [model, lookups, entries]);

  const set = (key: string, v: Val | undefined) => {
    const next = { ...entries };
    if (v === undefined) delete next[key];
    else next[key] = v;
    onChange(next);
  };

  const control = (key: string) => {
    const p = model.parameters.find((x) => x.key === key)!;
    const dom: DomainOption[] = prop.domains[key] ?? [];
    const v = prop.values[key];

    if (p.ui === "radio")
      return (
        <div style={{ display: "flex", flexWrap: "wrap", gap: "0.25rem 1rem" }}>
          {dom.map((o, i) => (
            <RadioButton key={i} name={`cfg-${key}`} text={o.label} checked={v === o.value}
              disabled={!!o.eliminatedBy} tooltip={o.eliminatedBy ? `Unavailable: ${o.eliminatedBy}` : undefined}
              onChange={() => set(key, o.value)} />
          ))}
        </div>
      );

    if (p.ui === "checkbox" || (p.type === "boolean" && p.ui !== "select"))
      return (
        <CheckBox checked={v === true}
          disabled={!!dom.find((o) => o.value === (v !== true))?.eliminatedBy}
          tooltip={dom.find((o) => !!o.eliminatedBy)?.eliminatedBy}
          onChange={(e) => set(key, e.target.checked)} />
      );

    if (p.ui === "multicombo")
      return (
        // MultiComboBoxItem has no disabled prop -> eliminated options are filtered out.
        <MultiComboBox
          onSelectionChange={(e) => {
            const texts = e.detail.items.map((i) => (i as HTMLElement).getAttribute("text")!);
            set(key, texts.length ? texts : undefined);
          }}>
          {dom.filter((o) => !o.eliminatedBy).map((o, i) => (
            <MultiComboBoxItem key={i} text={String(o.value)} selected={Array.isArray(v) && v.includes(String(o.value))} />
          ))}
        </MultiComboBox>
      );

    if (p.ui === "step") {
      const r = p.domain?.kind === "range" ? p.domain : undefined;
      return (
        <StepInput value={typeof v === "number" ? v : undefined} min={r?.min} max={r?.max} step={r?.step ?? 1}
          onChange={(e) => set(key, e.target.value ?? undefined)} />
      );
    }

    if (dom.length) // select (and boolean-with-select)
      return (
        <Select value={v === undefined ? "" : JSON.stringify(v)}
          onChange={(e) => {
            const j = (e.detail.selectedOption as HTMLElement).dataset.j;
            set(key, j === undefined || j === "" ? undefined : (JSON.parse(j) as Val));
          }}>
          <Option value="" data-j="">—</Option>
          {dom.map((o, i) => (
            <Option key={i} value={JSON.stringify(o.value)} data-j={JSON.stringify(o.value)}
              tooltip={o.eliminatedBy ? `Unavailable: ${o.eliminatedBy}` : undefined}
              additionalText={o.eliminatedBy ? "unavailable" : undefined}
              // Option supports disabled at runtime (ListItemBase); the React typing omits it.
              {...(o.eliminatedBy ? ({ disabled: true } as Record<string, unknown>) : {})}>
              {o.label}
            </Option>
          ))}
        </Select>
      );

    return (
      <Input type={p.type === "number" ? "Number" : "Text"} value={v === undefined || v === null ? "" : String(v)}
        onChange={(e) => {
          const raw = e.target.value ?? "";
          set(key, raw === "" ? undefined : p.type === "number" ? Number(raw) : raw);
        }} />
    );
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      <div style={{ flex: 1, overflowY: "auto", display: "flex", flexDirection: "column", gap: "0.75rem", padding: "1rem" }}>
        {model.structure.sections.map((s) => (
          <Panel key={s.key} headerText={s.title}>
            <Form labelSpan="S12 M4" layout="S1 M1 L1 XL1">
              {s.groups.map((g) => (
                <FormGroup key={g.key} headerText={g.title}>
                  {g.params.filter((k) => prop.visible[k]).map((k) => {
                    const p = model.parameters.find((x) => x.key === k);
                    if (!p) return null;
                    return (
                      <FormItem key={k} labelContent={<Label>{p.label + (p.unit ? ` (${p.unit})` : "")}</Label>}>
                        <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", width: "100%" }}>
                          {control(k)}
                          {prop.defaulted.has(k) ? <ObjectStatus state="Information">auto</ObjectStatus> : null}
                        </div>
                      </FormItem>
                    );
                  })}
                </FormGroup>
              ))}
            </Form>
          </Panel>
        ))}
        {model.computed.length ? (
          <Panel headerText="Computed" collapsed>
            <Form labelSpan="S12 M4" layout="S1 M1 L1 XL1">
              <FormGroup>
                {model.computed.map((c) => (
                  <FormItem key={c.key} labelContent={<Label>{c.key}</Label>}>
                    <Text>{String(prop.values[c.key] ?? "—")}</Text>
                  </FormItem>
                ))}
              </FormGroup>
            </Form>
          </Panel>
        ) : null}
      </div>

      {/* Sticky status: the signature answer to "is this consistent and how big is it?" */}
      {prop.conflicts.length ? (
        <MessageStrip design="Negative" hideCloseButton style={{ margin: "0 1rem 0.5rem" }}>
          {prop.conflicts.map((c) => c.message).join(" · ")}
        </MessageStrip>
      ) : (
        <Bar design="Footer"
          startContent={
            <Text>
              ✓ Consistent · {prop.open.length} open · ~{prop.candidateEstimate} candidate{prop.candidateEstimate === 1 ? "" : "s"}
            </Text>
          }
        />
      )}
    </div>
  );
}
```

- [ ] **Step 3: `PreviewPane.tsx`**

```tsx
import { useRef, useState } from "react";
import { Bar, Button, BusyIndicator, MessageStrip, Text, Title } from "@ui5/webcomponents-react";
import { DslError, type Entries, type Issue, type ModelDef } from "@hera/config-engine";
import { ConfiguratorForm } from "./ConfiguratorForm.tsx";
import { usePreviewLookups } from "./usePreviewLookups.ts";

// Test-drives the draft with the real engine. While the draft has errors we keep rendering the
// last valid draft (with a hint) so one bad keystroke doesn't blank the preview.
export function PreviewPane({ draft, issues }: { draft: ModelDef; issues: Issue[] }) {
  const [entries, setEntries] = useState<Entries>({});
  const lastGood = useRef<ModelDef>(draft);
  if (issues.length === 0) lastGood.current = draft;
  const model = issues.length === 0 ? draft : lastGood.current;

  const lookups = usePreviewLookups(model);

  let body: React.ReactNode;
  if (lookups.isPending) body = <BusyIndicator active delay={200} style={{ width: "100%", marginTop: "3rem" }} />;
  else if (lookups.error)
    body = (
      <div style={{ padding: "1rem", display: "flex", flexDirection: "column", gap: "0.5rem" }}>
        <MessageStrip design="Negative" hideCloseButton>{lookups.error.message}</MessageStrip>
        <Button style={{ alignSelf: "start" }} onClick={() => lookups.refetch()}>Retry</Button>
      </div>
    );
  else {
    try {
      body = <ConfiguratorForm model={model} lookups={lookups.data} entries={entries} onChange={setEntries} />;
    } catch (e) {
      body = (
        <MessageStrip design="Negative" hideCloseButton style={{ margin: "1rem" }}>
          {e instanceof DslError ? e.message : String(e)}
        </MessageStrip>
      );
    }
  }

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", minHeight: 0 }}>
      <Bar design="Subheader"
        startContent={<Title level="H5">Live preview</Title>}
        endContent={
          <Button design="Transparent" icon="reset" onClick={() => setEntries({})}>Reset entries</Button>
        }
      />
      {issues.length > 0 ? (
        <MessageStrip design="Critical" hideCloseButton>
          Showing the last valid version — fix {issues.length} error{issues.length === 1 ? "" : "s"} to preview the current draft.
        </MessageStrip>
      ) : null}
      {body}
    </div>
  );
}
```

- [ ] **Step 4: Wire into ModelBuilderPage**

Replace the right `SplitterElement` stub and hand `lookups` to RulesTab:

```tsx
        <SplitterElement minSize={320}>
          <PreviewPane draft={draft} issues={m.issues} />
        </SplitterElement>
```

In the page component, above `return`, add `const lookups = usePreviewLookups(draft);` and pass `lookups={lookups.data}` to `<RulesTab …/>` (the same query key/skeleton → shared cache with `PreviewPane`, no double fetch).

- [ ] **Step 5: Typecheck + browser check**

Run: `bunx tsc --noEmit -p apps/web` → exits 0.
Browser (the acceptance walk of the whole phase-3 spec loop):
- Selecting a value greys forbidden options elsewhere with the constraint name in the tooltip; status flips `✓ Consistent · N open · ~M candidates` live.
- Typing a broken expression flips the preview to "showing the last valid version"; fixing it restores instantly.
- Typing in expression fields fires **no** `previewLookups` request (watch the network panel); changing a domain ref or queryTable does.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src
git commit -m "feat(web): live preview — shared ConfiguratorForm with propagation, status bar, draft lookups"
```

---

### Task 10: Verification sweep + end-to-end builder walk

**Files:** none (verification only; fix-ups as needed).

- [ ] **Step 1: Full typecheck + tests**

```bash
bun install
bun test packages/config-engine apps/server apps/agent apps/web/src/components/configurator
bunx tsc --noEmit -p apps/server && bunx tsc --noEmit -p apps/web && bunx tsc --noEmit -p apps/agent && bunx tsc --noEmit -p packages/db
```
Expected: all PASS, all exit 0.

- [ ] **Step 2: Build the spec's demo model through the UI (e2e)**

`bun dev`; as admin on `http://acme.lvh.me:5173`, build the cable-assembly demo from the spec end to end **through the builder UI only**:
1. Tables tab: table `prices` (columns `material` string / `price_per_mm2` number) with rows `steel/0.03`, `alu/0.02`.
2. New model "Cable assembly": params `material` (select, manual: steel/alu), `cross_section` (select, manual numbers 10/16/25), `coating` (select, manual: none/pvc/silicone); computed `area = cross_section * 1.1`.
3. Rules: expr constraint `material == "alu" ? cross_section >= 16 : true` message "Aluminium needs ≥16mm²"; combination table forbid (material=alu, coating=silicone).
4. BOM: line `conductor` qty `cross_section * 0.01` price `LOOKUP("prices", "material", material, "price_per_mm2")`; conditional line `coat` with condition `coating != "none"`.
5. Routing: `cut` (setup 10, run 0.5, rate 60); conditional `coatop` on `coating != "none"`.
6. Preview: pick alu → cross_section 10 disabled with the constraint message; coating silicone disabled by the combination table; status shows consistent + candidate math; Reset works.
7. Save; reload the page; everything persists; Save disabled until next change.

Record what was verified (or what broke and was fixed) in the final report.

- [ ] **Step 3: Remnant/scope check**

```bash
grep -rn "config-engine" apps/web/src --include="*.ts*" | head -5
```
Expected: real imports now exist (the workspace dep is no longer dead). `git status --short` → clean.

- [ ] **Step 4: Commit stragglers (if any fix-ups happened)**

```bash
git status --short   # review, then commit with a fitting message
```

---

## Self-review notes (spec phase-3 coverage)

- Builder `models/$id`: SplitterLayout editor-left/preview-right ✓; live preview = same `ConfiguratorForm` the wizard will use, client `propagate()` on the unsaved draft ✓ (lookups via new `models.previewLookups`, skeleton-keyed).
- Parameters tab: single Table, indented section/group/param hierarchy, native drag via `TableRow movable` + `onMoveOver`/`onMove`, `TableRowAction` edit/delete, param Dialog with domain sources (manual editor | table picker + column map | query target+path+field map with Preview via `models.lookupPreview`) ✓; computed values editable here too (spec leaves their home unspecified).
- Rules: expr constraints (when/assert/message) + combination tables with allow/forbid grid dialog ✓.
- BOM/Routing tabs: 150% lines/ops, condition + expr fields, scrap%, rate ✓ (item ValueHelp collapsed into exprs — the engine's `itemCode` *is* an expression; lookup-driven item picking rides `LOOKUP`/query domains).
- Tables designer: columns + grid + clipboard TSV paste ✓.
- ExprInput: monospace, parse-on-change, `valueState=Negative` with span-accurate message, key/function suggestion Popover; save blocked while invalid; header MessageView aggregates and jumps ✓. `// ponytail: suggestions complete the trailing token; caret-aware later`.
- Error handling: DSL errors blocked at save (client `checkModel` + server gate with `data.issues` merged back) ✓; agent offline surfaces `assertAgentReady` message with Retry ✓; lookup failure names source + path (message comes from `lookups.ts`) ✓.
- Nav: "Configurator models" admin-gated like Settings ✓. Lists stay plain (no VariantManagement) per spec ✓.
- Deviations, each justified inline: builder header is a `Bar` not `DynamicPage` (fixed-height workbench); `MultiComboBoxItem` can't be disabled → eliminated options filtered; no delete-confirm dialog on models (server refuses in-use deletes).
- Out of scope (later phases): wizard/configs UI (phase 4), `createQuote`/B1 (phase 5), dirty-navigation guard, VariantManagement, semantic autocomplete.
