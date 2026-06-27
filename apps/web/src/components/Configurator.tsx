import { useMemo, useState, useEffect } from "react";
import { useQuery, useQueries, useMutation, skipToken } from "@tanstack/react-query";
import {
  ObjectPage, ObjectPageTitle, ObjectPageSection, Title, Text, Label, Button, Input, Select, Option, CheckBox,
  MessageStrip, BusyIndicator, FlexBox, ObjectStatus, Form, FormGroup, FormItem,
  Table, TableHeaderRow, TableHeaderCell, TableRow, TableCell,
  Icon, SelectDialog, ListItemStandard, SuggestionItem,
} from "@ui5/webcomponents-react";
import type { Model, EngineModel, Assignment, Value, DataSource, ParamDomain, FormItem as ModelItem } from "@hera/config-engine";
import { flatten, initialDomains, propagate, validate, enumerate, evaluate, priceBatches, buildScope, evalExpr, truthy } from "@hera/config-engine";
import { client, orpc } from "../orpc.ts";

const STATE: Record<string, "None" | "Information" | "Positive" | "Negative"> = {
  draft: "None", syncing: "Information", synced: "Positive", failed: "Negative",
};
const num = (s: string): Value => (s !== "" && !isNaN(Number(s)) ? Number(s) : s);
const parseQtys = (s: string): number[] => s.split(",").map((x) => Number(x.trim())).filter((n) => n > 0);

// Per-data-source fetch status, surfaced to its field (loading state / error valueState + message + retry).
type DsState = { loading: boolean; error: boolean; message?: string; retry: () => void };

// Resolve one Table/Query data source to its option values. Throws on failure (so the query goes to
// `error` and can be retried) — no swallowing, unlike the old single all-or-nothing resolve.
async function resolveSource(src: DataSource): Promise<Value[]> {
  if (src.kind === "table") {
    const t = await client.tables.get({ id: src.tableId });
    return (t.rows as { value: string }[]).map((r) => r.value);
  }
  if (src.kind === "query") {
    const res = await client.configure.query({ source: src.source, path: src.path });
    return res.rows.map((r) => r[src.valueField] as Value).filter((v) => v != null);
  }
  return [];
}

export function Configurator() {
  const models = useQuery(orpc.models.list.queryOptions());
  const published = (models.data ?? []).filter((m) => m.published);
  const [modelId, setModelId] = useState<string | null>(null);

  return (
    <FlexBox direction="Column" style={{ height: "100%" }}>
      <FlexBox alignItems="Center" style={{ gap: "1rem", padding: "0.75rem 1rem" }}>
        <Label>Model</Label>
        <Select value={modelId ?? ""} onChange={(e) => setModelId(e.detail.selectedOption.value || null)} style={{ minWidth: 260 }}>
          <Option value="">— pick a model —</Option>
          {published.map((m) => (
            <Option key={m.id} value={m.id}>{m.name}</Option>
          ))}
        </Select>
      </FlexBox>
      {published.length === 0 ? (
        <MessageStrip design="Information" hideCloseButton style={{ margin: "0 1rem" }}>No published models yet. Publish one from Models.</MessageStrip>
      ) : null}
      {modelId ? <RunModel key={modelId} modelId={modelId} /> : null}
    </FlexBox>
  );
}

// Thin fetch wrapper: load a saved model by id, then hand it to the runtime (quotes enabled).
function RunModel({ modelId }: { modelId: string }) {
  const get = useQuery(orpc.models.get.queryOptions({ input: { id: modelId } }));
  const model = get.data?.definition as unknown as Model | undefined;
  if (get.isPending) return <BusyIndicator active style={{ margin: "2rem" }} />;
  if (!model) return <MessageStrip design="Negative" hideCloseButton>Could not load model.</MessageStrip>;
  return <ModelRuntime model={model} modelId={modelId} allowCreate />;
}

// The live configurator runtime against a Model object (no fetch) — shared by the Configurator page
// and the Model Builder's live preview. `modelId` (when set) keys datasource resolution and lets
// quotes be created; omit it (preview of an unsaved model) for a read-only run.
export function ModelRuntime({ model, modelId, allowCreate, active = true }: {
  model: Model; modelId?: string; allowCreate?: boolean; active?: boolean;
}) {
  const em = useMemo<EngineModel>(() => flatten(model), [model]);
  const canCreate = !!allowCreate && !!modelId;

  // One query per Table/Query data source: per-field loading, error, and retry, with failures
  // surfaced (not swallowed). ponytail: filter-by-current-picks not applied yet. ponytail: the
  // queryKey includes the source, so a builder preview refetches as the OData path is typed —
  // debounce that field if agent calls get noisy. `active` gates the fetch so a hidden preview
  // pane never calls the agent.
  const dsParams = em.parameters.filter((p) => p.domain.kind === "datasource");
  const dsQueries = useQueries({
    queries: dsParams.map((p) => {
      const source = (p.domain as Extract<ParamDomain, { kind: "datasource" }>).source;
      return {
        queryKey: ["cfg-ds", modelId ?? "preview", p.name, source] as const,
        enabled: active,
        queryFn: () => resolveSource(source),
      };
    }),
  });
  const resolved: Record<string, Value[]> = {};
  const dsState: Record<string, DsState> = {};
  dsParams.forEach((p, i) => {
    const q = dsQueries[i]!;
    if (q.data) resolved[p.name] = q.data;
    dsState[p.name] = { loading: q.isFetching, error: q.isError, message: (q.error as Error | null)?.message, retry: () => void q.refetch() };
  });

  const [assignment, setAssignment] = useState<Assignment>({});
  const [batchesStr, setBatchesStr] = useState("");
  const [solutions, setSolutions] = useState<Assignment[] | null>(null);
  const [picked, setPicked] = useState<Record<number, boolean>>({});
  const [created, setCreated] = useState<string[]>([]);

  const createQuote = useMutation(orpc.quote.create.mutationOptions());

  const base = initialDomains(em, resolved);
  const pr = propagate(em, base, assignment);
  const domains = pr.ok ? pr.domains : base;
  const scope = buildScope(em, assignment);
  const visible = (expr?: string): boolean => {
    if (!expr) return true;
    try { return truthy(evalExpr(expr, scope)); } catch { return true; }
  };
  const valid = validate(em, assignment, resolved);
  const batches = parseQtys(batchesStr);

  const set = (name: string, v: Value | undefined) =>
    setAssignment((a) => { const next = { ...a }; if (v === undefined || v === "") delete next[name]; else next[name] = v; return next; });

  const find = () => {
    const r = enumerate(em, assignment, { resolved, cap: 200 });
    setSolutions(r.solutions);
    setPicked({});
  };

  const createSelected = async () => {
    if (!solutions || !modelId) return;
    const chosen = solutions.filter((_, i) => picked[i]);
    const ids: string[] = [];
    for (const cfg of chosen) {
      const q = await createQuote.mutateAsync({ config: { modelId, configuration: cfg, batches, resolved } });
      ids.push(q.id);
    }
    setCreated(ids);
  };

  // Each model section is a page section; groups -> FormGroup, fields -> FormItem.
  const inputSections = (model.sections ?? [])
    .filter((s) => visible(s.visibility))
    .map((s) => (
      <ObjectPageSection id={s.id} titleText={s.label} key={s.id}>
        <Form layout="S1 M1 L2 XL2" labelSpan="S12 M4 L4 XL4">
          {s.groups.filter((g) => visible(g.visibility)).map((g) => (
            <FormGroup key={g.id} headerText={g.label}>
              {g.items.filter((it) => visible(it.visibility)).map((it) => (
                <FormItem
                  key={it.id}
                  labelContent={<Label required={it.input.value.kind === "manual" && it.input.mandatory}>{it.label}</Label>}
                >
                  <Field item={it} domain={domains[it.name]} value={assignment[it.name]} derived={scope[it.name]} onChange={(v) => set(it.name, v)} dsState={dsState[it.name]} />
                </FormItem>
              ))}
            </FormGroup>
          ))}
        </Form>
      </ObjectPageSection>
    ));

  const priceSection = (
    <ObjectPageSection id="__price" titleText="Price" key="__price">
      {!pr.ok ? (
        <MessageStrip design="Critical" hideCloseButton style={{ marginBottom: "0.5rem" }}>
          Conflicting selection at “{pr.conflict}” — change it to continue.
        </MessageStrip>
      ) : null}
      {valid.ok ? (
        <Title level="H3">{evaluate(em, assignment).price}</Title>
      ) : (
        <Text style={{ opacity: 0.6 }}>Complete the required fields to price ({valid.reason}).</Text>
      )}
      <div style={{ marginTop: "0.75rem", maxWidth: 320 }}>
        <Label>Compare quantities (comma-separated)</Label>
        <Input placeholder="100, 500, 1000" value={batchesStr} onInput={(e) => setBatchesStr(e.target.value)} style={{ width: "100%" }} />
      </div>
      {valid.ok && batches.length ? (
        <Table style={{ marginTop: "0.5rem" }} headerRow={<TableHeaderRow><TableHeaderCell>Qty</TableHeaderCell><TableHeaderCell>Price</TableHeaderCell><TableHeaderCell>Per piece</TableHeaderCell></TableHeaderRow>}>
          {priceBatches(em, assignment, batches).map((b) => (
            <TableRow key={b.qty}><TableCell><Text>{b.qty}</Text></TableCell><TableCell><Text>{b.price}</Text></TableCell><TableCell><Text>{b.perPiece}</Text></TableCell></TableRow>
          ))}
        </Table>
      ) : null}
    </ObjectPageSection>
  );

  const configSection = (
    <ObjectPageSection id="__configs" titleText="Configurations" key="__configs">
      <FlexBox style={{ gap: "0.5rem", marginBottom: "0.75rem" }}>
        <Button design="Emphasized" onClick={find}>Find configurations</Button>
        {canCreate && solutions && solutions.some((_, i) => picked[i]) ? (
          <Button onClick={createSelected} disabled={createQuote.isPending}>
            {createQuote.isPending ? "Creating…" : "Create quote(s)"}
          </Button>
        ) : null}
      </FlexBox>
      {solutions ? <Solutions em={em} solutions={solutions} picked={picked} setPicked={setPicked} /> : null}
      {canCreate && created.length ? (
        <FlexBox direction="Column" style={{ gap: "0.4rem", marginTop: "1rem" }}>
          <Title level="H5">Created quotes</Title>
          {created.map((id) => <QuoteStatus key={id} id={id} />)}
        </FlexBox>
      ) : null}
    </ObjectPageSection>
  );

  return (
    <ObjectPage titleArea={<ObjectPageTitle header={model.name} subHeader={model.family} />}>
      {[...inputSections, priceSection, configSection]}
    </ObjectPage>
  );
}

// Renders a single field's control (the label is supplied by the enclosing FormItem).
function Field({ item, domain, value, derived, onChange, dsState }: {
  item: ModelItem; domain?: Value[]; value: Value | undefined; derived: unknown;
  onChange: (v: Value | undefined) => void; dsState?: DsState;
}) {
  if (item.input.value.kind === "formula") return <Text>{derived == null ? "—" : String(derived)}</Text>;

  const t = item.input.inputType;
  if (t === "checkbox") return <CheckBox checked={value === true} onChange={(e) => onChange(e.target.checked)} />;
  // Table/Query data source -> value help (F4): pick from a searchable dialog, not a long dropdown.
  // (multicombo rides as a free value — no single-pick value help.)
  const ds = item.input.dataSource;
  if ((ds.kind === "table" || ds.kind === "query") && t !== "multicombo") {
    return <ValueHelp label={item.label} domain={domain ?? []} value={value} onChange={onChange} state={dsState} />;
  }
  if (domain && domain.length) {
    return (
      <Select value={value === undefined ? "" : String(value)} onChange={(e) => onChange(coerce(e.detail.selectedOption.value))}>
        <Option value="">—</Option>
        {domain.map((v) => (
          <Option key={String(v)} value={String(v)}>{String(v)}</Option>
        ))}
      </Select>
    );
  }
  return <Input value={value === undefined ? "" : String(value)} onInput={(e) => onChange(e.target.value === "" ? undefined : num(e.target.value))} />;
}

// SAP value help (F4): a typable Input that searches its options inline as you type (SuggestionItem)
// AND a value-help icon that opens the same options in a SelectDialog for full browse. Used for
// Table/Query data sources. `state` surfaces the per-source fetch: a BusyIndicator overlay while
// loading; on failure a Negative valueState carrying the query's own error message + a retry icon.
// The Input carries no width override, so it sizes like the plain inputs; the wrapper is display:block
// (UI5 requires it when wrapping) and is layout-transparent.
// ponytail: shows the raw value as label; wire labelField -> {text/additionalText} here when display-vs-value lands.
function ValueHelp({ label, domain, value, onChange, state }: {
  label: string; domain: Value[]; value: Value | undefined; onChange: (v: Value | undefined) => void; state?: DsState;
}) {
  const [open, setOpen] = useState(false);
  const committed = value === undefined ? "" : String(value);
  const [text, setText] = useState(committed);
  // Re-sync the typed text when the committed value changes from outside (dialog pick, clear, propagation).
  useEffect(() => { setText(committed); }, [committed]);

  const inDomain = (s: string) => domain.some((v) => String(v) === s);
  // Live-commit only real option values — a picked suggestion or an exact typed match; plain searching does not.
  const live = (s: string) => { setText(s); if (s === "") onChange(undefined); else if (inDomain(s)) onChange(coerce(s)); };

  const icon = state?.error ? (
    <Icon name="synchronize" mode="Interactive" accessibleName={`Retry loading ${label}`} onClick={() => state.retry()} />
  ) : (
    <Icon name="value-help" mode="Interactive" accessibleName={`Choose ${label}`} onClick={() => setOpen(true)} />
  );
  return (
    <>
      <BusyIndicator active={!!state?.loading} style={{ display: "block" }}>
        <Input
          showSuggestions
          showClearIcon
          filter="Contains"
          value={text}
          placeholder={state?.error ? "Couldn’t load — retry" : "Type to search…"}
          valueState={state?.error ? "Negative" : "None"}
          valueStateMessage={state?.error ? <div>{state.message ?? "Couldn’t load options."}</div> : undefined}
          icon={icon}
          onInput={(e) => live(e.target.value)}
          onChange={(e) => { const s = e.target.value; if (s !== "" && !inDomain(s)) setText(committed); }} // reject dangling free text on blur
        >
          {domain.map((v) => <SuggestionItem key={String(v)} text={String(v)} />)}
        </Input>
      </BusyIndicator>
      <SelectDialog
        open={open}
        headerText={label}
        showClearButton
        onConfirm={(e) => { onChange(coerce((e.detail.selectedItems[0] as unknown as HTMLElement | undefined)?.dataset.value)); setOpen(false); }}
        onClear={() => { onChange(undefined); setOpen(false); }}
        onCancel={() => setOpen(false)}
      >
        {domain.map((v) => (
          <ListItemStandard key={String(v)} data-value={String(v)} text={String(v)} selected={String(v) === committed} />
        ))}
      </SelectDialog>
    </>
  );
}

// Selected option values are strings; coerce back to number where the value is numeric.
const coerce = (k?: string): Value | undefined => (k === undefined || k === "" ? undefined : num(k));

function Solutions({ em, solutions, picked, setPicked }: {
  em: EngineModel; solutions: Assignment[]; picked: Record<number, boolean>; setPicked: (p: Record<number, boolean>) => void;
}) {
  const cols = em.parameters.filter((p) => p.domain.kind === "static" || p.domain.kind === "datasource").map((p) => p.name);
  if (!solutions.length) return <MessageStrip design="Information" hideCloseButton>No valid configurations for the current inputs.</MessageStrip>;
  return (
    <Table
      headerRow={
        <TableHeaderRow>
          <TableHeaderCell />
          {cols.map((c) => <TableHeaderCell key={c}>{c}</TableHeaderCell>)}
          <TableHeaderCell>Price</TableHeaderCell>
        </TableHeaderRow>
      }
    >
      {solutions.slice(0, 200).map((s, i) => (
        <TableRow key={i}>
          <TableCell><CheckBox checked={!!picked[i]} onChange={(e) => setPicked({ ...picked, [i]: e.target.checked })} /></TableCell>
          {cols.map((c) => <TableCell key={c}><Text>{String(s[c] ?? "")}</Text></TableCell>)}
          <TableCell><Text>{evaluate(em, s).price}</Text></TableCell>
        </TableRow>
      ))}
    </Table>
  );
}

function QuoteStatus({ id }: { id: string }) {
  const watch = useQuery(orpc.quote.watch.experimental_liveOptions({ input: id ? { id } : skipToken }));
  const status = watch.data?.status;
  return (
    <ObjectStatus state={status ? STATE[status] : "None"}>
      {id.slice(0, 8)}… · {status ?? "pending"}{watch.data?.docEntry ? ` · B1 ${watch.data.docEntry}` : ""}
    </ObjectStatus>
  );
}
