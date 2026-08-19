import { useEffect, useState } from "react";
import {
  Bar,
  Button,
  CheckBox,
  Dialog,
  Input,
  Label,
  Table,
  TableCell,
  TableHeaderCell,
  TableHeaderRow,
  TableRow,
} from "@ui5/webcomponents-react";
import {
  confirmFieldPicker,
  moveFieldPickerItem,
  openFieldPickerDraft,
  type FieldDef,
  type FieldPickerItem,
} from "./objectVariantLogic.ts";

export type FieldPickerProps = {
  open: boolean;
  title?: string;
  fields: FieldDef[];
  available: { name: string; label?: string }[];
  onClose: () => void;
  /** Apply only on Confirm — parent updates draft definition. */
  onConfirm: (fields: FieldDef[]) => void;
};

/** Checkbox visibility, drag reorder, label override, numeric width, Reset to Auto/Fit. */
export function FieldPicker({ open, title = "Fields", fields, available, onClose, onConfirm }: FieldPickerProps) {
  const [draft, setDraft] = useState<FieldPickerItem[] | null>(null);

  useEffect(() => {
    if (open) setDraft(openFieldPickerDraft(fields, available));
    else setDraft(null);
  }, [open, fields, available]);

  const close = () => {
    setDraft(null);
    onClose();
  };

  const confirm = () => {
    if (!draft) return close();
    onConfirm(confirmFieldPicker(draft));
    close();
  };

  return (
    <Dialog
      open={open}
      onClose={close}
      headerText={title}
      style={{ width: 640 }}
      footer={
        <Bar
          endContent={
            <>
              <Button design="Emphasized" onClick={confirm}>Confirm</Button>
              <Button design="Transparent" onClick={close}>Cancel</Button>
            </>
          }
        />
      }
    >
      {draft ? (
        <Table
          headerRow={
            <TableHeaderRow>
              <TableHeaderCell width="3rem">Visible</TableHeaderCell>
              <TableHeaderCell>Label</TableHeaderCell>
              <TableHeaderCell width="8rem">Width (px)</TableHeaderCell>
              <TableHeaderCell width="7rem" />
            </TableHeaderRow>
          }
          onMoveOver={(e) => e.preventDefault()}
          onMove={(e) => {
            const src = (e.detail.source.element as unknown as { rowKey?: string } | null)?.rowKey;
            const dst = (e.detail.destination.element as unknown as { rowKey?: string } | null)?.rowKey;
            if (!src || !dst || src === dst) return;
            const placement = e.detail.destination.placement === "After" ? "After" : "Before";
            setDraft((cur) => (cur ? moveFieldPickerItem(cur, src, dst, placement) : cur));
          }}
        >
          {draft.map((d) => (
            <TableRow key={d.name} rowKey={d.name} movable>
              <TableCell>
                <CheckBox
                  checked={d.visible}
                  onChange={() =>
                    setDraft((cur) => cur!.map((x) => (x.name === d.name ? { ...x, visible: !x.visible } : x)))
                  }
                />
              </TableCell>
              <TableCell>
                <Input
                  value={d.label}
                  onInput={(e) => {
                    const v = e.target.value;
                    setDraft((cur) => cur!.map((x) => (x.name === d.name ? { ...x, label: v } : x)));
                  }}
                />
              </TableCell>
              <TableCell>
                <Input
                  type="Number"
                  placeholder="Auto"
                  value={d.width != null ? String(d.width) : ""}
                  onInput={(e) => {
                    const raw = e.target.value.trim();
                    const n = raw === "" ? undefined : Number(raw);
                    setDraft((cur) =>
                      cur!.map((x) =>
                        x.name === d.name
                          ? { ...x, width: n != null && Number.isFinite(n) && n > 0 ? n : undefined }
                          : x,
                      ),
                    );
                  }}
                />
              </TableCell>
              <TableCell>
                <Button
                  design="Transparent"
                  disabled={d.width == null}
                  onClick={() =>
                    setDraft((cur) => cur!.map((x) => (x.name === d.name ? { ...x, width: undefined } : x)))
                  }
                >
                  Reset to Auto
                </Button>
              </TableCell>
            </TableRow>
          ))}
        </Table>
      ) : (
        <Label>No fields.</Label>
      )}
    </Dialog>
  );
}
