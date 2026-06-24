import { useMemo, useRef, useState, useEffect } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient, skipToken } from "@tanstack/react-query";
import {
  DynamicPage, DynamicPageTitle, Bar, Button, Input, Title, Text, Label, MessageStrip, BusyIndicator,
  Table, TableHeaderRow, TableHeaderCell, TableRow, TableCell,
  Dialog, TabContainer, Tab, Select, Option, Switch, FlexBox, Panel, TextArea,
  Toolbar, ToolbarButton,
} from "@ui5/webcomponents-react";
import type { Model, FormSection, FormGroup, FormItem, DataSource, InputType, Value } from "@hera/config-engine";
import { flatten, enumerate, lintModel } from "@hera/config-engine";
import { orpc } from "../orpc.ts";
import { blankModel, blankSection, blankGroup, blankItem } from "../lib/model.ts";

type Editing = { sid: string; gid?: string; iid?: string } | null;
type Drag = { type: "section" | "group" | "item"; sid: string; gid?: string; iid?: string } | null;

const parseValues = (s: string): Value[] =>
  s.split(",").map((x) => x.trim()).filter(Boolean).map((x) => (x !== "" && !isNaN(Number(x)) ? Number(x) : x));
const joinValues = (v?: Value[]): string => (v ?? []).join(", ");

export function ModelBuilder({ id }: { id: string }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const isNew = id === "new";

  const get = useQuery(orpc.models.get.queryOptions({ input: isNew ? skipToken : { id } }));
  const tables = useQuery(orpc.tables.list.queryOptions());

  const [model, setModel] = useState<Model>(blankModel());
  const [editing, setEditing] = useState<Editing>(null);
  const drag = useRef<Drag>(null);

  useEffect(() => {
    if (!isNew && get.data) {
      // Coerce a legacy/partial definition into the current shape so the builder never crashes.
      const def = get.data.definition as unknown as Partial<Model>;
      setModel({ name: def.name ?? "Model", family: def.family ?? "", sections: def.sections ?? [], rules: def.rules ?? [] });
    }
  }, [isNew, get.data]);

  const errors = useMemo(() => lintModel(model), [model]);
  const preview = useMemo(() => {
    if (errors.length) return null;
    try {
      return enumerate(flatten(model), {}, { cap: 200 });
    } catch {
      return null;
    }
  }, [model, errors]);

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

  // --- drag & drop (native HTML5; reorder within a parent, or move into another parent) ---
  const moveSection = (sid: string, beforeSid?: string) =>
    setModel((m) => {
      const from = m.sections.findIndex((s) => s.id === sid);
      if (from < 0) return m;
      const arr = m.sections.slice();
      const [x] = arr.splice(from, 1);
      const idx = beforeSid ? arr.findIndex((s) => s.id === beforeSid) : arr.length;
      arr.splice(idx < 0 ? arr.length : idx, 0, x!);
      return { ...m, sections: arr };
    });
  const moveGroup = (from: { sid: string; gid: string }, toSid: string, beforeGid?: string) =>
    setModel((m) => {
      let moved: FormGroup | undefined;
      const stripped = m.sections.map((s) =>
        s.id === from.sid ? { ...s, groups: s.groups.filter((g) => (g.id === from.gid ? ((moved = g), false) : true)) } : s,
      );
      if (!moved) return m;
      return {
        ...m,
        sections: stripped.map((s) => {
          if (s.id !== toSid) return s;
          if (!beforeGid) return { ...s, groups: [...s.groups, moved!] };
          const idx = s.groups.findIndex((g) => g.id === beforeGid);
          const groups = s.groups.slice();
          groups.splice(idx < 0 ? groups.length : idx, 0, moved!);
          return { ...s, groups };
        }),
      };
    });
  const moveItem = (from: { sid: string; gid: string; iid: string }, toSid: string, toGid: string, beforeIid?: string) =>
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
            if (!(s.id === toSid && g.id === toGid)) return g;
            if (!beforeIid) return { ...g, items: [...g.items, moved!] };
            const idx = g.items.findIndex((it) => it.id === beforeIid);
            const items = g.items.slice();
            items.splice(idx < 0 ? items.length : idx, 0, moved!);
            return { ...g, items };
          }),
        })),
      };
    });

  const onSectionDrop = (sid: string) => {
    const d = drag.current;
    if (d?.type === "section") moveSection(d.sid, sid);
    else if (d?.type === "group" && d.gid) moveGroup({ sid: d.sid, gid: d.gid }, sid);
    drag.current = null;
  };
  const onGroupDrop = (sid: string, gid: string) => {
    const d = drag.current;
    if (d?.type === "group" && d.gid) moveGroup({ sid: d.sid, gid: d.gid }, sid, gid);
    else if (d?.type === "item" && d.gid && d.iid) moveItem({ sid: d.sid, gid: d.gid, iid: d.iid }, sid, gid);
    drag.current = null;
  };
  const onItemDrop = (sid: string, gid: string, iid: string) => {
    const d = drag.current;
    if (d?.type === "item" && d.gid && d.iid) moveItem({ sid: d.sid, gid: d.gid, iid: d.iid }, sid, gid, iid);
    drag.current = null;
  };

  if (!isNew && get.isPending) return <BusyIndicator active style={{ margin: "2rem" }} />;

  const es = editing ? model.sections.find((s) => s.id === editing.sid) : undefined;
  const eg = editing?.gid && es ? es.groups.find((g) => g.id === editing.gid) : undefined;
  const ei = editing?.iid && eg ? eg.items.find((it) => it.id === editing.iid) : undefined;

  return (
    <DynamicPage
      hidePinButton
      titleArea={
        <DynamicPageTitle
          heading={<Title level="H4">Model builder</Title>}
          actionsBar={
            <Toolbar design="Transparent">
              <ToolbarButton icon="add" text="Add section" onClick={addSection} />
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
          </MessageStrip>
        )}

        {/* Section -> FormGroup -> FormItem */}
        {model.sections.map((s) => (
          <div key={s.id} onDragOver={(e) => e.preventDefault()} onDrop={() => onSectionDrop(s.id)}>
            <Panel
              headerLevel="H5"
              header={
                <FlexBox
                  alignItems="Center"
                  style={{ gap: "0.5rem", width: "100%" }}
                  draggable
                  onDragStart={() => (drag.current = { type: "section", sid: s.id })}
                >
                  <Text style={{ cursor: "grab" }}>⠿</Text>
                  <Title level="H5">{s.label}</Title>
                  {s.visibility ? <Text style={{ opacity: 0.6 }}>· visible if {s.visibility}</Text> : null}
                  <span style={{ flex: 1 }} />
                  <Button icon="edit" design="Transparent" onClick={() => setEditing({ sid: s.id })} tooltip="Edit section" />
                  <Button icon="add" design="Transparent" onClick={() => addGroup(s.id)} tooltip="Add group" />
                  <Button icon="delete" design="Transparent" onClick={() => removeSection(s.id)} tooltip="Delete section" />
                </FlexBox>
              }
            >
              <FlexBox direction="Column" style={{ gap: "0.75rem" }}>
                {s.groups.map((g) => (
                  <div
                    key={g.id}
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={(e) => { e.stopPropagation(); onGroupDrop(s.id, g.id); }}
                    style={{ border: "1px solid var(--sapList_BorderColor)", borderRadius: 8 }}
                  >
                    <FlexBox
                      alignItems="Center"
                      style={{ gap: "0.5rem", padding: "0.25rem 0.5rem" }}
                      draggable
                      onDragStart={() => (drag.current = { type: "group", sid: s.id, gid: g.id })}
                    >
                      <Text style={{ cursor: "grab" }}>⠿</Text>
                      <Title level="H6">{g.label}</Title>
                      {g.visibility ? <Text style={{ opacity: 0.6 }}>· visible if {g.visibility}</Text> : null}
                      <span style={{ flex: 1 }} />
                      <Button icon="edit" design="Transparent" onClick={() => setEditing({ sid: s.id, gid: g.id })} tooltip="Edit group" />
                      <Button icon="add" design="Transparent" onClick={() => addItem(s.id, g.id)} tooltip="Add field" />
                      <Button icon="delete" design="Transparent" onClick={() => removeGroup(s.id, g.id)} tooltip="Delete group" />
                    </FlexBox>
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
                      noDataText="No fields yet — use ＋ to add one"
                    >
                      {g.items.map((it) => (
                        <TableRow
                          key={it.id}
                          draggable
                          onDragStart={(e) => { (e as unknown as { stopPropagation(): void }).stopPropagation(); drag.current = { type: "item", sid: s.id, gid: g.id, iid: it.id }; }}
                          onDragOver={(e) => e.preventDefault()}
                          onDrop={(e) => { e.stopPropagation(); onItemDrop(s.id, g.id, it.id); }}
                          style={{ cursor: "pointer" }}
                          onClick={() => setEditing({ sid: s.id, gid: g.id, iid: it.id })}
                        >
                          <TableCell><Text>{it.label}{it.input.mandatory ? " *" : ""}</Text></TableCell>
                          <TableCell><Text>{it.name}</Text></TableCell>
                          <TableCell><Text>{it.input.inputType}</Text></TableCell>
                          <TableCell><Text>{it.input.dataSource.kind}</Text></TableCell>
                          <TableCell><Text>{it.input.value.kind === "formula" ? `= ${it.input.value.expr}` : "manual"}</Text></TableCell>
                        </TableRow>
                      ))}
                    </Table>
                  </div>
                ))}
                {s.groups.length === 0 ? <Text style={{ opacity: 0.6 }}>No groups yet — use ＋ to add one.</Text> : null}
              </FlexBox>
            </Panel>
          </div>
        ))}
        {model.sections.length === 0 ? <Text style={{ opacity: 0.6 }}>No sections yet — use “Add section”.</Text> : null}

        <RulesPanel model={model} setModel={setModel} />
      </FlexBox>

      {ei ? (
        <ItemDialog
          item={ei}
          tables={tables.data ?? []}
          onClose={() => setEditing(null)}
          onChange={(fn) => patchItem(editing!.sid, editing!.gid!, editing!.iid!, fn)}
          onDelete={() => { removeItem(editing!.sid, editing!.gid!, editing!.iid!); setEditing(null); }}
        />
      ) : eg ? (
        <NodeDialog
          title="Group"
          label={eg.label}
          visibility={eg.visibility}
          onClose={() => setEditing(null)}
          onLabel={(v) => patchGroup(editing!.sid, editing!.gid!, (g) => ({ ...g, label: v }))}
          onVisibility={(v) => patchGroup(editing!.sid, editing!.gid!, (g) => ({ ...g, visibility: v }))}
        />
      ) : es ? (
        <NodeDialog
          title="Section"
          label={es.label}
          visibility={es.visibility}
          onClose={() => setEditing(null)}
          onLabel={(v) => patchSection(editing!.sid, (s) => ({ ...s, label: v }))}
          onVisibility={(v) => patchSection(editing!.sid, (s) => ({ ...s, visibility: v }))}
        />
      ) : null}
    </DynamicPage>
  );
}

// Shared edit dialog for a section or a group: Description + Visibility.
function NodeDialog({ title, label, visibility, onClose, onLabel, onVisibility }: {
  title: string; label: string; visibility?: string; onClose: () => void;
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
        <Input
          placeholder='e.g. product == "plaque"'
          value={visibility ?? ""}
          onInput={(e) => onVisibility(e.target.value || undefined)}
        />
      </FlexBox>
    </Dialog>
  );
}

function ItemDialog({
  item, tables, onClose, onChange, onDelete,
}: {
  item: FormItem;
  tables: { id: string; name: string }[];
  onClose: () => void;
  onChange: (fn: (it: FormItem) => FormItem) => void;
  onDelete: () => void;
}) {
  const ds = item.input.dataSource;
  const setInput = (patch: Partial<FormItem["input"]>) => onChange((it) => ({ ...it, input: { ...it.input, ...patch } }));
  const setDs = (next: DataSource) => setInput({ dataSource: next });

  return (
    <Dialog
      open
      headerText={`Field · ${item.label}`}
      onClose={onClose}
      style={{ width: 560 }}
      footer={
        <Bar
          startContent={<Button design="Negative" icon="delete" onClick={onDelete}>Delete</Button>}
          endContent={<Button design="Emphasized" onClick={onClose}>Done</Button>}
        />
      }
    >
      <TabContainer contentBackgroundDesign="Transparent">
        <Tab text="Details" selected>
          <FlexBox direction="Column" style={{ gap: "0.6rem", padding: "0.5rem" }}>
            <Label>Description</Label>
            <Input value={item.label} onInput={(e) => onChange((it) => ({ ...it, label: e.target.value }))} />
            <Label>Name (used in formulas)</Label>
            <Input value={item.name} onInput={(e) => onChange((it) => ({ ...it, name: e.target.value }))} />
            <Label>Visibility formula (optional)</Label>
            <Input
              placeholder='e.g. quality == "high"'
              value={item.visibility ?? ""}
              onInput={(e) => onChange((it) => ({ ...it, visibility: e.target.value || undefined }))}
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
            <Select onChange={(e) => setInput({ inputType: (e.detail.selectedOption.dataset.key ?? "input") as InputType })}>
              {(["input", "radio", "checkbox", "multicombo"] as InputType[]).map((t) => (
                <Option key={t} data-key={t} selected={item.input.inputType === t}>{t}</Option>
              ))}
            </Select>

            <Label>Data source</Label>
            <Select
              onChange={(e) => {
                const k = e.detail.selectedOption.dataset.key;
                if (k === "normal") setDs({ kind: "normal" });
                else if (k === "table") setDs({ kind: "table", tableId: tables[0]?.id ?? "" });
                else setDs({ kind: "query", source: "b1", path: "", valueField: "" });
              }}
            >
              <Option data-key="normal" selected={ds.kind === "normal"}>Normal</Option>
              <Option data-key="table" selected={ds.kind === "table"}>Table</Option>
              <Option data-key="query" selected={ds.kind === "query"}>Query</Option>
            </Select>

            {ds.kind === "normal" ? (
              <>
                <Label>Options (comma-separated; leave empty for free input)</Label>
                <Input value={joinValues(ds.values)} onInput={(e) => setDs({ kind: "normal", values: parseValues(e.target.value) })} />
              </>
            ) : ds.kind === "table" ? (
              <>
                <Label>Table</Label>
                <Select onChange={(e) => setDs({ kind: "table", tableId: e.detail.selectedOption.dataset.key ?? "" })}>
                  {tables.map((t) => (
                    <Option key={t.id} data-key={t.id} selected={ds.tableId === t.id}>{t.name}</Option>
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
              onChange={(e) =>
                setInput({ value: e.detail.selectedOption.dataset.key === "formula" ? { kind: "formula", expr: "" } : { kind: "manual" } })
              }
            >
              <Option data-key="manual" selected={item.input.value.kind === "manual"}>Manual (user picks)</Option>
              <Option data-key="formula" selected={item.input.value.kind === "formula"}>Formula (derived)</Option>
            </Select>
            {item.input.value.kind === "formula" ? (
              <Input
                placeholder='e.g. printing == "digital" ? "1000x500" : "500x500"'
                value={item.input.value.expr}
                onInput={(e) => setInput({ value: { kind: "formula", expr: e.target.value } })}
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
            <TextArea
              rows={2}
              placeholder="e.g. 200 + sheetsNeeded * (10 + thickness) + qty * 0.5"
              value={item.price ?? ""}
              onInput={(e) => onChange((it) => ({ ...it, price: e.target.value || undefined }))}
            />
          </FlexBox>
        </Tab>
      </TabContainer>
    </Dialog>
  );
}

function RulesPanel({ model, setModel }: { model: Model; setModel: React.Dispatch<React.SetStateAction<Model>> }) {
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
    <Panel headerText="Constraint rules" headerLevel="H5" collapsed>
      <FlexBox direction="Column" style={{ gap: "0.5rem", padding: "0.5rem" }}>
        <Text style={{ opacity: 0.6 }}>Boolean expressions that must hold. They narrow the options bidirectionally as the user picks.</Text>
        {model.rules.map((r, i) => (
          <FlexBox key={i} alignItems="Center" style={{ gap: "0.5rem" }}>
            <Input
              style={{ flex: 1 }}
              placeholder='e.g. quality != "high" or machining != "punching"'
              value={r.expr}
              onInput={(e) => setRule(i, e.target.value)}
            />
            <Button icon="delete" design="Transparent" onClick={() => removeRule(i)} />
          </FlexBox>
        ))}
        <Button icon="add" design="Transparent" onClick={addRule} style={{ alignSelf: "flex-start" }}>Add rule</Button>
      </FlexBox>
    </Panel>
  );
}
