import { useMemo, useState, useEffect } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient, skipToken } from "@tanstack/react-query";
import {
  ObjectPage, ObjectPageSection, ObjectPageTitle, Bar, Button, Input, SuggestionItem, Title, Text, Label, MessageStrip, BusyIndicator,
  Table, TableHeaderRow, TableHeaderCell, TableRow, TableCell,
  Dialog, TabContainer, Tab, Select, Option, Switch, FlexBox, ObjectStatus,
  Toolbar, ToolbarButton, Icon, SplitterLayout, SplitterElement,
} from "@ui5/webcomponents-react";
import type { Model, FormSection, FormGroup, FormItem, DataSource, InputType, Value, PredefinedFormula, EngineModel, Rule, GuidedRule, GuidedCond } from "@hera/config-engine";
import { flatten, enumerate, lintModel, compileGuided, idsIn, compile } from "@hera/config-engine";
import { orpc } from "../orpc.ts";
import { uid, blankModel, blankSection, blankGroup, blankItem, blankFormula, allItems, trailingToken, applyExprPick, keyOf, parseKey, locateIssue, type Key, type Issue } from "../lib/model.ts";
import { ModelRuntime } from "./Configurator.tsx";
import "./ModelBuilder.css";


// An autocomplete suggestion offered in an expression input: an identifier (a field or a formula
// name) + a short detail (the formula's expression, or a field descriptor) shown after it.
type Suggest = { name: string; detail: string };

type Editing = { sid: string; gid?: string; iid?: string } | null;

// Structural shapes for the UI5 Table drag/click events — avoids importing the wrapper's event types.
type RowEl = HTMLElement;
type MoveEvt = { preventDefault(): void; detail: { source: { element: RowEl }; destination: { element: RowEl; placement: string } } };
type RowClickEvt = { detail: { row: RowEl } };

const parseValues = (s: string): Value[] =>
  s.split(",").map((x) => x.trim()).filter(Boolean).map((x) => (x !== "" && !isNaN(Number(x)) ? Number(x) : x));
const joinValues = (v?: Value[]): string => (v ?? []).join(", ");

// Guided-rule editing helpers (see RulesPanel). OPS = the comparators a guided condition offers.
const OPS: GuidedCond["op"][] = ["==", "!=", "<", "<=", ">", ">="];
// Free-text guided value -> typed: numeric strings become numbers (price/numeric rules need real numbers).
const coerceVal = (s: string): Value => (s !== "" && !isNaN(Number(s)) ? Number(s) : s);
// Map a stringified option back to its original typed domain value (lossless — engine string-compares).
const fromDom = (dom: Value[], s: string): Value | undefined => dom.find((v) => String(v) === s);

// Slide the preview pane open/closed by animating its flex-basis (see the SplitterLayout below).
const PANE_ANIM = "flex-basis 0.28s cubic-bezier(0.2, 0, 0, 1)";

export function ModelBuilder({ id }: { id: string }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const isNew = id === "new";

  const get = useQuery(orpc.models.get.queryOptions({ input: isNew ? skipToken : { id } }));
  const masterdata = useQuery(orpc.masterdata.list.queryOptions());

  const [model, setModel] = useState<Model>(blankModel());
  const [editing, setEditing] = useState<Editing>(null);
  const [editingFormula, setEditingFormula] = useState<string | null>(null);
  // Live preview: run the configurator runtime against the in-memory model. Hidden by default.
  const [showPreview, setShowPreview] = useState(false);
  // Animate flex-basis only during a button toggle, never while dragging the splitter (drag mutates the
  // size directly, and a transition there would feel laggy). Cleared on the slide's transitionend.
  const [animating, setAnimating] = useState(false);
  // ponytail: Table has no native hierarchy/expand feature — gate child rows in render + a chevron.
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const toggle = (k: string) =>
    setCollapsed((c) => { const n = new Set(c); n.has(k) ? n.delete(k) : n.add(k); return n; });

  useEffect(() => {
    if (!isNew && get.data) {
      // Coerce a legacy/partial definition into the current shape so the builder never crashes.
      const def = get.data.definition as unknown as Partial<Model>;
      setModel({ name: def.name ?? "Model", family: def.family ?? "", sections: def.sections ?? [], rules: def.rules ?? [], formulas: def.formulas ?? [] });
    }
  }, [isNew, get.data]);

  const em = useMemo<EngineModel>(() => flatten(model), [model]);

  // Everything referenceable from an expression: predefined formulas + every field (manual input)
  // + every item-derived formula. Drives the SuggestionItem autocomplete in every expression input.
  const suggestions = useMemo<Suggest[]>(
    () => [
      ...(model.formulas ?? []).map((f) => ({ name: f.name, detail: f.expr || "formula" })),
      ...allItems(model).map((it) =>
        it.input.value.kind === "formula"
          ? { name: it.name, detail: (it.input.value as { expr: string }).expr || "formula" }
          : { name: it.name, detail: `field · ${it.input.inputType}` },
      ),
    ],
    [model],
  );

  const errors = useMemo(() => lintModel(model), [model]);
  const preview = useMemo(() => {
    if (errors.length) return null;
    try {
      return enumerate(em, {}, { cap: 200 });
    } catch {
      return null;
    }
  }, [em, errors]);

  const save = useMutation(
    orpc.models.save.mutationOptions({
      onSuccess: (r) => {
        qc.invalidateQueries({ queryKey: orpc.models.list.queryOptions().queryKey });
        if (isNew) navigate({ to: "/models/$id", params: { id: r.id } });
      },
    }),
  );
  const publish = useMutation(
    orpc.models.publish.mutationOptions({
      onSuccess: () => qc.invalidateQueries({ queryKey: orpc.models.list.queryOptions().queryKey }),
    }),
  );

  // Map a failed save's input-validation issues onto rows (keyed like keyOf), so each bad section/group/
  // item shows its own error. Persists until the next Save attempt — so the user can fix every flagged
  // row before re-validating. ponytail: indices resolve against the *current* model, so a reorder/delete
  // between a failed save and the fix can mislabel a row; clears on the next save.
  const rowErrors = useMemo(() => {
    const map = new Map<string, string[]>();
    const issues = (save.error as { data?: { issues?: Issue[] } } | null)?.data?.issues;
    for (const issue of issues ?? []) {
      const loc = locateIssue(issue.path, model);
      if (!loc) continue;
      const msg = loc.field ? `${loc.field}: ${issue.message}` : issue.message;
      const arr = map.get(loc.key);
      arr ? arr.push(msg) : map.set(loc.key, [msg]);
    }
    return map;
  }, [save.error, model]);

  // A flagged row may sit under a collapsed section/group — reveal its ancestors when a new error lands.
  // Keyed on save.error only (not rowErrors), so a manual collapse after the error isn't fought on edit.
  useEffect(() => {
    if (!rowErrors.size) return;
    setCollapsed((c) => {
      const n = new Set(c);
      for (const key of rowErrors.keys()) {
        const [kind, sid, gid] = key.split(":");
        if (kind === "g" || kind === "i") n.delete(keyOf({ kind: "s", sid: sid! }));
        if (kind === "i") n.delete(keyOf({ kind: "g", sid: sid!, gid: gid! }));
      }
      return n;
    });
  }, [save.error]);

  // --- immutable tree edits (section -> group -> item) ---
  const patchSection = (sid: string, fn: (s: FormSection) => FormSection) =>
    setModel((m) => ({ ...m, sections: m.sections.map((s) => (s.id === sid ? fn(s) : s)) }));
  const patchGroup = (sid: string, gid: string, fn: (g: FormGroup) => FormGroup) =>
    patchSection(sid, (s) => ({ ...s, groups: s.groups.map((g) => (g.id === gid ? fn(g) : g)) }));
  const patchItem = (sid: string, gid: string, iid: string, fn: (it: FormItem) => FormItem) =>
    patchGroup(sid, gid, (g) => ({ ...g, items: g.items.map((it) => (it.id === iid ? fn(it) : it)) }));

  const addSection = () => setModel((m) => ({ ...m, sections: [...m.sections, blankSection()] }));
  const removeSection = (sid: string) => setModel((m) => ({ ...m, sections: m.sections.filter((s) => s.id !== sid) }));
  const addGroup = (sid: string) => patchSection(sid, (s) => ({ ...s, groups: [...s.groups, blankGroup()] }));
  const removeGroup = (sid: string, gid: string) => patchSection(sid, (s) => ({ ...s, groups: s.groups.filter((g) => g.id !== gid) }));
  const addItem = (sid: string, gid: string) => patchGroup(sid, gid, (g) => ({ ...g, items: [...g.items, blankItem()] }));
  const removeItem = (sid: string, gid: string, iid: string) => patchGroup(sid, gid, (g) => ({ ...g, items: g.items.filter((it) => it.id !== iid) }));
  // Clone in place (right after the original). Fresh id + name suffix — the engine keys on `name`, so a
  // same-name clone would lint as a duplicate. input is replaced-not-mutated everywhere, so a shallow copy is safe.
  const duplicateItem = (sid: string, gid: string, iid: string) =>
    patchGroup(sid, gid, (g) => ({
      ...g,
      items: g.items.flatMap((it) => (it.id === iid ? [it, { ...it, id: uid(), name: it.name + "_" + uid().slice(0, 4) }] : [it])),
    }));

  // --- predefined formulas: a global flat list (referenceable from any expression), edited in a
  // modal like everything else. The table placement (under a field / at the foot) is cosmetic.
  const patchFormula = (fid: string, fn: (f: PredefinedFormula) => PredefinedFormula) =>
    setModel((m) => ({ ...m, formulas: (m.formulas ?? []).map((f) => (f.id === fid ? fn(f) : f)) }));
  const addFormula = (itemId?: string) => {
    const f = blankFormula(itemId);
    setModel((m) => ({ ...m, formulas: [...(m.formulas ?? []), f] }));
    setEditingFormula(f.id); // open its dialog straight away
  };
  const removeFormula = (fid: string) =>
    setModel((m) => ({ ...m, formulas: (m.formulas ?? []).filter((f) => f.id !== fid) }));
  const duplicateFormula = (fid: string) =>
    setModel((m) => ({
      ...m,
      formulas: (m.formulas ?? []).flatMap((f) => (f.id === fid ? [f, { ...f, id: uid(), name: f.name + "_" + uid().slice(0, 4) }] : [f])),
    }));

  // One read-only formula row (the formula is global; `pad` is just how deep it sits under a field).
  // Click the row to edit it in a modal.
  const formulaRow = (f: PredefinedFormula, pad: string) => (
    <TableRow key={f.id} interactive rowKey={`f:${f.id}`} data-fid={f.id}>
      <TableCell style={{ gridColumn: "1 / -1" }}>
        <FlexBox alignItems="Center" style={{ gap: "0.5rem", width: "100%", paddingInlineStart: pad, paddingInlineEnd: "0.5rem" }}>
          <Icon name="simulate" />
          <Text maxLines={1} style={{ fontWeight: 600 }}>{f.name}</Text>
          <Text maxLines={1} style={{ opacity: 0.7, flex: 1, minWidth: 0 }}>= {f.expr || "—"}</Text>
          <Button className="hera-row-action" icon="copy" design="Transparent" onClick={() => duplicateFormula(f.id)} tooltip="Duplicate formula" />
          <Button className="hera-row-action" icon="delete" design="Transparent" onClick={() => removeFormula(f.id)} tooltip="Delete formula" />
        </FlexBox>
      </TableCell>
    </TableRow>
  );

  // --- reorder via the Table's native movable rows (replaces the old HTML5 DnD) ---
  // ponytail: moves are restricted to like-kind rows (section↔section etc.); cross-level drops are ignored.
  const moveSection = (fromSid: string, toSid: string, after: boolean) =>
    setModel((m) => {
      const arr = m.sections.slice();
      const fi = arr.findIndex((s) => s.id === fromSid);
      if (fi < 0) return m;
      const [x] = arr.splice(fi, 1);
      const ti = arr.findIndex((s) => s.id === toSid);
      arr.splice(ti < 0 ? arr.length : after ? ti + 1 : ti, 0, x!);
      return { ...m, sections: arr };
    });
  const moveGroup = (from: Key, to: Key, after: boolean) =>
    setModel((m) => {
      let moved: FormGroup | undefined;
      const stripped = m.sections.map((s) =>
        s.id === from.sid ? { ...s, groups: s.groups.filter((g) => (g.id === from.gid ? ((moved = g), false) : true)) } : s,
      );
      if (!moved) return m;
      return {
        ...m,
        sections: stripped.map((s) => {
          if (s.id !== to.sid) return s;
          const groups = s.groups.slice();
          const ti = groups.findIndex((g) => g.id === to.gid);
          groups.splice(ti < 0 ? groups.length : after ? ti + 1 : ti, 0, moved!);
          return { ...s, groups };
        }),
      };
    });
  const moveItem = (from: Key, to: Key, after: boolean) =>
    setModel((m) => {
      let moved: FormItem | undefined;
      const stripped = m.sections.map((s) => ({
        ...s,
        groups: s.groups.map((g) =>
          s.id === from.sid && g.id === from.gid
            ? { ...g, items: g.items.filter((it) => (it.id === from.iid ? ((moved = it), false) : true)) }
            : g,
        ),
      }));
      if (!moved) return m;
      return {
        ...m,
        sections: stripped.map((s) => ({
          ...s,
          groups: s.groups.map((g) => {
            if (!(s.id === to.sid && g.id === to.gid)) return g;
            const items = g.items.slice();
            const ti = items.findIndex((it) => it.id === to.iid);
            items.splice(ti < 0 ? items.length : after ? ti + 1 : ti, 0, moved!);
            return { ...g, items };
          }),
        })),
      };
    });

  const onMoveOver = (e: MoveEvt) => {
    const src = parseKey(e.detail.source.element.dataset.key);
    const dst = parseKey(e.detail.destination.element.dataset.key);
    if (src && dst && src.kind === dst.kind) e.preventDefault(); // only like-kind drops are allowed
  };
  const onMove = (e: MoveEvt) => {
    const src = parseKey(e.detail.source.element.dataset.key);
    const dst = parseKey(e.detail.destination.element.dataset.key);
    if (!src || !dst || src.kind !== dst.kind) return;
    const after = e.detail.destination.placement !== "Before";
    if (src.kind === "s") moveSection(src.sid, dst.sid, after);
    else if (src.kind === "g") moveGroup(src, dst, after);
    else moveItem(src, dst, after);
  };
  const onRowClick = (e: RowClickEvt) => {
    const el = e.detail.row;
    if (el.dataset.fid) { setEditingFormula(el.dataset.fid); return; }
    const k = parseKey(el.dataset.key);
    if (k?.kind === "i") setEditing({ sid: k.sid, gid: k.gid, iid: k.iid });
    else if (k?.kind === "g") setEditing({ sid: k.sid, gid: k.gid });
    else if (k?.kind === "s") setEditing({ sid: k.sid });
  };

  if (!isNew && get.isPending) return <BusyIndicator active style={{ margin: "2rem" }} />;

  const es = editing ? model.sections.find((s) => s.id === editing.sid) : undefined;
  const eg = editing?.gid && es ? es.groups.find((g) => g.id === editing.gid) : undefined;
  const ei = editing?.iid && eg ? eg.items.find((it) => it.id === editing.iid) : undefined;
  const ef = editingFormula ? (model.formulas ?? []).find((f) => f.id === editingFormula) : undefined;

  // Formulas whose anchor field is gone (or never had one) render at the table foot, not under a field.
  const itemIds = new Set(allItems(model).map((it) => it.id));
  const looseFormulas = (model.formulas ?? []).filter((f) => !f.itemId || !itemIds.has(f.itemId));

  // Section/group header rows: one cell spanning every column (`grid-column: 1 / -1` — the Table row is a
  // CSS grid), so the band tint and the trailing buttons run the full width instead of cramping cell 1.
  // Section rows get the Fiori group-header treatment (group bg + top/bottom group-header border); group
  // rows stay a lighter sub-band so the hierarchy still reads.
  const spanCell = (level: "section" | "group", firstSection = false): React.CSSProperties =>
    level === "section"
      ? {
          gridColumn: "1 / -1",
          background: "var(--sapList_GroupHeaderBackground)",
          borderBlockEnd: "1px solid var(--sapList_GroupHeaderBorderColor)",
          // first section's top border would collapse with the header row's bottom border — skip it
          ...(firstSection ? {} : { borderBlockStart: "1px solid var(--sapList_GroupHeaderBorderColor)" }),
        }
      : { gridColumn: "1 / -1", background: "var(--sapNeutralBackground)" };

  const editor = (
    <ObjectPage
      mode="IconTabBar"
      hidePinButton
      titleArea={
        <ObjectPageTitle
          header={<Title level="H4">Model builder</Title>}
          actionsBar={
            <Toolbar design="Transparent">
              <ToolbarButton icon="add" text="Add section" onClick={addSection} />
              <ToolbarButton icon="show" text={showPreview ? "Hide preview" : "Preview"} onClick={() => { setAnimating(true); setShowPreview((v) => !v); }} />
              <ToolbarButton
                design="Emphasized"
                text={save.isPending ? "Saving…" : "Save"}
                disabled={save.isPending || errors.length > 0}
                onClick={() => save.mutate({ id: isNew ? undefined : id, definition: model })}
              />
              {!isNew && get.data ? (
                <ToolbarButton
                  text={get.data.published ? "Unpublish" : "Publish"}
                  disabled={publish.isPending}
                  onClick={() => publish.mutate({ id, published: !get.data!.published })}
                />
              ) : null}
            </Toolbar>
          }
        />
      }
    >
      <ObjectPageSection id="fields" titleText="Fields">
      <FlexBox direction="Column" style={{ gap: "1rem", padding: "0.5rem 0" }}>
        <FlexBox alignItems="Center" style={{ gap: "1rem", flexWrap: "wrap" }}>
          <Label>Name</Label>
          <Input value={model.name} onInput={(e) => setModel((m) => ({ ...m, name: e.target.value }))} />
          <Label>Family</Label>
          <Input value={model.family} onInput={(e) => setModel((m) => ({ ...m, family: e.target.value }))} />
        </FlexBox>

        {save.error ? (
          <MessageStrip design="Negative" hideCloseButton>
            {rowErrors.size ? `${save.error.message} — ${rowErrors.size} row(s) flagged below.` : save.error.message}
          </MessageStrip>
        ) : null}
        {errors.length ? (
          <MessageStrip design="Negative" hideCloseButton>{errors.join(" · ")}</MessageStrip>
        ) : (
          <MessageStrip design="Positive" hideCloseButton>
            {preview ? `${preview.solutions.length}${preview.truncated ? "+" : ""} possible configuration(s)` : "Model is valid"}
          </MessageStrip>
        )}

        {/* One flat table: section header rows, group header rows, item rows — drag any row to reorder. */}
        <Table
          headerRow={
            // When columns don't fit, drop them right-to-left instead of growing the row height.
            // popinHidden = hide the column rather than pop it into a taller area; importance sets the
            // drop order (lowest first), so Value drops first … and Description (primary) never drops.
            <TableHeaderRow>
              <TableHeaderCell importance={4}>Description</TableHeaderCell>
              <TableHeaderCell importance={3} popinHidden>Name</TableHeaderCell>
              <TableHeaderCell importance={2} popinHidden>Input</TableHeaderCell>
              <TableHeaderCell importance={1} popinHidden>Data source</TableHeaderCell>
              <TableHeaderCell importance={0} popinHidden>Value</TableHeaderCell>
            </TableHeaderRow>
          }
          noDataText="No sections yet — use “Add section”."
          onMove={onMove}
          onMoveOver={onMoveOver}
          onRowClick={onRowClick}
          overflowMode="Popin"
        >
          {model.sections.flatMap((s, si) => {
            const sk = keyOf({ kind: "s", sid: s.id });
            return [
              <TableRow key={s.id} interactive movable rowKey={sk} data-key={sk}>
                <TableCell style={spanCell("section", si === 0)}>
                  <HeaderCell
                    level="section"
                    label={s.label}
                    visibility={s.visibility}
                    error={rowErrors.get(sk)?.join("\n")}
                    collapsed={collapsed.has(sk)}
                    onToggle={() => toggle(sk)}
                    onAdd={() => addGroup(s.id)}
                    addTooltip="Add group"
                    onDelete={() => removeSection(s.id)}
                  />
                </TableCell>
              </TableRow>,
              ...(collapsed.has(sk) ? [] : s.groups.flatMap((g) => {
                const gk = keyOf({ kind: "g", sid: s.id, gid: g.id });
                return [
                  <TableRow key={g.id} interactive movable rowKey={gk} data-key={gk}>
                    <TableCell style={spanCell("group")}>
                      <HeaderCell
                        level="group"
                        label={g.label}
                        visibility={g.visibility}
                        error={rowErrors.get(gk)?.join("\n")}
                        collapsed={collapsed.has(gk)}
                        onToggle={() => toggle(gk)}
                        onAdd={() => addItem(s.id, g.id)}
                        addTooltip="Add field"
                        onDelete={() => removeGroup(s.id, g.id)}
                      />
                    </TableCell>
                  </TableRow>,
                  ...(collapsed.has(gk) ? [] : g.items.flatMap((it) => {
                    const ik = keyOf({ kind: "i", sid: s.id, gid: g.id, iid: it.id });
                    const itErr = rowErrors.get(ik)?.join("\n");
                    return [
                      <TableRow key={it.id} interactive movable rowKey={ik} data-key={ik}>
                        <TableCell>
                          <FlexBox alignItems="Center" title={itErr ?? undefined} style={{ gap: "0.375rem", paddingInlineStart: "3rem" }}>
                            {itErr ? <Icon name="error" style={{ color: "var(--sapNegativeColor)" }} /> : null}
                            <Text maxLines={1} style={itErr ? { color: "var(--sapNegativeColor)" } : undefined}>{it.label}{it.input.mandatory ? " *" : ""}</Text>
                          </FlexBox>
                        </TableCell>
                        <TableCell><Text maxLines={1}>{it.name}</Text></TableCell>
                        <TableCell><Text maxLines={1}>{it.input.inputType}</Text></TableCell>
                        <TableCell><Text maxLines={1}>{it.input.dataSource.kind}</Text></TableCell>
                        <TableCell>
                          <FlexBox alignItems="Center" style={{ gap: "0.5rem", width: "100%", paddingInlineEnd: "0.5rem" }}>
                            <Text maxLines={1} style={{ flex: 1, minWidth: 0 }}>
                              {it.input.value.kind === "formula" ? `= ${it.input.value.expr}` : "manual"}
                            </Text>
                            <Button className="hera-row-action" icon="simulate" design="Transparent" onClick={() => addFormula(it.id)} tooltip="Add formula" />
                            <Button className="hera-row-action" icon="copy" design="Transparent" onClick={() => duplicateItem(s.id, g.id, it.id)} tooltip="Duplicate field" />
                            <Button className="hera-row-action" icon="delete" design="Transparent" onClick={() => removeItem(s.id, g.id, it.id)} tooltip="Delete field" />
                          </FlexBox>
                        </TableCell>
                      </TableRow>,
                      // global formulas anchored under this field, one level deeper
                      ...(model.formulas ?? []).filter((f) => f.itemId === it.id).map((f) => formulaRow(f, "4.5rem")),
                    ];
                  })),
                ];
              })),
            ];
          })}

          {/* Formulas not anchored to a field (added globally, or whose field was deleted). The per-field
              ƒ button anchors others under their item. ponytail: "simulate" is the fx-looking SAP icon. */}
          {looseFormulas.map((f) => formulaRow(f, "3rem"))}
        </Table>
      </FlexBox>

      {ei ? (
        <ItemDialog
          item={ei}
          masterdata={masterdata.data ?? []}
          suggestions={suggestions}
          onClose={() => setEditing(null)}
          onChange={(fn) => patchItem(editing!.sid, editing!.gid!, editing!.iid!, fn)}
        />
      ) : eg ? (
        <NodeDialog
          title="Group"
          label={eg.label}
          visibility={eg.visibility}
          suggestions={suggestions}
          onClose={() => setEditing(null)}
          onLabel={(v) => patchGroup(editing!.sid, editing!.gid!, (g) => ({ ...g, label: v }))}
          onVisibility={(v) => patchGroup(editing!.sid, editing!.gid!, (g) => ({ ...g, visibility: v }))}
        />
      ) : es ? (
        <NodeDialog
          title="Section"
          label={es.label}
          visibility={es.visibility}
          suggestions={suggestions}
          onClose={() => setEditing(null)}
          onLabel={(v) => patchSection(editing!.sid, (s) => ({ ...s, label: v }))}
          onVisibility={(v) => patchSection(editing!.sid, (s) => ({ ...s, visibility: v }))}
        />
      ) : null}

      {ef ? (
        <FormulaDialog
          formula={ef}
          suggestions={suggestions}
          onClose={() => setEditingFormula(null)}
          onChange={(fn) => patchFormula(ef.id, fn)}
          onDelete={() => { removeFormula(ef.id); setEditingFormula(null); }}
        />
      ) : null}
      </ObjectPageSection>

      <ObjectPageSection id="constraints" titleText="Constraints">
        <RulesPanel model={model} setModel={setModel} suggestions={suggestions} />
      </ObjectPageSection>
    </ObjectPage>
  );

  return (
    // SplitterElement.size maps to flex-basis (grow:0), so we drive width from explicit sizes and keep
    // BOTH panes mounted — animating flex-basis slides the preview open/closed instead of snapping.
    // Collapsed = 0% width, no min-size, resizer hidden (preview not resizable) so no stray splitter bar.
    // ponytail: a hidden preview still re-runs the engine per keystroke (cheap at authoring size); `active`
    // only gates the B1 datasource fetch so a hidden pane never calls the agent.
    <SplitterLayout
      style={{ height: "100%" }}
      onTransitionEnd={(e) => { if (e.propertyName === "flex-basis") setAnimating(false); }}
    >
      <SplitterElement size={showPreview ? "60%" : "100%"} minSize={420} style={{ transition: animating ? PANE_ANIM : undefined }}>
        {editor}
      </SplitterElement>
      <SplitterElement
        size={showPreview ? "40%" : "0%"}
        minSize={showPreview ? 360 : 0}
        resizable={showPreview}
        style={{ transition: animating ? PANE_ANIM : undefined }}
      >
        {/* read-only preview; no allowCreate. modelId undefined for a never-saved "new" model. */}
        <div style={{ flex: 1, minWidth: 0, height: "100%", overflow: "auto", opacity: showPreview ? 1 : 0, transition: "opacity 0.28s ease" }}>
          <ModelRuntime model={model} modelId={isNew ? undefined : id} active={showPreview} />
        </div>
      </SplitterElement>
    </SplitterLayout>
  );
}

// An expression field with field+formula autocomplete: typing offers matching identifiers (name +
// detail) via UI5 SuggestionItem; picking one completes the trailing identifier in place (see
// applyExprPick). Expression errors surface via lintModel in the status strip, not inline.
function ExprInput({ value, onChange, suggestions, placeholder, style, valueState, valueStateMessage }: {
  value: string;
  onChange: (v: string) => void;
  suggestions: Suggest[];
  placeholder?: string;
  style?: React.CSSProperties;
  valueState?: "None" | "Information" | "Positive" | "Critical" | "Negative";
  valueStateMessage?: string;
}) {
  // ponytail: trailing-token completion only; caret-aware mid-expression insert if it ever matters.
  const token = trailingToken(value).toLowerCase();
  const matches = suggestions.filter((f) => f.name.toLowerCase().includes(token));
  const names = new Set(suggestions.map((f) => f.name));
  return (
    <Input
      value={value}
      placeholder={placeholder}
      style={style}
      valueState={valueState}
      valueStateMessage={valueStateMessage ? <div>{valueStateMessage}</div> : undefined}
      showSuggestions
      filter="None"
      onInput={(e) => onChange(applyExprPick(value, e.target.value, names))}
    >
      {matches.map((f) => (
        <SuggestionItem key={f.name} text={f.name} additionalText={f.detail} />
      ))}
    </Input>
  );
}

// A section/group row: label + chevron + inline edit/add/delete buttons. The row-wide tint lives on each
// TableCell host (light DOM) — `background` isn't inherited into the shadow DOM, so a TableRow host bg
// wouldn't show; per-cell host backgrounds do, and tile continuously across the row.
function HeaderCell({ level, label, visibility, error, collapsed, onToggle, onAdd, addTooltip, onDelete }: {
  level: "section" | "group";
  label: string;
  visibility?: string;
  error?: string;
  collapsed: boolean;
  onToggle: () => void;
  onAdd: () => void;
  addTooltip: string;
  onDelete: () => void;
}) {
  const section = level === "section";
  return (
    <FlexBox
      alignItems="Center"
      title={error ?? undefined}
      style={{
        gap: "0.5rem",
        width: "100%",
        marginInlineStart: section ? 0 : "1.5rem",
        padding: "0.125rem 0.5rem",
        fontWeight: section ? "bold" : 600,
        color: error ? "var(--sapNegativeColor)" : undefined,
      }}
    >
      <Button
        icon={collapsed ? "slim-arrow-right" : "slim-arrow-down"}
        design="Transparent"
        onClick={onToggle}
        tooltip={collapsed ? "Expand" : "Collapse"}
      />
      {error ? <Icon name="error" style={{ color: "var(--sapNegativeColor)" }} /> : null}
      {section ? <Title level="H6">{label}</Title> : <Text>{label}</Text>}
      {visibility ? (
        <Text style={{ opacity: 0.6, fontWeight: "normal" }}>· visible if {visibility}</Text>
      ) : null}
      <span style={{ flex: 1 }} />
      <Button icon="add" design="Transparent" onClick={onAdd} tooltip={addTooltip} />
      <Button icon="delete" design="Transparent" onClick={onDelete} tooltip={`Delete ${level}`} />
    </FlexBox>
  );
}

// Shared edit dialog for a section or a group: Description + Visibility.
function NodeDialog({ title, label, visibility, suggestions, onClose, onLabel, onVisibility }: {
  title: string; label: string; visibility?: string; suggestions: Suggest[]; onClose: () => void;
  onLabel: (v: string) => void; onVisibility: (v: string | undefined) => void;
}) {
  return (
    <Dialog
      open
      draggable
      headerText={title}
      onClose={onClose}
      footer={<Bar endContent={<Button design="Emphasized" onClick={onClose}>Done</Button>} />}
    >
      <FlexBox direction="Column" style={{ gap: "0.75rem", minWidth: 380, padding: "0.5rem" }}>
        <Label>Description</Label>
        <Input value={label} onInput={(e) => onLabel(e.target.value)} />
        <Label>Visibility formula (optional)</Label>
        <ExprInput
          suggestions={suggestions}
          placeholder='e.g. product == "plaque"'
          value={visibility ?? ""}
          onChange={(v) => onVisibility(v || undefined)}
        />
      </FlexBox>
    </Dialog>
  );
}

function ItemDialog({
  item, masterdata, suggestions, onClose, onChange,
}: {
  item: FormItem;
  masterdata: { id: string; name: string; kind: string }[];
  suggestions: Suggest[];
  onClose: () => void;
  onChange: (fn: (it: FormItem) => FormItem) => void;
}) {
  const ds = item.input.dataSource;
  const setInput = (patch: Partial<FormItem["input"]>) => onChange((it) => ({ ...it, input: { ...it.input, ...patch } }));
  const setDs = (next: DataSource) => setInput({ dataSource: next });

  return (
    <Dialog
      open
      className="hera-item-dialog"
      headerText={`Field · ${item.label}`}
      onClose={onClose}
      style={{ width: 560 }}
      footer={<Bar endContent={<Button design="Emphasized" onClick={onClose}>Done</Button>} />}
    >
      <TabContainer className="hera-item-tabs">
        <Tab text="Details" selected>
          <FlexBox direction="Column" style={{ gap: "0.6rem", padding: "0.5rem" }}>
            <Label>Description</Label>
            <Input value={item.label} onInput={(e) => onChange((it) => ({ ...it, label: e.target.value }))} />
            <Label>Name (used in formulas)</Label>
            <Input value={item.name} onInput={(e) => onChange((it) => ({ ...it, name: e.target.value }))} />
            <Label>Visibility formula (optional)</Label>
            <ExprInput
              suggestions={suggestions}
              placeholder='e.g. quality == "high"'
              value={item.visibility ?? ""}
              onChange={(v) => onChange((it) => ({ ...it, visibility: v || undefined }))}
            />
          </FlexBox>
        </Tab>

        <Tab text="Input">
          <FlexBox direction="Column" style={{ gap: "0.6rem", padding: "0.5rem" }}>
            <FlexBox alignItems="Center" style={{ gap: "0.5rem" }}>
              <Switch checked={item.input.mandatory} onChange={(e) => setInput({ mandatory: e.target.checked })} />
              <Label>Mandatory</Label>
            </FlexBox>

            <Label>UI element</Label>
            <Select value={item.input.inputType} onChange={(e) => setInput({ inputType: (e.detail.selectedOption.value || "input") as InputType })}>
              {(["input", "radio", "checkbox", "multicombo"] as InputType[]).map((t) => (
                <Option key={t} value={t}>{t}</Option>
              ))}
            </Select>

            <Label>Data source</Label>
            <Select
              value={ds.kind}
              onChange={(e) => {
                const k = e.detail.selectedOption.value;
                if (k === "normal") setDs({ kind: "normal" });
                else setDs({ kind: "masterdata", masterdataId: masterdata[0]?.id ?? "" });
              }}
            >
              <Option value="normal">Normal</Option>
              <Option value="masterdata">Master data</Option>
            </Select>

            {ds.kind === "normal" ? (
              <>
                <Label>Options (comma-separated; leave empty for free input)</Label>
                <Input value={joinValues(ds.values)} onInput={(e) => setDs({ kind: "normal", values: parseValues(e.target.value) })} />
              </>
            ) : (
              <>
                <Label>Master data</Label>
                <Select value={ds.masterdataId} onChange={(e) => setDs({ kind: "masterdata", masterdataId: e.detail.selectedOption.value ?? "" })}>
                  {masterdata.map((m) => (
                    <Option key={m.id} value={m.id}>{m.name}</Option>
                  ))}
                </Select>
                <Text style={{ opacity: 0.6 }}>Options come from this master data — its first column is the key value.</Text>
              </>
            )}

            <Label>Value</Label>
            <Select
              value={item.input.value.kind}
              onChange={(e) =>
                setInput({ value: e.detail.selectedOption.value === "formula" ? { kind: "formula", expr: "" } : { kind: "manual" } })
              }
            >
              <Option value="manual">Manual (user picks)</Option>
              <Option value="formula">Formula (derived)</Option>
            </Select>
            {item.input.value.kind === "formula" ? (
              <ExprInput
                suggestions={suggestions}
                placeholder='e.g. printing == "digital" ? "1000x500" : "500x500"'
                value={item.input.value.expr}
                onChange={(v) => setInput({ value: { kind: "formula", expr: v } })}
              />
            ) : null}
          </FlexBox>
        </Tab>

        <Tab text="Output">
          <FlexBox direction="Column" style={{ padding: "1rem" }}>
            <Text style={{ opacity: 0.6 }}>Output mapping is reserved for a later milestone.</Text>
          </FlexBox>
        </Tab>

        <Tab text="Price">
          <FlexBox direction="Column" style={{ gap: "0.6rem", padding: "0.5rem" }}>
            <Label>Price formula (optional; summed into the total)</Label>
            <ExprInput
              suggestions={suggestions}
              style={{ width: "100%" }}
              placeholder="e.g. 200 + sheetsNeeded * (10 + thickness) + qty * 0.5"
              value={item.price ?? ""}
              onChange={(v) => onChange((it) => ({ ...it, price: v || undefined }))}
            />
          </FlexBox>
        </Tab>
      </TabContainer>
    </Dialog>
  );
}

// Edit dialog for a predefined (reusable) formula — modal, like every other element.
function FormulaDialog({ formula, suggestions, onClose, onChange, onDelete }: {
  formula: PredefinedFormula;
  suggestions: Suggest[];
  onClose: () => void;
  onChange: (fn: (f: PredefinedFormula) => PredefinedFormula) => void;
  onDelete: () => void;
}) {
  return (
    <Dialog
      open
      draggable
      headerText={`Formula · ${formula.name}`}
      onClose={onClose}
      footer={
        <Bar
          startContent={<Button design="Transparent" icon="delete" onClick={onDelete}>Delete</Button>}
          endContent={<Button design="Emphasized" onClick={onClose}>Done</Button>}
        />
      }
    >
      <FlexBox direction="Column" style={{ gap: "0.75rem", minWidth: 420, padding: "0.5rem" }}>
        <Label>Name (used in formulas)</Label>
        <Input value={formula.name} onInput={(e) => onChange((f) => ({ ...f, name: e.target.value }))} />
        <Label>Expression</Label>
        <ExprInput
          suggestions={suggestions.filter((s) => s.name !== formula.name)}
          placeholder="e.g. ceil(qty / perSheet)"
          value={formula.expr}
          onChange={(v) => onChange((f) => ({ ...f, expr: v }))}
        />
      </FlexBox>
    </Dialog>
  );
}

function RulesPanel({ model, setModel, suggestions }: {
  model: Model; setModel: React.Dispatch<React.SetStateAction<Model>>; suggestions: Suggest[];
}) {
  const em = useMemo(() => flatten(model), [model]);
  // Every referenceable name (items + formulas) — BUG A fix: vars derive from ALL of these, not just
  // finite ones, so free/numeric/formula vars land in `vars` and propagate() classifies the rule right.
  const allNames = useMemo(() => new Set([...em.parameters.map((p) => p.name), ...em.formulas.map((f) => f.name)]), [em]);
  // Finite fields drive the "narrows options" vs "validity check" classification badge.
  const finite = useMemo(
    () => new Set(em.parameters.filter((p) => p.domain.kind === "static" || p.domain.kind === "datasource").map((p) => p.name)),
    [em],
  );
  const fields = em.parameters.map((p) => p.name);
  // Static (author-time-known) option values for a field, else undefined (free input / unresolved datasource).
  const domainOf = (field: string): Value[] | undefined => {
    const p = em.parameters.find((x) => x.name === field);
    return p && p.domain.kind === "static" ? p.domain.values : undefined;
  };
  // Function names (fit/ceil/…) aren't known names, so they're excluded from vars automatically.
  const varsOf = (expr: string): string[] => Array.from(new Set(idsIn(expr))).filter((t) => allNames.has(t));

  const update = (i: number, fn: (r: Rule) => Rule) =>
    setModel((m) => ({ ...m, rules: m.rules.map((r, j) => (j === i ? fn(r) : r)) }));
  const onLabel = (i: number, label: string) => update(i, (r) => ({ ...r, label: label || undefined }));
  // Raw edit: expr is authoritative — derive vars, DROP guided (built explicitly so guided can't linger).
  const onRaw = (i: number, expr: string) => update(i, (r) => ({ expr, vars: varsOf(expr), ...(r.label ? { label: r.label } : {}) }));
  // Guided edit: regenerate expr+vars from the form and store guided alongside.
  const onGuided = (i: number, g: GuidedRule) =>
    update(i, (r) => { const expr = compileGuided(g); return { expr, vars: varsOf(expr), guided: g, ...(r.label ? { label: r.label } : {}) }; });
  const onMode = (i: number, guided: boolean) =>
    update(i, (r) => {
      if (guided) { const g = r.guided ?? { when: [], then: [] }; const expr = compileGuided(g); return { expr, vars: varsOf(expr), guided: g, ...(r.label ? { label: r.label } : {}) }; }
      return { expr: r.expr, vars: r.vars, ...(r.label ? { label: r.label } : {}) }; // to raw: keep expr, drop guided
    });
  // New rules start in guided mode (empty when/then -> expr "true", a harmless no-op until filled).
  const addRule = () => setModel((m) => ({ ...m, rules: [...m.rules, { expr: "true", vars: [], guided: { when: [], then: [] } }] }));
  const removeRule = (i: number) => setModel((m) => ({ ...m, rules: m.rules.filter((_, j) => j !== i) }));

  return (
    <FlexBox direction="Column" style={{ gap: "0.75rem", padding: "0.5rem" }}>
      <Text style={{ opacity: 0.6 }}>
        Rules that must hold. A rule over only finite fields narrows the options bidirectionally as the user picks; a rule
        touching a free/numeric field is checked once its inputs are filled.
      </Text>
      {model.rules.map((r, i) => (
        <RuleCard
          key={i}
          rule={r}
          suggestions={suggestions}
          fields={fields}
          finite={finite}
          domainOf={domainOf}
          onLabel={(v) => onLabel(i, v)}
          onRaw={(expr) => onRaw(i, expr)}
          onGuided={(g) => onGuided(i, g)}
          onMode={(g) => onMode(i, g)}
          onRemove={() => removeRule(i)}
        />
      ))}
      <Button icon="add" design="Transparent" onClick={addRule} style={{ alignSelf: "flex-start" }}>Add rule</Button>
    </FlexBox>
  );
}

// One rule = one card: optional name, a classification badge (does it narrow options or just validate?),
// a Guided/Raw mode toggle, and either the structured when⇒then editor or the raw expression input.
function RuleCard({ rule, suggestions, fields, finite, domainOf, onLabel, onRaw, onGuided, onMode, onRemove }: {
  rule: Rule; suggestions: Suggest[]; fields: string[]; finite: Set<string>;
  domainOf: (field: string) => Value[] | undefined;
  onLabel: (v: string) => void; onRaw: (expr: string) => void; onGuided: (g: GuidedRule) => void;
  onMode: (guided: boolean) => void; onRemove: () => void;
}) {
  const guided = !!rule.guided;
  // Inline validation: does the raw expression parse? (Guided expr is generated, so it always does.)
  const parseErr = useMemo(() => {
    if (!rule.expr.trim()) return undefined;
    try { compile(rule.expr); return undefined; } catch (e) { return (e as Error).message; }
  }, [rule.expr]);
  // A rule over only finite fields propagates (narrows pickers); anything else is a post-validation check.
  const narrows = rule.vars.length > 0 && rule.vars.every((v) => finite.has(v));
  return (
    <FlexBox direction="Column" style={{ gap: "0.5rem", border: "1px solid var(--sapList_BorderColor)", borderRadius: "0.5rem", padding: "0.6rem" }}>
      <FlexBox alignItems="Center" style={{ gap: "0.5rem" }}>
        <Input placeholder="Rule name (optional)" value={rule.label ?? ""} onInput={(e) => onLabel(e.target.value)} style={{ flex: 1 }} />
        <ObjectStatus state={narrows ? "Information" : "None"}>{narrows ? "narrows options" : "validity check"}</ObjectStatus>
        <Button design={guided ? "Emphasized" : "Transparent"} onClick={() => onMode(true)}>Guided</Button>
        <Button design={!guided ? "Emphasized" : "Transparent"} onClick={() => onMode(false)}>Raw</Button>
        <Button icon="delete" design="Transparent" onClick={onRemove} tooltip="Delete rule" />
      </FlexBox>
      {guided ? (
        <>
          <GuidedEditor guided={rule.guided!} fields={fields} domainOf={domainOf} onChange={onGuided} />
          <Text style={{ opacity: 0.5, fontSize: "0.75rem" }}>= {rule.expr}</Text>
        </>
      ) : (
        <ExprInput
          suggestions={suggestions}
          placeholder='e.g. quality != "high" or machining != "punching"'
          value={rule.expr}
          onChange={onRaw}
          valueState={parseErr ? "Negative" : undefined}
          valueStateMessage={parseErr}
        />
      )}
    </FlexBox>
  );
}

// The structured editor: (all "when" conds) ⇒ (all "then" conds). compileGuided folds it to one expr.
function GuidedEditor({ guided, fields, domainOf, onChange }: {
  guided: GuidedRule; fields: string[]; domainOf: (field: string) => Value[] | undefined;
  onChange: (g: GuidedRule) => void;
}) {
  const setConds = (which: "when" | "then", conds: GuidedCond[]) => onChange({ ...guided, [which]: conds });
  const addCond = (which: "when" | "then") => setConds(which, [...guided[which], { field: fields[0] ?? "", op: "==", value: "" }]);
  const part = (which: "when" | "then", title: string) => (
    <FlexBox direction="Column" style={{ gap: "0.35rem" }}>
      <Label>{title}</Label>
      {guided[which].map((c, k) => (
        <CondRow
          key={k}
          cond={c}
          fields={fields}
          domainOf={domainOf}
          onChange={(nc) => setConds(which, guided[which].map((x, j) => (j === k ? nc : x)))}
          onRemove={() => setConds(which, guided[which].filter((_, j) => j !== k))}
        />
      ))}
      <Button icon="add" design="Transparent" onClick={() => addCond(which)} style={{ alignSelf: "flex-start" }}>Add condition</Button>
    </FlexBox>
  );
  return (
    <FlexBox direction="Column" style={{ gap: "0.5rem" }}>
      {part("when", "When all of")}
      {part("then", "Then must hold")}
    </FlexBox>
  );
}

// One `field op value` condition. The value control follows the field: a Select of its options when the
// field has author-time-known values, else a free Input (numeric strings coerce to numbers).
function CondRow({ cond, fields, domainOf, onChange, onRemove }: {
  cond: GuidedCond; fields: string[]; domainOf: (field: string) => Value[] | undefined;
  onChange: (c: GuidedCond) => void; onRemove: () => void;
}) {
  const dom = domainOf(cond.field);
  return (
    <FlexBox alignItems="Center" wrap="Wrap" style={{ gap: "0.4rem" }}>
      <Select value={cond.field} onChange={(e) => onChange({ ...cond, field: e.detail.selectedOption.value ?? "", value: "" })}>
        <Option value="">—</Option>
        {fields.map((f) => <Option key={f} value={f}>{f}</Option>)}
      </Select>
      <Select value={cond.op} onChange={(e) => onChange({ ...cond, op: (e.detail.selectedOption.value ?? "==") as GuidedCond["op"] })}>
        {OPS.map((op) => <Option key={op} value={op}>{op}</Option>)}
      </Select>
      {dom ? (
        <Select value={String(cond.value)} onChange={(e) => onChange({ ...cond, value: fromDom(dom, e.detail.selectedOption.value ?? "") ?? "" })}>
          <Option value="">—</Option>
          {dom.map((v) => <Option key={String(v)} value={String(v)}>{String(v)}</Option>)}
        </Select>
      ) : (
        <Input placeholder="value" value={String(cond.value ?? "")} onInput={(e) => onChange({ ...cond, value: coerceVal(e.target.value) })} />
      )}
      <Button icon="decline" design="Transparent" onClick={onRemove} tooltip="Remove condition" />
    </FlexBox>
  );
}
