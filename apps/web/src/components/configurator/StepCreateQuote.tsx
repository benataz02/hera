import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Button, BusyIndicator, DatePicker, Form, FormGroup, FormItem, Label, MessageStrip,
  Table, TableCell, TableHeaderCell, TableHeaderRow, TableRow, Text, TextArea, Title,
} from "@ui5/webcomponents-react";
import { orpc } from "../../orpc.ts";

const STANDARD: Record<string, string> = {
  ItemCode: "Item", ItemDescription: "Description", Quantity: "Qty", UnitPrice: "Unit price",
};

const money = (n: unknown, currency?: string) =>
  typeof n === "number"
    ? n.toLocaleString(undefined, { style: "currency", currency: currency || "EUR" })
    : String(n ?? "");

// The last step: post the calculated selection to SAP as a Quotations document. The payload is
// recomputed on the server from the persisted run — this shows it, it does not build it. The
// commandId comes with the draft and goes back with the post, so a retry (or a stale tab) can
// never create a second quotation.
export function StepCreateQuote({ projectId }: { projectId: string }) {
  const qc = useQueryClient();
  const draft = useQuery({ ...orpc.configs.quoteDraft.queryOptions({ input: { projectId } }), retry: false });
  const [comments, setComments] = useState("");
  const [docDueDate, setDocDueDate] = useState("");

  const create = useMutation(orpc.configs.createQuote.mutationOptions({
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: orpc.configs.get.queryOptions({ input: { id: projectId } }).queryKey });
      void draft.refetch();
    },
  }));

  if (draft.isPending) return <BusyIndicator active delay={0} />;
  if (draft.error) return <MessageStrip design="Negative" hideCloseButton>{draft.error.message}</MessageStrip>;

  const d = draft.data!;
  const lines = (d.data.DocumentLines ?? []) as Record<string, unknown>[];
  const currency = d.data.DocCurrency as string | undefined;
  // An items table maps its own columns onto DocumentLine fields, so the columns are the model's
  // to choose. Standard four pinned in reading order; anything mapped follows under its B1 name.
  const extra = [...new Set(lines.flatMap((l) => Object.keys(l)))].filter((k) => !(k in STANDARD));
  const cols = [...Object.keys(STANDARD), ...extra];

  if (d.quoted) {
    return (
      <MessageStrip design="Positive" hideCloseButton>
        {`Quotation created in SAP (DocEntry ${d.quoted.docEntry}).`}
      </MessageStrip>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
      <Title level="H4">{`Quotation for ${String(d.data.CardName ?? d.data.CardCode ?? "")}`}</Title>

      <Table
        headerRow={
          <TableHeaderRow>
            {cols.map((k) => (
              <TableHeaderCell key={k}><span>{STANDARD[k] ?? k}</span></TableHeaderCell>
            ))}
            <TableHeaderCell><span>Line total</span></TableHeaderCell>
          </TableHeaderRow>
        }>
        {lines.map((l, i) => (
          <TableRow key={i} rowKey={`q-${i}`}>
            {cols.map((k) => (
              <TableCell key={k}>
                <Text>{k === "UnitPrice" ? money(l[k], currency) : String(l[k] ?? "")}</Text>
              </TableCell>
            ))}
            {/* shown because with a split the reconciliation is the point: these have to add up */}
            <TableCell>
              <Text>{money(Number(l.Quantity) * Number(l.UnitPrice), currency)}</Text>
            </TableCell>
          </TableRow>
        ))}
      </Table>

      <Text>{`Total ${money(d.totals.value, currency)}`}</Text>

      <Form>
        <FormGroup>
          <FormItem labelContent={<Label>Comments</Label>}>
            <TextArea growing rows={2} value={comments} onInput={(e) => setComments(e.target.value)} />
          </FormItem>
          <FormItem labelContent={<Label>Valid until</Label>}>
            <DatePicker formatPattern="yyyy-MM-dd" value={docDueDate}
              onChange={(e) => setDocDueDate(e.target.value ?? "")} />
          </FormItem>
        </FormGroup>
      </Form>

      {create.error ? <MessageStrip design="Negative" hideCloseButton>{create.error.message}</MessageStrip> : null}

      <div>
        <Button design="Emphasized" disabled={create.isPending || !lines.length}
          onClick={() => create.mutate({
            projectId, commandId: d.commandId,
            ...(comments.trim() ? { comments: comments.trim() } : {}),
            ...(/^\d{4}-\d{2}-\d{2}$/.test(docDueDate) ? { docDueDate } : {}),
          })}>
          {create.isPending ? "Creating in SAP…" : "Create quotation in SAP"}
        </Button>
      </div>
    </div>
  );
}
