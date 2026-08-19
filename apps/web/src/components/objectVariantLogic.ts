import type { ObjectVariantDef } from "@hera/db";

export type VariantRow = {
  id: string;
  name: string;
  shared: boolean;
  isDefault: boolean;
  isStandard: boolean;
  canManage: boolean;
  definition: unknown;
  author?: string | null;
};

export type SaveAsInput = {
  name: string;
  shared: boolean;
  isDefault: boolean;
};

export type FieldPickerItem = {
  name: string;
  visible: boolean;
  label: string;
  defaultLabel: string;
  /** undefined = Auto / Fit Content */
  width?: number;
};

export type FieldDef = ObjectVariantDef["header"][number];

export const EMPTY_OBJECT_DEF: ObjectVariantDef = { header: [], sections: [] };

function asFieldDef(raw: unknown): FieldDef | null {
  if (!raw || typeof raw !== "object") return null;
  const f = raw as Record<string, unknown>;
  if (typeof f.name !== "string" || typeof f.visible !== "boolean") return null;
  const out: FieldDef = { name: f.name, visible: f.visible };
  if (typeof f.label === "string" && f.label.trim()) out.label = f.label;
  if (typeof f.width === "number" && f.width > 0) out.width = f.width;
  return out;
}

function asSections(raw: unknown): ObjectVariantDef["sections"] {
  if (!Array.isArray(raw)) return [];
  const out: ObjectVariantDef["sections"] = [];
  for (const s of raw) {
    if (!s || typeof s !== "object") continue;
    const sec = s as Record<string, unknown>;
    if (typeof sec.id !== "string" || typeof sec.visible !== "boolean") continue;
    const fields = Array.isArray(sec.fields)
      ? sec.fields.map(asFieldDef).filter((f): f is FieldDef => !!f)
      : [];
    out.push({ id: sec.id, visible: sec.visible, fields });
  }
  return out;
}

/** Normalize legacy `{ fields, sections }` once into `{ header, sections }`. */
export function normalizeObjectDef(raw: unknown): ObjectVariantDef {
  if (!raw || typeof raw !== "object") return EMPTY_OBJECT_DEF;
  const d = raw as Record<string, unknown>;

  // Legacy shape (no `header`): treat `fields` as header facets.
  if (!("header" in d) && Array.isArray(d.fields)) {
    return {
      header: d.fields.map(asFieldDef).filter((f): f is FieldDef => !!f),
      sections: asSections(d.sections),
    };
  }

  if (Array.isArray(d.header) || Array.isArray(d.sections)) {
    return {
      header: Array.isArray(d.header)
        ? d.header.map(asFieldDef).filter((f): f is FieldDef => !!f)
        : [],
      sections: asSections(d.sections),
    };
  }

  return EMPTY_OBJECT_DEF;
}

const normName = (n: string) => n.trim().toLowerCase();

/** Duplicate name within personal or shared scope (excluding `excludeId`). */
export function findDuplicateVariantName(
  variants: VariantRow[],
  name: string,
  shared: boolean,
  excludeId?: string,
): VariantRow | undefined {
  const key = normName(name);
  if (!key) return undefined;
  return variants.find(
    (v) =>
      v.shared === shared &&
      v.id !== excludeId &&
      normName(v.name) === key,
  );
}

/** Composes list-item additionalText for selected / default / shared state. */
export function variantStatusLabel(
  v: Pick<VariantRow, "isDefault" | "shared">,
  selected: boolean,
): string {
  const parts: string[] = [];
  if (selected) parts.push("Selected");
  if (v.isDefault) parts.push("Default");
  if (v.shared) parts.push("Shared");
  return parts.join(" · ");
}

export function canRenameVariant(v: VariantRow): boolean {
  return !v.isStandard && v.canManage;
}

export function canDeleteVariant(v: VariantRow): boolean {
  return !v.isStandard && v.canManage;
}

export function canSetShared(v: VariantRow, isAdmin: boolean): boolean {
  return isAdmin && !v.isStandard && v.canManage;
}

/** Aligns with list VariantItem readOnly={!canManage || isStandard}. */
export function canSetDefault(v: VariantRow): boolean {
  return v.canManage && !v.isStandard;
}

/** Personal default wins over shared default, else first row. */
export function pickDefaultVariantId(variants: VariantRow[]): string | null {
  const personal = variants.find((v) => v.isDefault && !v.shared);
  const shared = variants.find((v) => v.isDefault);
  return personal?.id ?? shared?.id ?? variants[0]?.id ?? null;
}

/** Apply FieldPicker draft → FieldDef[] (order preserved). Confirm-only. */
export function confirmFieldPicker(draft: FieldPickerItem[]): FieldDef[] {
  return draft.map((d) => {
    const out: FieldDef = { name: d.name, visible: d.visible };
    const label = d.label.trim();
    if (label && label !== d.defaultLabel) out.label = label;
    if (typeof d.width === "number" && d.width > 0) out.width = d.width;
    return out;
  });
}

/** Build a FieldPicker draft from a FieldDef list + available schema names. */
export function openFieldPickerDraft(
  fields: FieldDef[],
  available: { name: string; label?: string }[],
): FieldPickerItem[] {
  const byName = new Map(fields.map((f) => [f.name, f]));
  const ordered = [
    ...fields.map((f) => f.name),
    ...available.map((a) => a.name).filter((n) => !byName.has(n)),
  ];
  const seen = new Set<string>();
  const out: FieldPickerItem[] = [];
  for (const name of ordered) {
    if (seen.has(name)) continue;
    seen.add(name);
    const def = byName.get(name);
    const meta = available.find((a) => a.name === name);
    const defaultLabel = meta?.label ?? name;
    out.push({
      name,
      visible: def?.visible ?? false,
      label: def?.label ?? defaultLabel,
      defaultLabel,
      width: def?.width,
    });
  }
  return out;
}

export function moveFieldPickerItem(
  draft: FieldPickerItem[],
  fromName: string,
  toName: string,
  placement: "Before" | "After" | "On",
): FieldPickerItem[] {
  if (fromName === toName) return draft;
  const next = [...draft];
  const from = next.findIndex((d) => d.name === fromName);
  if (from < 0) return draft;
  const [moved] = next.splice(from, 1);
  if (!moved) return draft;
  let to = next.findIndex((d) => d.name === toName);
  if (to < 0) return draft;
  if (placement === "After") to += 1;
  next.splice(to, 0, moved);
  return next;
}
