import { useEffect, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient, skipToken } from "@tanstack/react-query";
import {
  DynamicPage, DynamicPageTitle, Button, Input, Title, Text, Label, MessageStrip, BusyIndicator, FlexBox,
  Table, TableHeaderRow, TableHeaderCell, TableRow, TableCell, Toolbar, ToolbarButton,
} from "@ui5/webcomponents-react";
import { orpc } from "../orpc.ts";

type Row = { value: string; name: string };

// A user-defined lookup table: an ordered list of {value, name}. Order is the (hidden) Sort column —
// reorder by dragging a row. ponytail: native HTML5 row drag, no virtualization (pick lists are small).
export function TableEditor({ id }: { id: string }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const isNew = id === "new";

  const get = useQuery(orpc.tables.get.queryOptions({ input: isNew ? skipToken : { id } }));
  const [name, setName] = useState("New table");
  const [rows, setRows] = useState<Row[]>([]);
  const dragFrom = useRef<number | null>(null);

  useEffect(() => {
    if (!isNew && get.data) {
      setName(get.data.name);
      setRows(get.data.rows as Row[]);
    }
  }, [isNew, get.data]);

  const save = useMutation(
    orpc.tables.save.mutationOptions({
      onSuccess: (r) => {
        qc.invalidateQueries({ queryKey: orpc.tables.list.queryOptions().queryKey });
        if (isNew) navigate({ to: "/tables/$id", params: { id: r.id } });
      },
    }),
  );

  const setRow = (i: number, patch: Partial<Row>) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const addRow = () => setRows((rs) => [...rs, { value: "", name: "" }]);
  const removeRow = (i: number) => setRows((rs) => rs.filter((_, j) => j !== i));
  const onDrop = (to: number) => {
    const from = dragFrom.current;
    dragFrom.current = null;
    if (from == null || from === to) return;
    setRows((rs) => {
      const next = rs.slice();
      const [r] = next.splice(from, 1);
      next.splice(to, 0, r!);
      return next;
    });
  };

  if (!isNew && get.isPending) return <BusyIndicator active style={{ margin: "2rem" }} />;

  return (
    <DynamicPage
      hidePinButton
      titleArea={
        <DynamicPageTitle
          heading={<Title level="H4">Table</Title>}
          actionsBar={
            <Toolbar design="Transparent">
              <ToolbarButton icon="add" text="Add row" onClick={addRow} />
              <ToolbarButton
                design="Emphasized"
                text={save.isPending ? "Saving…" : "Save"}
                disabled={save.isPending || !name}
                onClick={() => save.mutate({ id: isNew ? undefined : id, name, rows })}
              />
            </Toolbar>
          }
        />
      }
    >
      <FlexBox direction="Column" style={{ gap: "1rem", padding: "0.5rem 0" }}>
        <FlexBox alignItems="Center" style={{ gap: "1rem" }}>
          <Label>Name</Label>
          <Input value={name} onInput={(e) => setName(e.target.value)} />
        </FlexBox>
        {save.error ? <MessageStrip design="Negative" hideCloseButton>{save.error.message}</MessageStrip> : null}

        <Table
          headerRow={
            <TableHeaderRow>
              <TableHeaderCell>Value</TableHeaderCell>
              <TableHeaderCell>Name</TableHeaderCell>
              <TableHeaderCell />
            </TableHeaderRow>
          }
          noDataText="No rows yet — use Add row"
        >
          {rows.map((r, i) => (
            <TableRow
              key={i}
              draggable
              onDragStart={() => (dragFrom.current = i)}
              onDragOver={(e) => e.preventDefault()}
              onDrop={() => onDrop(i)}
            >
              <TableCell>
                <FlexBox alignItems="Center" style={{ gap: "0.5rem" }}>
                  <Text style={{ cursor: "grab" }}>⠿</Text>
                  <Input value={r.value} onInput={(e) => setRow(i, { value: e.target.value })} />
                </FlexBox>
              </TableCell>
              <TableCell><Input value={r.name} onInput={(e) => setRow(i, { name: e.target.value })} /></TableCell>
              <TableCell><Button icon="delete" design="Transparent" onClick={() => removeRow(i)} /></TableCell>
            </TableRow>
          ))}
        </Table>
      </FlexBox>
    </DynamicPage>
  );
}
