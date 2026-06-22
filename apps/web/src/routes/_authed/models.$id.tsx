import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient, skipToken } from "@tanstack/react-query";
import {
  Card, CardHeader, Input, Button, Select, Option, Label, MessageStrip, FlexBox, Title, Text, Switch, BusyIndicator,
} from "@ui5/webcomponents-react";
import {
  lintModel, enumerate, evaluate, type Model, type ParamDomain,
} from "@hera/config-engine";
import { orpc } from "../../orpc.ts";

export const Route = createFileRoute("/_authed/models/$id")({ component: Editor });

// --- editing shape: a parameter's domain is edited as one compact `detail` string by kind;
// constraint `vars` are derived from the expression on save. ---
type Kind = ParamDomain["kind"];
interface EditParam { name: string; label: string; type: "enum" | "number" | "bool"; kind: Kind; detail: string }
interface EditModel {
  name: string; family: string;
  parameters: EditParam[];
  constraints: { expr: string }[];
  formulas: { name: string; expr: string }[];
  bom: { item: string; qtyExpr: string; condition: string }[];
  routing: { operation: string; timeExpr: string; condition: string }[];
  costExpr: string; markupExpr: string;
}
const BLANK: EditModel = { name: "", family: "", parameters: [], constraints: [], formulas: [], bom: [], routing: [], costExpr: "0", markupExpr: "0" };

const DETAIL_HINT: Record<Kind, string> = {
  static: "comma values, e.g.  S, M, L   or   0.5, 1, 2",
  range: "min, max, step   e.g.  0.5, 10, 0.5",
  datasource: "Entity.field[:labelField]   e.g.  Items.ItemCode:ItemName",
  input: "(free value entered at config time — no list)",
};

function parseDomain(kind: Kind, detail: string): ParamDomain {
  if (kind === "input") return { kind: "input" };
  if (kind === "range") {
    const [min, max, step] = detail.split(",").map((s) => Number(s.trim()));
    return { kind: "range", min: min ?? 0, max: max ?? 0, step: step || 1 };
  }
  if (kind === "datasource") {
    const [ent, rest] = detail.split(".");
    const [valueField, labelField] = (rest ?? "").split(":");
    return { kind: "datasource", entity: (ent ?? "").trim(), valueField: (valueField ?? "").trim(), labelField: labelField?.trim() || undefined };
  }
  const parts = detail.split(",").map((s) => s.trim()).filter(Boolean);
  const numeric = parts.length > 0 && parts.every((p) => !isNaN(Number(p)));
  return { kind: "static", values: numeric ? parts.map(Number) : parts };
}
function domainToDetail(d: ParamDomain): string {
  if (d.kind === "static") return d.values.join(", ");
  if (d.kind === "range") return `${d.min}, ${d.max}, ${d.step}`;
  if (d.kind === "datasource") return `${d.entity}.${d.valueField}${d.labelField ? ":" + d.labelField : ""}`;
  return "";
}

function fromModel(m: Model): EditModel {
  return {
    name: m.name, family: m.family,
    parameters: m.parameters.map((p) => ({ name: p.name, label: p.label, type: p.type, kind: p.domain.kind, detail: domainToDetail(p.domain) })),
    constraints: m.constraints.map((c) => ({ expr: c.expr })),
    formulas: m.formulas.map((f) => ({ ...f })),
    bom: m.bom.map((b) => ({ item: b.item, qtyExpr: b.qtyExpr, condition: b.condition ?? "" })),
    routing: m.routing.map((o) => ({ operation: o.operation, timeExpr: o.timeExpr, condition: o.condition ?? "" })),
    costExpr: m.pricing.costExpr, markupExpr: m.pricing.markupExpr,
  };
}
function toModel(em: EditModel): Model {
  const parameters = em.parameters.filter((p) => p.name.trim()).map((p) => ({ name: p.name, label: p.label, type: p.type, domain: parseDomain(p.kind, p.detail) }));
  const names = parameters.map((p) => p.name);
  const varsOf = (expr: string): string[] => names.filter((n) => new RegExp(`(?<![A-Za-z0-9_])${n}(?![A-Za-z0-9_])`).test(expr));
  return {
    name: em.name, family: em.family,
    parameters,
    constraints: em.constraints.filter((c) => c.expr.trim()).map((c) => ({ expr: c.expr, vars: varsOf(c.expr) })),
    formulas: em.formulas.filter((f) => f.name.trim() && f.expr.trim()),
    bom: em.bom.filter((b) => b.item.trim()).map((b) => ({ item: b.item, qtyExpr: b.qtyExpr || "0", condition: b.condition.trim() || undefined })),
    routing: em.routing.filter((o) => o.operation.trim()).map((o) => ({ operation: o.operation, timeExpr: o.timeExpr || "0", condition: o.condition.trim() || undefined })),
    pricing: { costExpr: em.costExpr || "0", markupExpr: em.markupExpr || "0" },
  };
}

function Editor() {
  const { id } = Route.useParams();
  const isNew = id === "new";
  const navigate = useNavigate();
  const qc = useQueryClient();

  const existing = useQuery(orpc.config.get.queryOptions({ input: isNew ? skipToken : { id } }));
  const [em, setEm] = useState<EditModel>(BLANK);
  const [published, setPublished] = useState(false);
  const [loaded, setLoaded] = useState(isNew);

  useEffect(() => {
    if (!isNew && existing.data && !loaded) {
      setEm(fromModel(existing.data.definition as unknown as Model));
      setPublished(existing.data.published);
      setLoaded(true);
    }
  }, [isNew, existing.data, loaded]);

  // generic immutable array helpers for the list sections
  type ArrKey = "parameters" | "constraints" | "formulas" | "bom" | "routing";
  const setRow = (k: ArrKey, i: number, patch: object) =>
    setEm((m) => ({ ...m, [k]: (m[k] as object[]).map((r, j) => (j === i ? { ...r, ...patch } : r)) }));
  const addRow = (k: ArrKey, blank: object) => setEm((m) => ({ ...m, [k]: [...(m[k] as object[]), blank] }));
  const delRow = (k: ArrKey, i: number) => setEm((m) => ({ ...m, [k]: (m[k] as object[]).filter((_, j) => j !== i) }));

  const model = useMemo(() => toModel(em), [em]);
  const preview = useMemo(() => {
    try {
      const errs = lintModel(model);
      if (errs.length) return { errs, count: 0, sample: null as null | ReturnType<typeof evaluate> };
      const { solutions, truncated } = enumerate(model, {}, { cap: 200 });
      const sample = solutions[0] ? evaluate(model, solutions[0]) : null;
      return { errs: [], count: solutions.length, truncated, sample };
    } catch (e) {
      return { errs: [(e as Error).message], count: 0, sample: null };
    }
  }, [model]);

  const save = useMutation(
    orpc.config.save.mutationOptions({
      onSuccess: (r) => {
        qc.invalidateQueries({ queryKey: orpc.config.list.queryOptions().queryKey });
        if (isNew) navigate({ to: "/models/$id", params: { id: r.id } });
      },
    }),
  );
  const pub = useMutation(
    orpc.config.publish.mutationOptions({
      onSuccess: () => qc.invalidateQueries({ queryKey: orpc.config.list.queryOptions().queryKey }),
    }),
  );

  if (!isNew && existing.isPending) return <BusyIndicator active />;

  const SectionHeader = ({ title, onAdd }: { title: string; onAdd: () => void }) => (
    <FlexBox style={{ justifyContent: "space-between", alignItems: "center" }}>
      <Title level="H5">{title}</Title>
      <Button icon="add" onClick={onAdd}>Add</Button>
    </FlexBox>
  );
  const Remove = ({ onClick }: { onClick: () => void }) => <Button icon="delete" design="Transparent" onClick={onClick} />;

  return (
    <div style={{ padding: "1rem", maxWidth: 980, margin: "0 auto", display: "flex", flexDirection: "column", gap: "1rem" }}>
      <FlexBox style={{ justifyContent: "space-between", alignItems: "center" }}>
        <Title level="H4">{isNew ? "New model" : em.name || "Model"}</Title>
        <Button design="Transparent" onClick={() => navigate({ to: "/models" })}>Back</Button>
      </FlexBox>

      <Card>
        <FlexBox direction="Column" style={{ padding: "1rem", gap: "0.75rem" }}>
          <FlexBox style={{ gap: "1rem", flexWrap: "wrap" }}>
            <FlexBox direction="Column"><Label>Name</Label><Input value={em.name} onInput={(e) => setEm((m) => ({ ...m, name: e.target.value }))} /></FlexBox>
            <FlexBox direction="Column"><Label>Family</Label><Input value={em.family} onInput={(e) => setEm((m) => ({ ...m, family: e.target.value }))} /></FlexBox>
          </FlexBox>
        </FlexBox>
      </Card>

      {/* Parameters */}
      <Card>
        <FlexBox direction="Column" style={{ padding: "1rem", gap: "0.75rem" }}>
          <SectionHeader title="Parameters" onAdd={() => addRow("parameters", { name: "", label: "", type: "enum", kind: "static", detail: "" })} />
          {em.parameters.map((p, i) => (
            <FlexBox key={i} style={{ gap: "0.5rem", alignItems: "end", flexWrap: "wrap" }}>
              <FlexBox direction="Column"><Label>name</Label><Input value={p.name} style={{ width: 130 }} onInput={(e) => setRow("parameters", i, { name: e.target.value })} /></FlexBox>
              <FlexBox direction="Column"><Label>label</Label><Input value={p.label} style={{ width: 130 }} onInput={(e) => setRow("parameters", i, { label: e.target.value })} /></FlexBox>
              <FlexBox direction="Column"><Label>type</Label>
                <Select onChange={(e) => setRow("parameters", i, { type: (e.detail.selectedOption as HTMLElement).dataset.value })}>
                  {(["enum", "number", "bool"] as const).map((t) => <Option key={t} data-value={t} selected={p.type === t}>{t}</Option>)}
                </Select>
              </FlexBox>
              <FlexBox direction="Column"><Label>domain</Label>
                <Select onChange={(e) => setRow("parameters", i, { kind: (e.detail.selectedOption as HTMLElement).dataset.value })}>
                  {(["static", "range", "datasource", "input"] as const).map((k) => <Option key={k} data-value={k} selected={p.kind === k}>{k}</Option>)}
                </Select>
              </FlexBox>
              <FlexBox direction="Column" style={{ flex: 1, minWidth: 220 }}><Label>detail</Label>
                <Input value={p.detail} placeholder={DETAIL_HINT[p.kind]} onInput={(e) => setRow("parameters", i, { detail: e.target.value })} />
              </FlexBox>
              <Remove onClick={() => delRow("parameters", i)} />
            </FlexBox>
          ))}
        </FlexBox>
      </Card>

      {/* Constraints */}
      <Card>
        <FlexBox direction="Column" style={{ padding: "1rem", gap: "0.5rem" }}>
          <SectionHeader title="Constraints (must hold)" onAdd={() => addRow("constraints", { expr: "" })} />
          <Text style={{ opacity: 0.6, fontSize: "0.8rem" }}>Boolean expression over parameter names. e.g. <code>printing != "digital" or format == "1000x500"</code></Text>
          {em.constraints.map((c, i) => (
            <FlexBox key={i} style={{ gap: "0.5rem", alignItems: "center" }}>
              <Input value={c.expr} style={{ flex: 1 }} onInput={(e) => setRow("constraints", i, { expr: e.target.value })} />
              <Remove onClick={() => delRow("constraints", i)} />
            </FlexBox>
          ))}
        </FlexBox>
      </Card>

      {/* Formulas */}
      <Card>
        <FlexBox direction="Column" style={{ padding: "1rem", gap: "0.5rem" }}>
          <SectionHeader title="Formulas (derived values)" onAdd={() => addRow("formulas", { name: "", expr: "" })} />
          <Text style={{ opacity: 0.6, fontSize: "0.8rem" }}>Helpers: <code>fit(w,h,sw,sh)</code>, <code>sheetW/sheetH(format)</code>, <code>concat(a,b)</code>, <code>ceil/floor/min/max</code>.</Text>
          {em.formulas.map((f, i) => (
            <FlexBox key={i} style={{ gap: "0.5rem", alignItems: "center" }}>
              <Input value={f.name} placeholder="name" style={{ width: 150 }} onInput={(e) => setRow("formulas", i, { name: e.target.value })} />
              <Input value={f.expr} placeholder="expression" style={{ flex: 1 }} onInput={(e) => setRow("formulas", i, { expr: e.target.value })} />
              <Remove onClick={() => delRow("formulas", i)} />
            </FlexBox>
          ))}
        </FlexBox>
      </Card>

      {/* BOM */}
      <Card>
        <FlexBox direction="Column" style={{ padding: "1rem", gap: "0.5rem" }}>
          <SectionHeader title="Bill of materials" onAdd={() => addRow("bom", { item: "", qtyExpr: "", condition: "" })} />
          {em.bom.map((b, i) => (
            <FlexBox key={i} style={{ gap: "0.5rem", alignItems: "center", flexWrap: "wrap" }}>
              <Input value={b.item} placeholder="item expr" style={{ width: 220 }} onInput={(e) => setRow("bom", i, { item: e.target.value })} />
              <Input value={b.qtyExpr} placeholder="qty expr" style={{ width: 150 }} onInput={(e) => setRow("bom", i, { qtyExpr: e.target.value })} />
              <Input value={b.condition} placeholder="condition (optional)" style={{ flex: 1 }} onInput={(e) => setRow("bom", i, { condition: e.target.value })} />
              <Remove onClick={() => delRow("bom", i)} />
            </FlexBox>
          ))}
        </FlexBox>
      </Card>

      {/* Routing */}
      <Card>
        <FlexBox direction="Column" style={{ padding: "1rem", gap: "0.5rem" }}>
          <SectionHeader title="Routing operations" onAdd={() => addRow("routing", { operation: "", timeExpr: "", condition: "" })} />
          {em.routing.map((o, i) => (
            <FlexBox key={i} style={{ gap: "0.5rem", alignItems: "center", flexWrap: "wrap" }}>
              <Input value={o.operation} placeholder="operation" style={{ width: 220 }} onInput={(e) => setRow("routing", i, { operation: e.target.value })} />
              <Input value={o.timeExpr} placeholder="time expr" style={{ width: 150 }} onInput={(e) => setRow("routing", i, { timeExpr: e.target.value })} />
              <Input value={o.condition} placeholder="condition (optional)" style={{ flex: 1 }} onInput={(e) => setRow("routing", i, { condition: e.target.value })} />
              <Remove onClick={() => delRow("routing", i)} />
            </FlexBox>
          ))}
        </FlexBox>
      </Card>

      {/* Pricing */}
      <Card>
        <FlexBox direction="Column" style={{ padding: "1rem", gap: "0.5rem" }}>
          <Title level="H5">Pricing</Title>
          <FlexBox style={{ gap: "1rem", flexWrap: "wrap" }}>
            <FlexBox direction="Column" style={{ flex: 1 }}><Label>cost expression</Label><Input value={em.costExpr} onInput={(e) => setEm((m) => ({ ...m, costExpr: e.target.value }))} /></FlexBox>
            <FlexBox direction="Column" style={{ width: 200 }}><Label>markup (fraction)</Label><Input value={em.markupExpr} onInput={(e) => setEm((m) => ({ ...m, markupExpr: e.target.value }))} /></FlexBox>
          </FlexBox>
        </FlexBox>
      </Card>

      {/* Live preview */}
      <Card header={<CardHeader titleText="Preview" subtitleText="Runs the engine in your browser as you edit" />}>
        <FlexBox direction="Column" style={{ padding: "1rem", gap: "0.5rem" }}>
          {preview.errs.length ? (
            preview.errs.map((e, i) => <MessageStrip key={i} design="Negative" hideCloseButton>{e}</MessageStrip>)
          ) : (
            <>
              <Text>{preview.count} valid configuration(s){preview.truncated ? " (capped at 200)" : ""}</Text>
              {preview.sample ? (
                <Text style={{ fontFamily: "monospace", fontSize: "0.8rem", whiteSpace: "pre-wrap" }}>
                  {`sample price: ${preview.sample.price}\nbom: ${JSON.stringify(preview.sample.bom)}\nrouting: ${JSON.stringify(preview.sample.routing)}`}
                </Text>
              ) : <Text>No complete configuration yet — add parameters/values.</Text>}
            </>
          )}
        </FlexBox>
      </Card>

      {save.error ? <MessageStrip design="Negative" hideCloseButton>{save.error.message}</MessageStrip> : null}
      {save.isSuccess ? <MessageStrip design="Positive" hideCloseButton>Saved.</MessageStrip> : null}
      <FlexBox style={{ gap: "1rem", alignItems: "center" }}>
        <Button design="Emphasized" disabled={save.isPending || preview.errs.length > 0} onClick={() => save.mutate({ id: isNew ? undefined : id, definition: model })}>
          {save.isPending ? "Saving…" : "Save"}
        </Button>
        {!isNew ? (
          <FlexBox style={{ gap: "0.5rem", alignItems: "center" }}>
            <Label>Published</Label>
            <Switch checked={published} onChange={(e) => { setPublished(e.target.checked); pub.mutate({ id, published: e.target.checked }); }} />
          </FlexBox>
        ) : <Text style={{ opacity: 0.6 }}>Save first, then publish to make it available in Configure.</Text>}
      </FlexBox>
    </div>
  );
}
