import { useEffect, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient, skipToken } from "@tanstack/react-query";
import {
  ObjectPage, ObjectPageTitle, ObjectPageSection, Bar, Button, Input, Select, Option, Title, Text, Label,
  MessageStrip, BusyIndicator, FlexBox, Toolbar, ToolbarButton, ObjectStatus,
  Table, TableHeaderRow, TableHeaderCell, TableRow, TableCell,
} from "@ui5/webcomponents-react";
import { orpc, client } from "../orpc.ts";

type Value = string | number | boolean;
type Row = Record<string, Value>;
type Kind = "manual" | "query";

// Structural shape for the UI5 Table movable-row events (rows carry their index in data-i).
type MoveEvt = { preventDefault(): void; detail: { source: { element: HTMLElement }; destination: { element: HTMLElement; placement: string } } };
const idxOf = (el: HTMLElement) => Number(el.dataset.i);

// Move arr[from] to the drop slot relative to arr[to] (placement Before/After).
function reorder<T>(arr: T[], from: number, to: number, after: boolean): T[] {
  const next = arr.slice();
  const [x] = next.splice(from, 1);
  const insert = from < to ? (after ? to : to - 1) : after ? to + 1 : to;
  next.splice(insert, 0, x!);
  return next;
}
const onMoveOver = (e: MoveEvt) => e.preventDefault(); // accept every in-table drop
const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every((x) => b.includes(x));

// Configuration Master Data editor. One entity, defined manually (rows typed in) or by a B1 query.
// columns[0] is the key value; the runtime value-help shows every column, the type-ahead the first two.
export function MasterdataEditor({ id }: { id: string }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const isNew = id === "new";

  const get = useQuery(orpc.masterdata.get.queryOptions({ input: isNew ? skipToken : { id } }));

  const [name, setName] = useState("New master data");
  const [kind, setKind] = useState<Kind>("manual");
  const [columns, setColumns] = useState<string[]>(["key"]);
  const [rows, setRows] = useState<Row[]>([]);
  const [source, setSource] = useState("b1");
  const [path, setPath] = useState("");

  // Query test (live, also derives columns). Imperative via the raw client — same call the runtime uses.
  const [testing, setTesting] = useState(false);
  const [testErr, setTestErr] = useState<string | null>(null);
  const [preview, setPreview] = useState<Record<string, unknown>[] | null>(null);

  useEffect(() => {
    if (!isNew && get.data) {
      const d = get.data;
      setName(d.name);
      setKind(d.kind as Kind);
      setColumns((d.columns as string[]).length ? (d.columns as string[]) : ["key"]);
      setRows(d.rows as Row[]);
      setSource(d.source ?? "b1");
      setPath(d.path ?? "");
    }
  }, [isNew, get.data]);

  const save = useMutation(
    orpc.masterdata.save.mutationOptions({
      onSuccess: (r) => {
        qc.invalidateQueries({ queryKey: orpc.masterdata.list.queryOptions().queryKey });
        if (isNew) navigate({ to: "/masterdata/$id", params: { id: r.id } });
      },
    }),
  );

  const runTest = async () => {
    setTesting(true);
    setTestErr(null);
    try {
      const res = await client.configure.query({ source, path });
      setPreview(res.rows);
      const derived = Object.keys(res.rows[0] ?? {});
      // Adopt the query's shape, but keep the user's order when the column set is unchanged.
      if (derived.length) setColumns((cur) => (sameSet(cur, derived) ? cur : derived));
    } catch (e) {
      setTestErr((e as Error).message);
      setPreview(null);
    } finally {
      setTesting(false);
    }
  };

  // --- columns ---
  const uniqueCol = (cs: string[]) => { let n = cs.length + 1; while (cs.includes(`column${n}`)) n++; return `column${n}`; };
  const addColumn = () => setColumns((c) => [...c, uniqueCol(c)]);
  const removeColumn = (i: number) => {
    const gone = columns[i]!;
    setColumns(columns.filter((_, j) => j !== i));
    setRows(rows.map((r) => { const { [gone]: _drop, ...rest } = r; return rest; }));
  };
  const renameColumn = (i: number, to: string) => {
    const old = columns[i]!;
    if (to === old) return;
    setColumns(columns.map((x, j) => (j === i ? to : x)));
    setRows(rows.map((r) => { const { [old]: v, ...rest } = r; return v === undefined ? rest : { ...rest, [to]: v }; }));
  };
  const moveColumn = (e: MoveEvt) => setColumns((c) => reorder(c, idxOf(e.detail.source.element), idxOf(e.detail.destination.element), e.detail.destination.placement !== "Before"));

  // --- manual rows ---
  const addRow = () => setRows((rs) => [...rs, {}]);
  const removeRow = (i: number) => setRows((rs) => rs.filter((_, j) => j !== i));
  const setCell = (i: number, col: string, v: string) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, [col]: v } : r)));
  const moveRow = (e: MoveEvt) => setRows((rs) => reorder(rs, idxOf(e.detail.source.element), idxOf(e.detail.destination.element), e.detail.destination.placement !== "Before"));

  if (!isNew && get.isPending) return <BusyIndicator active style={{ margin: "2rem" }} />;

  const canSave = !!name && columns.length > 0 && (kind === "manual" || !!path);

  return (
    <ObjectPage
      mode="IconTabBar"
      hidePinButton
      titleArea={
        <ObjectPageTitle
          header={<Title level="H4">{name}</Title>}
          actionsBar={
            <Toolbar design="Transparent">
              <ToolbarButton
                design="Emphasized"
                text={save.isPending ? "Saving…" : "Save"}
                disabled={save.isPending || !canSave}
                onClick={() => save.mutate({ id: isNew ? undefined : id, name, kind, columns, rows: kind === "manual" ? rows : [], source, path })}
              />
            </Toolbar>
          }
        />
      }
    >
      <ObjectPageSection id="general" titleText="General">
        <FlexBox direction="Column" style={{ gap: "0.75rem", padding: "0.5rem 0", maxWidth: 480 }}>
          <Label>Name</Label>
          <Input value={name} onInput={(e) => setName(e.target.value)} />
          <Label>Defined by</Label>
          <Select value={kind} onChange={(e) => setKind((e.detail.selectedOption.value || "manual") as Kind)}>
            <Option value="manual">Manual rows</Option>
            <Option value="query">Query (B1)</Option>
          </Select>
          {save.error ? <MessageStrip design="Negative" hideCloseButton>{save.error.message}</MessageStrip> : null}
        </FlexBox>
      </ObjectPageSection>

      <ObjectPageSection id="columns" titleText="Columns">
        <FlexBox direction="Column" style={{ gap: "0.75rem", padding: "0.5rem 0" }}>
          <MessageStrip design="Information" hideCloseButton>
            The first column is the key. In a quote, the value help lists every column; the type-ahead shows the first two.
          </MessageStrip>
          <Table
            headerRow={<TableHeaderRow><TableHeaderCell>Column</TableHeaderCell><TableHeaderCell /><TableHeaderCell /></TableHeaderRow>}
            noDataText="No columns yet — add one"
            onMove={moveColumn}
            onMoveOver={onMoveOver}
          >
            {columns.map((c, i) => (
              <TableRow key={i} movable data-i={i}>
                <TableCell><Input value={c} onInput={(e) => renameColumn(i, e.target.value)} /></TableCell>
                <TableCell>{i === 0 ? <ObjectStatus state="Information">key</ObjectStatus> : null}</TableCell>
                <TableCell><Button icon="delete" design="Transparent" disabled={columns.length === 1} onClick={() => removeColumn(i)} /></TableCell>
              </TableRow>
            ))}
          </Table>
          <Button icon="add" design="Transparent" onClick={addColumn} style={{ alignSelf: "flex-start" }}>Add column</Button>
        </FlexBox>
      </ObjectPageSection>

      <ObjectPageSection id="data" titleText="Data">
        {kind === "manual" ? (
          <FlexBox direction="Column" style={{ gap: "0.75rem", padding: "0.5rem 0" }}>
            <Table
              headerRow={<TableHeaderRow>{columns.map((c) => <TableHeaderCell key={c}>{c}</TableHeaderCell>)}<TableHeaderCell /></TableHeaderRow>}
              noDataText="No rows yet — add one"
              onMove={moveRow}
              onMoveOver={onMoveOver}
            >
              {rows.map((r, i) => (
                <TableRow key={i} movable data-i={i}>
                  {columns.map((c) => (
                    <TableCell key={c}><Input value={String(r[c] ?? "")} onInput={(e) => setCell(i, c, e.target.value)} /></TableCell>
                  ))}
                  <TableCell><Button icon="delete" design="Transparent" onClick={() => removeRow(i)} /></TableCell>
                </TableRow>
              ))}
            </Table>
            <Button icon="add" design="Transparent" onClick={addRow} style={{ alignSelf: "flex-start" }}>Add row</Button>
          </FlexBox>
        ) : (
          <FlexBox direction="Column" style={{ gap: "0.6rem", padding: "0.5rem 0", maxWidth: 640 }}>
            <Label>Source</Label>
            <Input value={source} onInput={(e) => setSource(e.target.value)} />
            <Label>GET path (OData)</Label>
            <Input
              placeholder="/Items?$select=ItemCode,ItemName"
              value={path}
              valueState={testErr ? "Negative" : "None"}
              valueStateMessage={testErr ? <div>{testErr}</div> : undefined}
              onInput={(e) => { setPath(e.target.value); if (testErr) setTestErr(null); }}
            />
            <FlexBox style={{ gap: "0.5rem" }}>
              <Button onClick={runTest} disabled={testing || !path}>{testing ? "Testing…" : "Test"}</Button>
              {testErr ? <Button design="Transparent" icon="synchronize" onClick={runTest}>Retry</Button> : null}
            </FlexBox>
            {testErr ? <MessageStrip design="Negative" hideCloseButton>{testErr}</MessageStrip> : null}
            {preview ? (
              <>
                <Text style={{ opacity: 0.7 }}>{preview.length} row(s) — first column ({columns[0]}) is the key.</Text>
                <Table headerRow={<TableHeaderRow>{columns.map((c) => <TableHeaderCell key={c}>{c}</TableHeaderCell>)}</TableHeaderRow>} noDataText="No rows">
                  {preview.slice(0, 20).map((r, i) => (
                    <TableRow key={i}>
                      {columns.map((c) => <TableCell key={c}><Text maxLines={1}>{String((r as Record<string, unknown>)[c] ?? "")}</Text></TableCell>)}
                    </TableRow>
                  ))}
                </Table>
              </>
            ) : null}
          </FlexBox>
        )}
      </ObjectPageSection>
    </ObjectPage>
  );
}
