import { useId, useState } from "react";
import { createPortal } from "react-dom";
import {
  Bar,
  Button,
  CheckBox,
  Dialog,
  Input,
  Label,
  List,
  ListItemStandard,
  MessageStrip,
  ResponsivePopover,
  Table,
  TableCell,
  TableHeaderCell,
  TableHeaderRow,
  TableRow,
  ToolbarButton,
} from "@ui5/webcomponents-react";
import type { ObjectVariants } from "../variants.ts";
import {
  canDeleteVariant,
  canRenameVariant,
  canSetDefault,
  canSetShared,
  variantStatusLabel,
} from "./objectVariantLogic.ts";

export type ObjectVariantPopoverProps = {
  ov: ObjectVariants;
};

/**
 * Custom object-page view switcher (no UI5 VariantManagement).
 * Stable opener id + ResponsivePopover; List single-selection; Save / Save As / Manage.
 * Overlays portal to document.body so the ToolbarButton can nest inside ObjectPageTitle's Toolbar.
 */
export function ObjectVariantPopover({ ov }: ObjectVariantPopoverProps) {
  const openerId = useId().replace(/:/g, "");
  const openerDomId = `object-variant-opener-${openerId}`;
  const [open, setOpen] = useState(false);
  const [saveAsOpen, setSaveAsOpen] = useState(false);
  const [manageOpen, setManageOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [asName, setAsName] = useState("");
  const [asShared, setAsShared] = useState(false);
  const [asDefault, setAsDefault] = useState(false);

  // Manage dialog drafts keyed by id
  const [names, setNames] = useState<Record<string, string>>({});
  const [defaults, setDefaults] = useState<Record<string, boolean>>({});
  const [shareds, setShareds] = useState<Record<string, boolean>>({});
  const [deleted, setDeleted] = useState<Set<string>>(new Set());

  const selected = ov.variants.find((v) => v.id === ov.selectedId);
  const buttonText = selected ? `${selected.name}${ov.dirty ? " *" : ""}` : "Views";

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const openManage = () => {
    setNames(Object.fromEntries(ov.variants.map((v) => [v.id, v.name])));
    setDefaults(Object.fromEntries(ov.variants.map((v) => [v.id, v.isDefault])));
    setShareds(Object.fromEntries(ov.variants.map((v) => [v.id, v.shared])));
    setDeleted(new Set());
    setError(null);
    setManageOpen(true);
    setOpen(false);
  };

  const openSaveAs = () => {
    setAsName(selected ? `${selected.name} copy` : "My view");
    setAsShared(false);
    setAsDefault(false);
    setError(null);
    setSaveAsOpen(true);
    setOpen(false);
  };

  const applyManage = () =>
    run(async () => {
      for (const id of deleted) {
        await ov.remove(id);
      }
      for (const v of ov.variants) {
        if (deleted.has(v.id)) continue;
        const name = (names[v.id] ?? v.name).trim();
        if (canRenameVariant(v) && name !== v.name) await ov.rename(v.id, name);
        const nextShared = shareds[v.id] ?? v.shared;
        if (canSetShared(v, ov.isAdmin) && nextShared !== v.shared) await ov.setShared(v.id, nextShared);
        const nextDefault = defaults[v.id] ?? v.isDefault;
        if (canSetDefault(v) && nextDefault !== v.isDefault) await ov.setDefault(v.id, nextDefault);
      }
      setManageOpen(false);
    });

  const overlays = (
    <>
      <ResponsivePopover
        open={open}
        opener={openerDomId}
        placement="Bottom"
        headerText="Views"
        onClose={() => setOpen(false)}
        style={{ width: "20rem" }}
        footer={
          <Bar
            startContent={
              <>
                <Button
                  design="Emphasized"
                  disabled={!ov.dirty || !selected?.canManage || busy}
                  onClick={() => run(async () => { await ov.save(ov.definition); setOpen(false); })}
                >
                  Save
                </Button>
                <Button design="Transparent" disabled={busy} onClick={openSaveAs}>Save As</Button>
              </>
            }
            endContent={<Button design="Transparent" disabled={busy} onClick={openManage}>Manage</Button>}
          />
        }
      >
        {error && open ? (
          <MessageStrip design="Negative" hideCloseButton style={{ marginBottom: "0.5rem" }}>{error}</MessageStrip>
        ) : null}
        <List
          selectionMode="Single"
          onSelectionChange={(e) => {
            const item = e.detail.selectedItems[0] as HTMLElement | undefined;
            const id = item?.dataset?.id;
            if (id) {
              ov.select(id);
              setOpen(false);
            }
          }}
        >
          {ov.variants.map((v) => (
            <ListItemStandard
              key={v.id}
              data-id={v.id}
              type="Active"
              selected={v.id === ov.selectedId}
              text={v.name}
              additionalText={variantStatusLabel(v, v.id === ov.selectedId)}
              description={v.author ? `by ${v.author}` : undefined}
            />
          ))}
        </List>
      </ResponsivePopover>

      <Dialog
        open={saveAsOpen}
        onClose={() => setSaveAsOpen(false)}
        headerText="Save View As"
        style={{ width: 360 }}
        footer={
          <Bar
            endContent={
              <>
                <Button
                  design="Emphasized"
                  disabled={busy || !asName.trim()}
                  onClick={() =>
                    run(async () => {
                      await ov.saveAs({ name: asName, shared: asShared, isDefault: asDefault });
                      setSaveAsOpen(false);
                    })
                  }
                >
                  Save
                </Button>
                <Button design="Transparent" onClick={() => setSaveAsOpen(false)}>Cancel</Button>
              </>
            }
          />
        }
      >
        {error && saveAsOpen ? (
          <MessageStrip design="Negative" hideCloseButton style={{ marginBottom: "0.5rem" }}>{error}</MessageStrip>
        ) : null}
        <Label showColon>Name</Label>
        <Input style={{ width: "100%", marginBottom: "0.75rem" }} value={asName} onInput={(e) => setAsName(e.target.value)} />
        {ov.isAdmin ? (
          <div style={{ marginBottom: "0.5rem" }}>
            <CheckBox text="Shared" checked={asShared} onChange={() => setAsShared((s) => !s)} />
          </div>
        ) : null}
        <CheckBox text="Set as default" checked={asDefault} onChange={() => setAsDefault((d) => !d)} />
      </Dialog>

      <Dialog
        open={manageOpen}
        onClose={() => setManageOpen(false)}
        headerText="Manage Views"
        style={{ width: 560 }}
        footer={
          <Bar
            endContent={
              <>
                <Button design="Emphasized" disabled={busy} onClick={applyManage}>Save</Button>
                <Button design="Transparent" onClick={() => setManageOpen(false)}>Cancel</Button>
              </>
            }
          />
        }
      >
        {error && manageOpen ? (
          <MessageStrip design="Negative" hideCloseButton style={{ marginBottom: "0.5rem" }}>{error}</MessageStrip>
        ) : null}
        <Table
          headerRow={
            <TableHeaderRow>
              <TableHeaderCell>Name</TableHeaderCell>
              <TableHeaderCell width="5rem">Default</TableHeaderCell>
              {ov.isAdmin ? <TableHeaderCell width="5rem">Shared</TableHeaderCell> : null}
              <TableHeaderCell width="4rem" />
            </TableHeaderRow>
          }
        >
          {ov.variants.filter((v) => !deleted.has(v.id)).map((v) => (
            <TableRow key={v.id}>
              <TableCell>
                <Input
                  value={names[v.id] ?? v.name}
                  disabled={!canRenameVariant(v)}
                  onInput={(e) => setNames((n) => ({ ...n, [v.id]: e.target.value }))}
                />
              </TableCell>
              <TableCell>
                <CheckBox
                  checked={defaults[v.id] ?? v.isDefault}
                  disabled={!canSetDefault(v)}
                  onChange={() => setDefaults((d) => ({ ...d, [v.id]: !(d[v.id] ?? v.isDefault) }))}
                />
              </TableCell>
              {ov.isAdmin ? (
                <TableCell>
                  <CheckBox
                    checked={shareds[v.id] ?? v.shared}
                    disabled={!canSetShared(v, ov.isAdmin)}
                    onChange={() => setShareds((s) => ({ ...s, [v.id]: !(s[v.id] ?? v.shared) }))}
                  />
                </TableCell>
              ) : null}
              <TableCell>
                <Button
                  icon="delete"
                  design="Transparent"
                  disabled={!canDeleteVariant(v)}
                  onClick={() => setDeleted((d) => new Set(d).add(v.id))}
                />
              </TableCell>
            </TableRow>
          ))}
        </Table>
      </Dialog>
    </>
  );

  return (
    <>
      <ToolbarButton
        id={openerDomId}
        design="Transparent"
        icon="slim-arrow-down"
        endIcon={ov.dirty ? "edit" : undefined}
        text={buttonText}
        onClick={() => setOpen((o) => !o)}
      />
      {typeof document !== "undefined" ? createPortal(overlays, document.body) : overlays}
    </>
  );
}
