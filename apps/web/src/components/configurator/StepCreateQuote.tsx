import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Button, BusyIndicator, DatePicker, Form, FormGroup, FormItem, Label, MessageStrip,
  Table, TableCell, TableHeaderCell, TableHeaderRow, TableRow, Text, TextArea, Title,
} from "@ui5/webcomponents-react";
import { orpc } from "../../orpc.ts";

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
            <TableHeaderCell><span>Item</span></TableHeaderCell>
            <TableHeaderCell><span>Description</span></TableHeaderCell>
            <TableHeaderCell><span>Qty</span></TableHeaderCell>
            <TableHeaderCell><span>Unit price</span></TableHeaderCell>
          </TableHeaderRow>
        }>
        {lines.map((l, i) => (
          <TableRow key={i} rowKey={`q-${i}`}>
            <TableCell><Text>{String(l.ItemCode ?? "")}</Text></TableCell>
            <TableCell><Text>{String(l.ItemDescription ?? "")}</Text></TableCell>
            <TableCell><Text>{String(l.Quantity ?? "")}</Text></TableCell>
            <TableCell><Text>{money(l.UnitPrice, currency)}</Text></TableCell>
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
            projectId, runId: d.runId, commandId: d.commandId,
            ...(comments.trim() ? { comments: comments.trim() } : {}),
            ...(/^\d{4}-\d{2}-\d{2}$/.test(docDueDate) ? { docDueDate } : {}),
          })}>
          {create.isPending ? "Creating in SAP…" : "Create quotation in SAP"}
        </Button>
      </div>
    </div>
  );
}
