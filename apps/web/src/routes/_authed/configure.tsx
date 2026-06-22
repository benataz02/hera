import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { useMutation, useQuery, skipToken } from "@tanstack/react-query";
import {
  Card, CardHeader, Select, Option, Input, Button, Label, MessageStrip, FlexBox, Title,
  CheckBox, ObjectStatus, BusyIndicator, Text,
} from "@ui5/webcomponents-react";
import {
  initialDomains, propagate, enumerate, evaluate, buildPushDoc,
  type Model, type Value, type Assignment, type Evaluated,
} from "@hera/config-engine";
import { orpc, client } from "../../orpc.ts";

export const Route = createFileRoute("/_authed/configure")({ component: Configure });

const STATE: Record<string, "None" | "Information" | "Positive" | "Negative"> = {
  draft: "None", syncing: "Information", synced: "Positive", failed: "Negative",
};

interface Row extends Evaluated { assignment: Assignment; }

function Configure() {
  const models = useQuery(orpc.config.list.queryOptions());
  const published = (models.data ?? []).filter((m) => m.published);

  const [modelId, setModelId] = useState("");
  const [assignment, setAssignment] = useState<Assignment>({});
  const [batches, setBatches] = useState<number[]>([]);
  const [computed, setComputed] = useState<{ rows: Row[]; truncated: boolean } | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [quoteId, setQuoteId] = useState<string | null>(null);

  const modelQ = useQuery(orpc.config.get.queryOptions({ input: modelId ? { id: modelId } : skipToken }));
  const model = modelQ.data?.definition as Model | undefined;

  // Datasource-backed parameters: pull candidate values from B1 via the existing entities.list path.
  const dsParams = useMemo(
    () => (model?.parameters ?? []).filter((p) => p.domain.kind === "datasource"),
    [model],
  );
  const resolvedQ = useQuery({
    queryKey: ["resolved-domains", modelId],
    enabled: !!model,
    queryFn: async () => {
      const out: Record<string, Value[]> = {};
      for (const p of dsParams) {
        const d = p.domain as { entity: string; valueField: string };
        const { rows } = await client.entities.list({ entity: d.entity, top: 200 });
        out[p.name] = rows.map((r) => r[d.valueField]).filter((v): v is Value => v != null);
      }
      return out;
    },
  });
  const resolved = resolvedQ.data ?? {};

  const baseDomains = useMemo(() => (model ? initialDomains(model, resolved) : {}), [model, resolved]);
  const finite = useMemo(
    () => (model?.parameters ?? []).filter((p) => p.name in baseDomains),
    [model, baseDomains],
  );
  const inputs = useMemo(
    () => (model?.parameters ?? []).filter((p) => !(p.name in baseDomains)),
    [model, baseDomains],
  );
  const qtyParam = finite.find((p) => p.name === "qty")?.name;
  const qtyDomain = (qtyParam ? baseDomains[qtyParam] : undefined) ?? [];

  // A finite param's still-valid options = its domain narrowed by every OTHER current pick.
  const optionsFor = (name: string): Value[] => {
    if (!model) return [];
    const a = { ...assignment };
    delete a[name];
    const pr = propagate(model, baseDomains, a);
    return pr.ok ? (pr.domains[name] ?? []) : (baseDomains[name] ?? []);
  };

  const reset = (id: string) => {
    setModelId(id);
    setAssignment({});
    setBatches([]);
    setComputed(null);
    setSelected(new Set());
    setQuoteId(null);
  };

  // Pick a value, then drop any other pick that just lost support (keeps the form consistent).
  const pick = (name: string, strVal: string): void => {
    const v = optionsFor(name).find((x) => String(x) === strVal);
    setComputed(null);
    setAssignment((prev) => {
      const next: Assignment = v === undefined ? (() => { const c = { ...prev }; delete c[name]; return c; })() : { ...prev, [name]: v };
      if (!model) return next;
      for (const p of finite) {
        if (p.name === name || !(p.name in next)) continue;
        const a = { ...next };
        delete a[p.name];
        const pr = propagate(model, baseDomains, a);
        const dom = pr.ok ? pr.domains[p.name] ?? [] : [];
        if (!dom.includes(next[p.name]!)) delete next[p.name];
      }
      return next;
    });
  };

  const setInput = (name: string, raw: string, numeric: boolean): void => {
    setComputed(null);
    setAssignment((prev) => ({ ...prev, [name]: numeric ? Number(raw) : raw }));
  };

  const toggleBatch = (q: number, on: boolean): void =>
    setBatches((b) => (on ? [...new Set([...b, q])] : b.filter((x) => x !== q)));

  const compute = (): void => {
    if (!model) return;
    const { solutions, truncated } = enumerate(model, assignment, { resolved, cap: 200 });
    const useBatches = qtyParam && batches.length ? batches : null;
    const rows = solutions
      .filter((s) => !useBatches || useBatches.includes(Number(s[qtyParam!])))
      .map((s) => ({ assignment: s, ...evaluate(model, s) }));
    setComputed({ rows, truncated });
    setSelected(new Set());
  };

  const create = useMutation(orpc.quote.create.mutationOptions({ onSuccess: (q) => setQuoteId(q.id) }));
  const watch = useQuery(
    orpc.quote.watch.experimental_liveOptions({ input: quoteId ? { id: quoteId } : skipToken }),
  );

  // Optional per-model B1 push: shape each selected configuration's BOM into a document and POST it
  // through the existing entities.create path. ponytail: at-least-once via user retry (no dedup key
  // like the quote write); the exact ProductTrees shape needs tuning against a real B1 instance.
  const pushBom = useMutation({
    mutationFn: async () => {
      if (!model?.bomTarget || !computed) return [];
      const rows = [...selected].map((i) => computed.rows[i]!);
      const results: unknown[] = [];
      for (let k = 0; k < rows.length; k++) {
        const doc = buildPushDoc(model.bomTarget, rows[k]!.bom as unknown as Record<string, unknown>[], `${quoteId}-${k}`);
        results.push(await client.entities.create({ entity: model.bomTarget.entity, data: doc }));
      }
      return results;
    },
  });

  const submit = (): void => {
    if (!computed || !model) return;
    const chosen = [...selected].map((i) => computed.rows[i]!.assignment);
    create.mutate({
      payload: { name: model.name },
      config: { modelId, batches, configurations: chosen.map((a) => ({ assignment: a })) },
    });
  };

  const status = watch.data?.status;
  const shown = computed?.rows.slice(0, 50) ?? [];

  return (
    <div style={{ padding: "1rem", maxWidth: 900, margin: "0 auto", display: "flex", flexDirection: "column", gap: "1rem" }}>
      <Card header={<CardHeader titleText="Configure a product" subtitleText="Enter parameters → compare valid configurations → quote to SAP B1" />}>
        <FlexBox direction="Column" style={{ padding: "1rem", gap: "1rem" }}>
          <Label>Model</Label>
          <Select onChange={(e) => reset((e.detail.selectedOption as HTMLElement).dataset.value ?? "")}>
            <Option data-value="">— pick a model —</Option>
            {published.map((m) => (
              <Option key={m.id} data-value={m.id} selected={m.id === modelId}>{m.name}</Option>
            ))}
          </Select>
          {models.data && !published.length ? (
            <MessageStrip design="Information" hideCloseButton>No published models yet. An admin can create one under “Models”.</MessageStrip>
          ) : null}
          {modelQ.isFetching ? <BusyIndicator active delay={0} /> : null}
        </FlexBox>
      </Card>

      {model ? (
        <Card header={<CardHeader titleText="Parameters" subtitleText="Invalid options disappear as you choose" />}>
          <FlexBox direction="Column" style={{ padding: "1rem", gap: "0.75rem" }}>
            {resolvedQ.error ? (
              <MessageStrip design="Negative" hideCloseButton>{(resolvedQ.error as Error).message}</MessageStrip>
            ) : null}
            {finite.map((p) => {
              const opts = optionsFor(p.name);
              return (
                <FlexBox key={p.name} direction="Column" style={{ gap: "0.25rem" }}>
                  <Label>{p.label || p.name}</Label>
                  <Select onChange={(e) => pick(p.name, (e.detail.selectedOption as HTMLElement).dataset.value ?? "")}>
                    <Option data-value="">—</Option>
                    {opts.map((v) => (
                      <Option key={String(v)} data-value={String(v)} selected={assignment[p.name] === v}>{String(v)}</Option>
                    ))}
                  </Select>
                </FlexBox>
              );
            })}
            {inputs.map((p) => (
              <FlexBox key={p.name} direction="Column" style={{ gap: "0.25rem" }}>
                <Label>{p.label || p.name}</Label>
                <Input
                  type={p.type === "number" ? "Number" : "Text"}
                  value={assignment[p.name] == null ? "" : String(assignment[p.name])}
                  onInput={(e) => setInput(p.name, e.target.value, p.type === "number")}
                />
              </FlexBox>
            ))}

            {qtyParam ? (
              <FlexBox direction="Column" style={{ gap: "0.25rem" }}>
                <Label>Quantities to compare (price batches)</Label>
                <FlexBox style={{ gap: "1rem", flexWrap: "wrap" }}>
                  {qtyDomain.map((q) => (
                    <CheckBox key={String(q)} text={String(q)} checked={batches.includes(Number(q))} onChange={(e) => toggleBatch(Number(q), e.target.checked)} />
                  ))}
                </FlexBox>
              </FlexBox>
            ) : null}

            <Button design="Emphasized" onClick={compute}>Compute configurations</Button>
          </FlexBox>
        </Card>
      ) : null}

      {computed ? (
        <Card header={<CardHeader titleText={`${computed.rows.length} possible configuration(s)`} subtitleText="Select one or more to quote" />}>
          <FlexBox direction="Column" style={{ padding: "1rem", gap: "0.5rem" }}>
            {computed.truncated ? <MessageStrip design="Information" hideCloseButton>Showing the first 200 — narrow the parameters to see fewer.</MessageStrip> : null}
            {shown.map((r, i) => {
              const qty = qtyParam ? Number(r.assignment[qtyParam]) : 1;
              const summary = finite.map((p) => `${p.name}=${r.assignment[p.name]}`).join("  ");
              return (
                <FlexBox key={i} style={{ gap: "0.75rem", alignItems: "center", justifyContent: "space-between", borderBottom: "1px solid var(--sapList_BorderColor)", paddingBottom: "0.25rem" }}>
                  <CheckBox
                    checked={selected.has(i)}
                    onChange={(e) => setSelected((s) => { const n = new Set(s); if (e.target.checked) n.add(i); else n.delete(i); return n; })}
                  />
                  <Text style={{ flex: 1, fontFamily: "monospace", fontSize: "0.8rem" }}>{summary}</Text>
                  <Text style={{ minWidth: 160, textAlign: "right" }}>
                    {r.price.toFixed(2)} total · {(r.price / (qty || 1)).toFixed(2)}/pc
                  </Text>
                </FlexBox>
              );
            })}
            {create.error ? <MessageStrip design="Negative" hideCloseButton>{create.error.message}</MessageStrip> : null}
            <Button design="Emphasized" disabled={selected.size === 0 || create.isPending} onClick={submit}>
              {create.isPending ? "Creating…" : `Create quote from ${selected.size} configuration(s)`}
            </Button>
          </FlexBox>
        </Card>
      ) : null}

      {quoteId ? (
        <Card header={<CardHeader titleText="Quote sync" />}>
          <FlexBox direction="Column" style={{ padding: "1rem", gap: "0.5rem" }}>
            <Label>Quote {quoteId.slice(0, 8)}…</Label>
            <ObjectStatus state={status ? STATE[status] : "None"}>
              {status ?? "pending"}{watch.data?.docEntry ? ` · B1 ${watch.data.docEntry}` : ""}
            </ObjectStatus>
            {model?.bomTarget ? (
              <FlexBox direction="Column" style={{ gap: "0.5rem", marginTop: "0.5rem" }}>
                <Button disabled={pushBom.isPending || selected.size === 0} onClick={() => pushBom.mutate()}>
                  {pushBom.isPending ? "Creating BOM in B1…" : `Create BOM in B1 (${model.bomTarget.entity})`}
                </Button>
                {pushBom.error ? <MessageStrip design="Negative" hideCloseButton>{(pushBom.error as Error).message}</MessageStrip> : null}
                {pushBom.isSuccess ? <MessageStrip design="Positive" hideCloseButton>BOM document(s) created in B1.</MessageStrip> : null}
              </FlexBox>
            ) : null}
          </FlexBox>
        </Card>
      ) : null}

      {modelQ.error ? <MessageStrip design="Negative" hideCloseButton>{modelQ.error.message}</MessageStrip> : null}
    </div>
  );
}
