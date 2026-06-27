import { useMemo, useState, useEffect } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient, skipToken } from "@tanstack/react-query";
import {
  ObjectPage, ObjectPageSection, ObjectPageTitle, Bar, Button, Input, SuggestionItem, Title, Text, Label, MessageStrip, BusyIndicator,
  Table, TableHeaderRow, TableHeaderCell, TableRow, TableCell,
  Dialog, TabContainer, Tab, Select, Option, Switch, FlexBox, Panel,
  Toolbar, ToolbarButton, Icon,
} from "@ui5/webcomponents-react";
import type { Model, FormSection, FormGroup, FormItem, DataSource, InputType, Value, PredefinedFormula, EngineModel, Assignment } from "@hera/config-engine";
import { flatten, enumerate, lintModel, buildScope, evaluate } from "@hera/config-engine";
import { orpc } from "../orpc.ts";
import { blankModel, blankSection, blankGroup, blankItem, blankFormula, allItems, trailingToken, applyExprPick, evalForDisplay } from "../lib/model.ts";
import "./ModelBuilder.css";

// An autocomplete suggestion offered in an expression input: an identifier (a field or a formula
// name) + a short detail (the formula's expression, or a field descriptor) shown after it.
type Suggest = { name: string; detail: string };
type Scope = Record<string, unknown>;

type Editing = { sid: string; gid?: string; iid?: string } | null;

// A row's identity, encoded into its data-key so one set of Table handlers can act on any row.
type Key = { kind: "s" | "g" | "i"; sid: string; gid?: string; iid?: string };
const keyOf = (k: Key): string => [k.kind, k.sid, k.gid, k.iid].filter(Boolean).join(":");
const parseKey = (s?: string | null): Key | null => {
  const [kind, sid, gid, iid] = (s ?? "").split(":");
  if (kind === "s" && sid) return { kind, sid };
  if (kind === "g" && sid && gid) return { kind, sid, gid };
  if (kind === "i" && sid && gid && iid) return { kind, sid, gid, iid };
  return null;
};

// Structural shapes for the UI5 Table drag/click events — avoids importing the wrapper's event types.
type RowEl = HTMLElement;
type MoveEvt = { preventDefault(): void; detail: { source: { element: RowEl }; destination: { element: RowEl; placement: string } } };
type RowClickEvt = { detail: { row: RowEl } };

const parseValues = (s: string): Value[] =>
  s.split(",").map((x) => x.trim()).filter(Boolean).map((x) => (x !== "" && !isNaN(Number(x)) ? Number(x) : x));
const joinValues = (v?: Value[]): string => (v ?? []).join(", ");

// Coerce a typed/selected test-input string back to a real value: booleans and numbers stay typed
// so rules/formulas see the same shape the runtime would. (Same intent as Configurator's `num`.)
const num = (s: string): Value => (s !== "" && !isNaN(Number(s)) ? Number(s) : s);
const coerceVal = (s: string): Value => (s === "true" ? true : s === "false" ? false : num(s));
const coerceOpt = (k?: string): Value | undefined => (k === undefined || k === "" ? undefined : coerceVal(k));

export function ModelBuilder({ id }: { id: string }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const isNew = id === "new";

  const get = useQuery(orpc.models.get.queryOptions({ input: isNew ? skipToken : { id } }));
  const tables = useQuery(orpc.tables.list.queryOptions());

  const [model, setModel] = useState<Model>(blankModel());
  const [editing, setEditing] = useState<Editing>(null);
  const [editingFormula, setEditingFormula] = useState<string | null>(null);
  // Sample inputs the whole builder tests its expressions against (one shared assignment).
  const [testInput, setTestInput] = useState<Assignment>({});
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
  // The shared evaluation scope: the sample inputs + every formula resolved against them. Every
  // ExprResult/ExprInput in the builder evaluates against this, so results stay consistent.
  const scope = useMemo<Scope>(() => buildScope(em, testInput), [em, testInput]);

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
  // The summed price for the current sample inputs (if it computes); shown next to the config count.
  const testTotal = useMemo(() => {
    if (!Object.keys(testInput).length) return null;
    try { return evaluate(em, testInput).price; } catch { return null; }
  }, [em, testInput]);

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

  // One read-only formula row (the formula is global; `pad` is just how deep it sits under a field).
  // Click the row to edit it in a modal; the chip shows its live result against the sample inputs.
  const formulaRow = (f: PredefinedFormula, pad: string) => (
    <TableRow key={f.id} interactive rowKey={`f:${f.id}`} data-fid={f.id}>
      <TableCell style={{ gridColumn: "1 / -1" }}>
        <FlexBox alignItems="Center" style={{ gap: "0.5rem", width: "100%", paddingInlineStart: pad, paddingInlineEnd: "0.5rem" }}>
          <Icon name="simulate" />
          <Text style={{ fontWeight: 600 }}>{f.name}</Text>
          <Text style={{ opacity: 0.7 }}>= {f.expr || "—"}</Text>
          <ResultText expr={f.expr} scope={scope} />
          <span style={{ flex: 1 }} />
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

  return (
    <ObjectPage
      mode="IconTabBar"
      hidePinButton
      titleArea={
        <ObjectPageTitle
          header={<Title level="H4">Model builder</Title>}
          actionsBar={
            <Toolbar design="Transparent">
              <ToolbarButton icon="add" text="Add section" onClick={addSection} />
              <ToolbarButton icon="simulate" text="Add formula" onClick={() => addFormula()} />
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

        {save.error ? <MessageStrip design="Negative" hideCloseButton>{save.error.message}</MessageStrip> : null}
        {errors.length ? (
          <MessageStrip design="Negative" hideCloseButton>{errors.join(" · ")}</MessageStrip>
        ) : (
          <MessageStrip design="Positive" hideCloseButton>
            {preview ? `${preview.solutions.length}${preview.truncated ? "+" : ""} possible configuration(s)` : "Model is valid"}
            {testTotal != null ? ` · test total ${testTotal}` : ""}
          </MessageStrip>
        )}

        <TestPanel em={em} testInput={testInput} setTestInput={setTestInput} />

        {/* One flat table: section header rows, group header rows, item rows — drag any row to reorder. */}
        <Table
          headerRow={
            <TableHeaderRow>
              <TableHeaderCell>Description</TableHeaderCell>
              <TableHeaderCell>Name</TableHeaderCell>
              <TableHeaderCell>Input</TableHeaderCell>
              <TableHeaderCell>Data source</TableHeaderCell>
              <TableHeaderCell>Value</TableHeaderCell>
            </TableHeaderRow>
          }
          noDataText="No sections yet — use “Add section”."
          onMove={onMove}
          onMoveOver={onMoveOver}
          onRowClick={onRowClick}
        >
          {model.sections.flatMap((s, si) => {
            const sk = keyOf({ kind: "s", sid: s.id });
            return [
              <TableRow key={s.id} movable rowKey={sk} data-key={sk}>
                <TableCell style={spanCell("section", si === 0)}>
                  <HeaderCell
                    level="section"
                    label={s.label}
                    visibility={s.visibility}
                    scope={scope}
                    collapsed={collapsed.has(sk)}
                    onToggle={() => toggle(sk)}
                    onEdit={() => setEditing({ sid: s.id })}
                    onAdd={() => addGroup(s.id)}
                    addTooltip="Add group"
                    onDelete={() => removeSection(s.id)}
                  />
                </TableCell>
              </TableRow>,
              ...(collapsed.has(sk) ? [] : s.groups.flatMap((g) => {
                const gk = keyOf({ kind: "g", sid: s.id, gid: g.id });
                return [
                  <TableRow key={g.id} movable rowKey={gk} data-key={gk}>
                    <TableCell style={spanCell("group")}>
                      <HeaderCell
                        level="group"
                        label={g.label}
                        visibility={g.visibility}
                        scope={scope}
                        collapsed={collapsed.has(gk)}
                        onToggle={() => toggle(gk)}
                        onEdit={() => setEditing({ sid: s.id, gid: g.id })}
                        onAdd={() => addItem(s.id, g.id)}
                        addTooltip="Add field"
                        onDelete={() => removeGroup(s.id, g.id)}
                      />
                    </TableCell>
                  </TableRow>,
                  ...(collapsed.has(gk) ? [] : g.items.flatMap((it) => {
                    const ik = keyOf({ kind: "i", sid: s.id, gid: g.id, iid: it.id });
                    return [
                      <TableRow key={it.id} interactive movable rowKey={ik} data-key={ik}>
                        <TableCell>
                          <Text style={{ paddingInlineStart: "3rem" }}>{it.label}{it.input.mandatory ? " *" : ""}</Text>
                        </TableCell>
                        <TableCell><Text>{it.name}</Text></TableCell>
                        <TableCell><Text>{it.input.inputType}</Text></TableCell>
                        <TableCell><Text>{it.input.dataSource.kind}</Text></TableCell>
                        <TableCell>
                          <FlexBox alignItems="Center" style={{ gap: "0.5rem", width: "100%", paddingInlineEnd: "0.5rem" }}>
                            {it.input.value.kind === "formula" ? (
                              <>
                                <Text>= {it.input.value.expr}</Text>
                                <ResultText expr={it.input.value.expr} scope={scope} />
                              </>
                            ) : (
                              <Text>manual</Text>
                            )}
                            <span style={{ flex: 1 }} />
                            <Button className="hera-row-action" icon="simulate" design="Transparent" onClick={() => addFormula(it.id)} tooltip="Add formula" />
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
          tables={tables.data ?? []}
          suggestions={suggestions}
          scope={scope}
          onClose={() => setEditing(null)}
          onChange={(fn) => patchItem(editing!.sid, editing!.gid!, editing!.iid!, fn)}
        />
      ) : eg ? (
        <NodeDialog
          title="Group"
          label={eg.label}
          visibility={eg.visibility}
          suggestions={suggestions}
          scope={scope}
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
          scope={scope}
          onClose={() => setEditing(null)}
          onLabel={(v) => patchSection(editing!.sid, (s) => ({ ...s, label: v }))}
          onVisibility={(v) => patchSection(editing!.sid, (s) => ({ ...s, visibility: v }))}
        />
      ) : null}

      {ef ? (
        <FormulaDialog
          formula={ef}
          suggestions={suggestions}
          scope={scope}
          onClose={() => setEditingFormula(null)}
          onChange={(fn) => patchFormula(ef.id, fn)}
          onDelete={() => { removeFormula(ef.id); setEditingFormula(null); }}
        />
      ) : null}
      </ObjectPageSection>

      <ObjectPageSection id="constraints" titleText="Constraints">
        <RulesPanel model={model} setModel={setModel} suggestions={suggestions} scope={scope} />
      </ObjectPageSection>
    </ObjectPage>
  );
}

type VState = "None" | "Positive" | "Critical" | "Negative" | "Information";

// Map a tested-expression result to an Input value state + message — the UI5 inline-validation
// pattern: the field border carries the state, the value (or error) shows in the value-state popover.
// Positive (a boolean that holds) needs no message; UI5 only pops the message for Info/Critical/Negative.
function resultState(scope: Scope, expr?: string, bool?: boolean): { valueState: VState; message?: string } {
  const r = evalForDisplay(scope, expr, bool);
  if (!r) return { valueState: "None" };
  if (!r.ok) return { valueState: "Negative", message: r.error };
  if (bool) return r.bool ? { valueState: "Positive" } : { valueState: "Critical", message: "does not hold" };
  return { valueState: "Information", message: `→ ${r.text}` };
}

// The same tested result as read-only text, for the table rows / header bands where there's no input
// to carry a value state.
function ResultText({ expr, scope, bool }: { expr?: string; scope: Scope; bool?: boolean }) {
  const r = evalForDisplay(scope, expr, bool);
  if (!r) return null;
  if (!r.ok) return <Text style={{ color: "var(--sapNegativeTextColor)" }}>⚠ {r.error}</Text>;
  if (bool) return <Text style={{ color: r.bool ? "var(--sapPositiveTextColor)" : "var(--sapCriticalTextColor)" }}>{r.text}</Text>;
  return <Text style={{ opacity: 0.7 }}>→ {r.text}</Text>;
}

// An expression field with field+formula autocomplete: typing offers matching identifiers (name +
// detail) via UI5 SuggestionItem; picking one completes the trailing identifier in place (see
// applyExprPick). When `scope` is given, the live test result/error is carried by the input's
// valueState (border) + valueStateMessage (popover).
function ExprInput({ value, onChange, suggestions, placeholder, style, scope, bool }: {
  value: string;
  onChange: (v: string) => void;
  suggestions: Suggest[];
  placeholder?: string;
  style?: React.CSSProperties;
  scope?: Scope;
  bool?: boolean;
}) {
  // ponytail: trailing-token completion only; caret-aware mid-expression insert if it ever matters.
  const token = trailingToken(value).toLowerCase();
  const matches = suggestions.filter((f) => f.name.toLowerCase().includes(token));
  const names = new Set(suggestions.map((f) => f.name));
  const st = scope ? resultState(scope, value, bool) : { valueState: "None" as VState };
  return (
    <Input
      value={value}
      placeholder={placeholder}
      style={style}
      showSuggestions
      filter="None"
      valueState={st.valueState}
      valueStateMessage={st.message ? <div>{st.message}</div> : undefined}
      onInput={(e) => onChange(applyExprPick(value, e.target.value, names))}
    >
      {matches.map((f) => (
        <SuggestionItem key={f.name} text={f.name} additionalText={f.detail} />
      ))}
    </Input>
  );
}

// The shared "Test data" area: one sample value per input field, evaluated everywhere. Collapsed by
// default. Auto-fill seeds the finite fields from the first valid configuration.
function TestPanel({ em, testInput, setTestInput }: {
  em: EngineModel;
  testInput: Assignment;
  setTestInput: React.Dispatch<React.SetStateAction<Assignment>>;
}) {
  const params = em.parameters;
  // Controlled collapse: testInput changes on every keystroke, so a fixed `collapsed` prop would
  // snap the panel shut while typing in it. Local state keeps it stable across re-renders.
  const [open, setOpen] = useState(false);
  const setTest = (name: string, v: Value | undefined) =>
    setTestInput((a) => { const next = { ...a }; if (v === undefined) delete next[name]; else next[name] = v; return next; });
  const autoFill = () => {
    const sol = enumerate(em, {}, { cap: 1 }).solutions[0];
    if (sol) setTestInput(sol);
  };
  return (
    <Panel headerText="Test data" collapsed={!open} onToggle={() => setOpen((o) => !o)} headerLevel="H6">
      <FlexBox direction="Column" style={{ gap: "0.75rem", padding: "0.25rem 0.5rem" }}>
        <FlexBox style={{ gap: "0.5rem" }}>
          <Button design="Transparent" icon="value-help" onClick={autoFill}>Auto-fill</Button>
          <Button design="Transparent" icon="clear-all" onClick={() => setTestInput({})}>Clear</Button>
        </FlexBox>
        {params.length === 0 ? (
          <Text style={{ opacity: 0.6 }}>No input fields yet — add fields to test against.</Text>
        ) : (
          <FlexBox style={{ gap: "1rem 1.5rem", flexWrap: "wrap" }}>
            {params.map((p) => (
              <FlexBox key={p.name} direction="Column" style={{ gap: "0.25rem", minWidth: 180 }}>
                <Label>{p.label || p.name}</Label>
                {p.domain.kind === "static" ? (
                  <Select
                    value={p.name in testInput ? String(testInput[p.name]) : ""}
                    onChange={(e) => setTest(p.name, coerceOpt(e.detail.selectedOption.value))}
                  >
                    <Option value="">—</Option>
                    {p.domain.values.map((v) => (
                      <Option key={String(v)} value={String(v)}>{String(v)}</Option>
                    ))}
                  </Select>
                ) : (
                  // ponytail: datasource domains aren't resolved at author time → free text input.
                  <Input
                    value={p.name in testInput ? String(testInput[p.name]) : ""}
                    onInput={(e) => setTest(p.name, e.target.value === "" ? undefined : num(e.target.value))}
                  />
                )}
              </FlexBox>
            ))}
          </FlexBox>
        )}
      </FlexBox>
    </Panel>
  );
}

// A section/group row: label + chevron + inline edit/add/delete buttons. The row-wide tint lives on each
// TableCell host (light DOM) — `background` isn't inherited into the shadow DOM, so a TableRow host bg
// wouldn't show; per-cell host backgrounds do, and tile continuously across the row.
function HeaderCell({ level, label, visibility, scope, collapsed, onToggle, onEdit, onAdd, addTooltip, onDelete }: {
  level: "section" | "group";
  label: string;
  visibility?: string;
  scope: Scope;
  collapsed: boolean;
  onToggle: () => void;
  onEdit: () => void;
  onAdd: () => void;
  addTooltip: string;
  onDelete: () => void;
}) {
  const section = level === "section";
  return (
    <FlexBox
      alignItems="Center"
      style={{
        gap: "0.5rem",
        width: "100%",
        marginInlineStart: section ? 0 : "1.5rem",
        padding: "0.125rem 0.5rem",
        fontWeight: section ? "bold" : 600,
      }}
    >
      <Button
        icon={collapsed ? "slim-arrow-right" : "slim-arrow-down"}
        design="Transparent"
        onClick={onToggle}
        tooltip={collapsed ? "Expand" : "Collapse"}
      />
      {section ? <Title level="H6">{label}</Title> : <Text>{label}</Text>}
      {visibility ? (
        <FlexBox alignItems="Center" style={{ gap: "0.35rem", fontWeight: "normal" }}>
          <Text style={{ opacity: 0.6 }}>· visible if {visibility}</Text>
          <ResultText expr={visibility} scope={scope} bool />
        </FlexBox>
      ) : null}
      <span style={{ flex: 1 }} />
      <Button icon="edit" design="Transparent" onClick={onEdit} tooltip={`Edit ${level}`} />
      <Button icon="add" design="Transparent" onClick={onAdd} tooltip={addTooltip} />
      <Button icon="delete" design="Transparent" onClick={onDelete} tooltip={`Delete ${level}`} />
    </FlexBox>
  );
}

// Shared edit dialog for a section or a group: Description + Visibility.
function NodeDialog({ title, label, visibility, suggestions, scope, onClose, onLabel, onVisibility }: {
  title: string; label: string; visibility?: string; suggestions: Suggest[]; scope: Scope; onClose: () => void;
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
          scope={scope}
          bool
          placeholder='e.g. product == "plaque"'
          value={visibility ?? ""}
          onChange={(v) => onVisibility(v || undefined)}
        />
      </FlexBox>
    </Dialog>
  );
}

function ItemDialog({
  item, tables, suggestions, scope, onClose, onChange,
}: {
  item: FormItem;
  tables: { id: string; name: string }[];
  suggestions: Suggest[];
  scope: Scope;
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
              scope={scope}
              bool
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
                else if (k === "table") setDs({ kind: "table", tableId: tables[0]?.id ?? "" });
                else setDs({ kind: "query", source: "b1", path: "", valueField: "" });
              }}
            >
              <Option value="normal">Normal</Option>
              <Option value="table">Table</Option>
              <Option value="query">Query</Option>
            </Select>

            {ds.kind === "normal" ? (
              <>
                <Label>Options (comma-separated; leave empty for free input)</Label>
                <Input value={joinValues(ds.values)} onInput={(e) => setDs({ kind: "normal", values: parseValues(e.target.value) })} />
              </>
            ) : ds.kind === "table" ? (
              <>
                <Label>Table</Label>
                <Select value={ds.tableId} onChange={(e) => setDs({ kind: "table", tableId: e.detail.selectedOption.value ?? "" })}>
                  {tables.map((t) => (
                    <Option key={t.id} value={t.id}>{t.name}</Option>
                  ))}
                </Select>
              </>
            ) : (
              <>
                <Label>Source</Label>
                <Input value={ds.source} onInput={(e) => setDs({ ...ds, source: e.target.value })} />
                <Label>GET path (OData)</Label>
                <Input placeholder="/Items?$select=ItemCode,ItemName" value={ds.path} onInput={(e) => setDs({ ...ds, path: e.target.value })} />
                <Label>Value field</Label>
                <Input value={ds.valueField} onInput={(e) => setDs({ ...ds, valueField: e.target.value })} />
                <Label>Label field (optional)</Label>
                <Input value={ds.labelField ?? ""} onInput={(e) => setDs({ ...ds, labelField: e.target.value || undefined })} />
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
                scope={scope}
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
              scope={scope}
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
function FormulaDialog({ formula, suggestions, scope, onClose, onChange, onDelete }: {
  formula: PredefinedFormula;
  suggestions: Suggest[];
  scope: Scope;
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
          scope={scope}
          placeholder="e.g. ceil(qty / perSheet)"
          value={formula.expr}
          onChange={(v) => onChange((f) => ({ ...f, expr: v }))}
        />
      </FlexBox>
    </Dialog>
  );
}

function RulesPanel({ model, setModel, suggestions, scope }: {
  model: Model; setModel: React.Dispatch<React.SetStateAction<Model>>; suggestions: Suggest[]; scope: Scope;
}) {
  const finite = useMemo(
    () => new Set(flatten(model).parameters.filter((p) => p.domain.kind === "static" || p.domain.kind === "datasource").map((p) => p.name)),
    [model],
  );
  const varsOf = (expr: string): string[] =>
    Array.from(new Set(expr.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? [])).filter((t) => finite.has(t));

  const setRule = (i: number, expr: string) =>
    setModel((m) => ({ ...m, rules: m.rules.map((r, j) => (j === i ? { expr, vars: varsOf(expr) } : r)) }));
  const addRule = () => setModel((m) => ({ ...m, rules: [...m.rules, { expr: "", vars: [] }] }));
  const removeRule = (i: number) => setModel((m) => ({ ...m, rules: m.rules.filter((_, j) => j !== i) }));

  return (
    <FlexBox direction="Column" style={{ gap: "0.5rem", padding: "0.5rem" }}>
        <Text style={{ opacity: 0.6 }}>Boolean expressions that must hold. They narrow the options bidirectionally as the user picks.</Text>
        {model.rules.map((r, i) => (
          <FlexBox key={i} alignItems="Center" style={{ gap: "0.5rem" }}>
            <ExprInput
              style={{ flex: 1 }}
              suggestions={suggestions}
              scope={scope}
              bool
              placeholder='e.g. quality != "high" or machining != "punching"'
              value={r.expr}
              onChange={(v) => setRule(i, v)}
            />
            <Button icon="delete" design="Transparent" onClick={() => removeRule(i)} />
          </FlexBox>
        ))}
        <Button icon="add" design="Transparent" onClick={addRule} style={{ alignSelf: "flex-start" }}>Add rule</Button>
    </FlexBox>
  );
}
