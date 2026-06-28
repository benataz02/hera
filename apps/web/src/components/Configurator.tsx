import { useMemo, useState, useEffect } from "react";
import { createPortal } from "react-dom";
import "./Configurator.css";
import { useQuery, useQueries, useMutation, skipToken } from "@tanstack/react-query";
import {
  ObjectPage, ObjectPageTitle, ObjectPageSection, Title, Text, Label, Button, Input, Select, Option, CheckBox,
  MessageStrip, BusyIndicator, FlexBox, ObjectStatus, Form, FormGroup, FormItem,
  Table, TableHeaderRow, TableHeaderCell, TableRow, TableCell,
  Icon, Dialog, SelectDialog, Bar, SuggestionItem,
} from "@ui5/webcomponents-react";
import type { Model, EngineModel, Assignment, Value, ParamDomain, FormItem as ModelItem } from "@hera/config-engine";
import { flatten, initialDomains, propagate, validate, enumerate, evaluate, priceBatches, buildScope, evalExpr, truthy } from "@hera/config-engine";
import { client, orpc } from "../orpc.ts";

const STATE: Record<string, "None" | "Information" | "Positive" | "Negative"> = {
  draft: "None", syncing: "Information", synced: "Positive", failed: "Negative",
};
// ponytail: free-text inputs (no domain) coerce numeric strings to numbers by design — price formulas
// need real numbers. Master-data picks do NOT use this; they reverse-lookup via fromDomain (lossless).
const num = (s: string): Value => (s !== "" && !isNaN(Number(s)) ? Number(s) : s);
// Map a stringified option back to its original typed domain value — preserves number-vs-string
// (item codes like "007" stay strings) instead of guessing with Number(). The engine strict-compares.
const fromDomain = (domain: Value[], s: string | undefined): Value | undefined =>
  s === undefined || s === "" ? undefined : domain.find((v) => String(v) === s);
const parseQtys = (s: string): number[] => s.split(",").map((x) => Number(x.trim())).filter((n) => n > 0);

// Per-data-source fetch status, surfaced to its field (loading state / error valueState + message + retry).
type DsState = { loading: boolean; error: boolean; message?: string; retry: () => void };

// A resolved master-data source: its defined columns + rows (the key is columns[0]).
type MdData = { columns: string[]; rows: Record<string, Value>[] };

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

  // One query per master-data data source: per-field loading, error, and retry, with failures surfaced
  // (not swallowed). Cached with staleTime: Infinity — a master data (incl. a B1 query) is fetched once
  // per session and reused; the retry icon is the only manual refresh. `active` gates the fetch so a
  // hidden preview pane never calls the agent. ponytail: filter-by-current-picks not applied yet.
  const dsParams = em.parameters.filter((p) => p.domain.kind === "datasource");
  const dsQueries = useQueries({
    queries: dsParams.map((p) => {
      const source = (p.domain as Extract<ParamDomain, { kind: "datasource" }>).source;
      const mdId = source.kind === "masterdata" ? source.masterdataId : "";
      return {
        queryKey: ["cfg-md", mdId] as const,
        enabled: active && !!mdId,
        staleTime: Infinity,
        gcTime: Infinity,
        queryFn: (): Promise<MdData> => client.masterdata.resolve({ id: mdId }),
      };
    }),
  });
  // resolved[name] = the key-column values (engine contract: Value[]); mdByParam[name] = full rows for display.
  const resolved: Record<string, Value[]> = {};
  const mdByParam: Record<string, MdData> = {};
  const dsState: Record<string, DsState> = {};
  dsParams.forEach((p, i) => {
    const q = dsQueries[i]!;
    if (q.data) {
      mdByParam[p.name] = q.data;
      const key = q.data.columns[0];
      resolved[p.name] = key ? q.data.rows.map((r) => r[key]!).filter((v) => v != null) : [];
    }
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
  // Options each finite field may be CHANGED to: its domain computed WITHOUT its own current pick (so an
  // already-chosen field still offers alternatives) but WITH every other field's — cross-field rules
  // still narrow. propagate() pins an assigned field to a singleton, which would otherwise collapse the
  // field's own picker/value-help to just the value already chosen.
  const optionDomains: Record<string, Value[]> = {};
  for (const p of em.parameters) {
    if (!(p.name in base)) continue;
    const others = { ...assignment };
    delete others[p.name];
    const r = propagate(em, base, others);
    optionDomains[p.name] = (r.ok ? r.domains[p.name] : undefined) ?? base[p.name]!;
  }
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
                  <Field item={it} domain={optionDomains[it.name]} value={assignment[it.name]} derived={scope[it.name]} onChange={(v) => set(it.name, v)} dsState={dsState[it.name]} md={mdByParam[it.name]} />
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
function Field({ item, domain, value, derived, onChange, dsState, md }: {
  item: ModelItem; domain?: Value[]; value: Value | undefined; derived: unknown;
  onChange: (v: Value | undefined) => void; dsState?: DsState; md?: MdData;
}) {
  if (item.input.value.kind === "formula") return <Text>{derived == null ? "—" : String(derived)}</Text>;

  const t = item.input.inputType;
  if (t === "checkbox") return <CheckBox checked={value === true} onChange={(e) => onChange(e.target.checked)} />;
  // Master-data source -> value help (F4): pick from a searchable dialog showing every column.
  // (multicombo rides as a free value — no single-pick value help.)
  const ds = item.input.dataSource;
  if (ds.kind === "masterdata" && t !== "multicombo") {
    return <ValueHelp label={item.label} columns={md?.columns ?? []} rows={md?.rows ?? []} domain={domain ?? []} value={value} onChange={onChange} state={dsState} />;
  }
  if (domain && domain.length) {
    return (
      <Select value={value === undefined ? "" : String(value)} onChange={(e) => onChange(fromDomain(domain, e.detail.selectedOption.value))}>
        <Option value="">—</Option>
        {domain.map((v) => (
          <Option key={String(v)} value={String(v)}>{String(v)}</Option>
        ))}
      </Select>
    );
  }
  return <Input value={value === undefined ? "" : String(value)} onInput={(e) => onChange(e.target.value === "" ? undefined : num(e.target.value))} />;
}

// SAP value help (F4) for a master-data source: a typable Input that searches the key column inline
// (the SuggestionItem shows the key + second column) AND a value-help icon that opens a Dialog with its
// own search box + a multi-column Table (headers = the source's columns); clicking a row commits its
// key. Driven by the resolved rows; `domain` is the set of keys this field may take given the OTHER
// fields (its own pick is excluded upstream, so a chosen field still lists alternatives). `state`
// surfaces the per-source fetch: a loading placeholder; on failure a Negative valueState + retry.
// The Dialog is portalled to <body> so it isn't a second field in the FormItem (which would stop the
// FormItem stretching the Input to full width).
// ponytail: inline typeahead filters on the key column only; the dialog search filters every column.
function ValueHelp({ label, columns, rows, domain, value, onChange, state }: {
  label: string; columns: string[]; rows: Record<string, Value>[];
  domain: Value[]; value: Value | undefined; onChange: (v: Value | undefined) => void; state?: DsState;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const committed = value === undefined ? "" : String(value);
  const [text, setText] = useState(committed);
  // Re-sync the typed text when the committed value changes from outside (dialog pick, clear, propagation).
  useEffect(() => { setText(committed); }, [committed]);

  const key = columns[0];
  // Only rows whose key is still a valid pick (propagation may have narrowed the domain).
  const allowed = new Set(domain.map(String));
  const optionRows = key ? rows.filter((r) => allowed.has(String(r[key]))) : [];
  // Commit a picked key string back to its original typed domain value (lossless — no Number() guess).
  const commit = (s: string | undefined) => onChange(fromDomain(domain, s));

  // Live-commit only real option values — a picked suggestion or an exact typed match; plain searching does not.
  const live = (s: string) => { setText(s); if (s === "") onChange(undefined); else if (allowed.has(s)) commit(s); };

  // Dialog rows filtered by the dialog's own search box (contains, across every column).
  const q = query.trim().toLowerCase();
  const dialogRows = q ? optionRows.filter((r) => columns.some((c) => String(r[c] ?? "").toLowerCase().includes(q))) : optionRows;

  const icon = state?.error ? (
    <Icon name="synchronize" mode="Interactive" accessibleName={`Retry loading ${label}`} onClick={() => state.retry()} />
  ) : (
    <Icon name="value-help" mode="Interactive" accessibleName={`Choose ${label}`} onClick={() => { setQuery(""); setOpen(true); }} />
  );
  return (
    <>
      <BusyIndicator className="vh-busy" active={!!state?.loading}>
        <Input
          showSuggestions
          showClearIcon
          filter="Contains"
          value={text}
          placeholder={state?.loading ? undefined : state?.error ? "Couldn’t load — retry" : "Type to search…"}
          valueState={state?.error ? "Negative" : "None"}
          valueStateMessage={state?.error ? <div>{state.message ?? "Couldn’t load options."}</div> : undefined}
          icon={icon}
          onInput={(e) => live(e.target.value)}
          onChange={(e) => { const s = e.target.value; if (s !== "" && !allowed.has(s)) setText(committed); }} // reject dangling free text on blur
        >
          {optionRows.map((r) => (
            <SuggestionItem key={String(r[key!])} text={String(r[key!])} additionalText={columns[1] ? String(r[columns[1]] ?? "") : undefined} />
          ))}
        </Input>
      </BusyIndicator>

      {createPortal(
        <SelectDialog
          open={open}
          headerText={label}
          className="vh-dialog"
          searchPlaceholder={`Search ${label}…`}
          onSearchInput={(e) => setQuery(e.detail.value)}
          onSearchReset={() => setQuery("")}
          onClose={() => setOpen(false)}
        >
          <Table
            className="vh-table"
            headerRow={<TableHeaderRow>{columns.map((c) => <TableHeaderCell key={c}>{c}</TableHeaderCell>)}</TableHeaderRow>}
            onRowClick={(e) => { commit(e.detail.row.rowKey); setOpen(false); }}
          >
            {dialogRows.map((r) => (
              <TableRow key={String(r[key!])} rowKey={String(r[key!])} interactive>
                {columns.map((c) => <TableCell key={c}><Text>{String(r[c] ?? "")}</Text></TableCell>)}
              </TableRow>
            ))}
          </Table>
        </SelectDialog>,
        document.body,
      )}
    </>
  );
}

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
