import type {
  EntityCapabilities,
  EntityProfile,
  EntityProperty,
  EntitySchema,
  ObjectVariantDef,
} from "@hera/db";
import { formatCell } from "./listSpec.ts";
import { randomUuid } from "./uuid.ts";

export type ObjectFieldSpec = {
  name: string;
  label: string;
  type: string;
  width?: number;
};

export type ObjectSectionSpec = {
  id: string;
  title: string;
  kind: "general" | "collection";
  fields: ObjectFieldSpec[];
};

type FieldDef = ObjectVariantDef["header"][number];

type ColumnKind = "numeric" | "date" | "boolean" | "code" | "lookup" | "description" | "text";

const PAD = { display: 24, edit: 48 } as const;

/** Type-specific pixel bounds for auto-fit columns. */
export const COLUMN_BOUNDS: Record<ColumnKind, { min: number; max: number }> = {
  numeric: { min: 64, max: 112 },
  date: { min: 100, max: 160 },
  boolean: { min: 48, max: 72 },
  code: { min: 80, max: 140 },
  lookup: { min: 120, max: 220 },
  description: { min: 160, max: 400 },
  text: { min: 100, max: 240 },
};

function fieldLabel(name: string, override?: string): string {
  return override?.trim() || name;
}

function str(v: unknown): string {
  if (v == null) return "";
  return typeof v === "object" ? JSON.stringify(v) : String(v);
}

/**
 * Display text for a value. Enum members round-trip as B1 names (`bost_Open`), so show the
 * humanized member text instead of the raw value; everything else falls back to `formatCell`.
 */
export function fieldDisplayText(prop: EntityProperty | undefined, value: unknown): string {
  const hit = prop?.options?.find((o) => o.value === String(value));
  if (hit) return hit.text || hit.value;
  return formatCell(value, prop?.type ?? "");
}

export function classifyColumnKind(prop: EntityProperty | undefined, name: string): ColumnKind {
  if (prop?.lookup) return "lookup";
  if (prop?.options?.length) return "code";
  const t = prop?.type ?? "";
  if (/bool/i.test(t)) return "boolean";
  if (/date|time/i.test(t)) return "date";
  if (/int|double|decimal|single|byte|number/i.test(t)) return "numeric";
  if (/Description|Comments|Remarks/i.test(name) || /^(ItemName|CardName|Name)$/i.test(name)) {
    return "description";
  }
  if (/Code$|Entry$/i.test(name)) return "code";
  return "text";
}

function isDescriptionLike(kind: ColumnKind, name: string): boolean {
  return kind === "description" || /Description|Comments|Remarks/i.test(name);
}

function descriptionFlexScore(name: string): number {
  if (/Description/i.test(name)) return 0;
  if (/Comments|Remarks/i.test(name)) return 1;
  if (/Name$/i.test(name)) return 2;
  return 3;
}

/**
 * Deterministic content-aware column widths. Exactly one description-like column may be `"flex"`;
 * explicit `FieldDef.width` always wins (and never becomes flex).
 */
export function autoColumnWidths(input: {
  fields: FieldDef[];
  properties: EntityProperty[];
  rows: Record<string, unknown>[];
  mode: "display" | "edit";
  measure: (text: string) => number;
}): Record<string, number | "flex"> {
  const propBy = new Map(input.properties.map((p) => [p.name, p]));
  const pad = input.mode === "edit" ? PAD.edit : PAD.display;

  type Computed = {
    name: string;
    width: number;
    explicit: boolean;
    desc: boolean;
  };
  const computed: Computed[] = [];

  for (const f of input.fields) {
    if (!f.visible) continue;
    const prop = propBy.get(f.name);
    const kind = classifyColumnKind(prop, f.name);
    const desc = isDescriptionLike(kind, f.name);

    if (f.width != null && f.width > 0) {
      computed.push({ name: f.name, width: f.width, explicit: true, desc: false });
      continue;
    }

    const label = fieldLabel(f.name, f.label);
    let content = input.measure(label);
    for (const row of input.rows) {
      content = Math.max(content, input.measure(formatCell(row[f.name], prop?.type ?? "")));
    }
    const { min, max } = COLUMN_BOUNDS[kind];
    // Edit mode always gets control affordance beyond display mins (even when content is tiny).
    const editBump = input.mode === "edit" ? PAD.edit - PAD.display : 0;
    const width = Math.min(max + editBump, Math.max(min + editBump, Math.ceil(content + pad)));
    computed.push({ name: f.name, width, explicit: false, desc });
  }

  const flexCandidates = computed.filter((c) => !c.explicit && c.desc);
  flexCandidates.sort((a, b) => descriptionFlexScore(a.name) - descriptionFlexScore(b.name));
  const flexName = flexCandidates[0]?.name;

  const out: Record<string, number | "flex"> = {};
  for (const c of computed) {
    out[c.name] = c.name === flexName ? "flex" : c.width;
  }
  return out;
}

/**
 * Browser measure adapter using the current computed UI5 font.
 * Callers should re-run after `document.fonts.ready`, theme, rows, mode, label, or variant change.
 */
export function createUi5TextMeasure(sampleEl?: HTMLElement): (text: string) => number {
  if (typeof document === "undefined") return (text) => text.length * 8;
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  if (!ctx) return (text) => text.length * 8;
  const el = sampleEl ?? document.body;
  const style = getComputedStyle(el);
  const fontSize = style.getPropertyValue("--sapFontSize").trim() || style.fontSize || "14px";
  const fontFamily =
    style.getPropertyValue("--sapFontFamily").trim() || style.fontFamily || "Arial, sans-serif";
  ctx.font = `${fontSize} ${fontFamily}`;
  return (text: string) => ctx.measureText(text).width;
}

/** Document/master title + subtitle from profile fields present on the record. */
export function titleForRecord(
  entity: string,
  record: Record<string, unknown>,
  schema: EntitySchema,
  profile: EntityProfile | null,
): { title: string; subtitle: string } {
  const titleField = profile?.titleField ?? schema.keys[0];
  const titleVal = titleField ? str(record[titleField]) : "";
  const title = titleVal ? `${entity} ${titleVal}` : entity;

  const subtitleParts = (profile?.subtitleFields ?? [])
    .map((f) => str(record[f]).trim())
    .filter(Boolean);
  return { title, subtitle: subtitleParts.join(" · ") };
}

/** Visible general + collection sections for read-only object rendering. */
export function visibleObjectSections(
  schema: EntitySchema,
  definition: ObjectVariantDef,
): ObjectSectionSpec[] {
  const propByName = new Map(schema.properties.map((p) => [p.name, p]));
  const colByName = new Map(schema.collections.map((c) => [c.name, c]));
  const out: ObjectSectionSpec[] = [];

  for (const section of definition.sections) {
    if (!section.visible) continue;

    if (section.id === "general") {
      const fields: ObjectFieldSpec[] = [];
      for (const f of section.fields) {
        if (!f.visible) continue;
        const prop = propByName.get(f.name);
        if (!prop) continue;
        fields.push({
          name: f.name,
          label: fieldLabel(f.name, f.label),
          type: prop.type,
          width: f.width,
        });
      }
      out.push({ id: "general", title: "General", kind: "general", fields });
      continue;
    }

    const col = colByName.get(section.id);
    if (!col) continue;
    const colProp = new Map(col.properties.map((p) => [p.name, p]));
    const fields: ObjectFieldSpec[] = [];
    for (const f of section.fields) {
      if (!f.visible) continue;
      const prop = colProp.get(f.name);
      if (!prop) continue;
      fields.push({
        name: f.name,
        label: fieldLabel(f.name, f.label),
        type: prop.type,
        width: f.width,
      });
    }
    out.push({ id: section.id, title: section.id, kind: "collection", fields });
  }

  return out;
}

/** Visible header facet fields (ObjectPageHeader), excluding schema keys unless opted in. */
export function visibleHeaderFields(
  schema: EntitySchema,
  definition: ObjectVariantDef,
): ObjectFieldSpec[] {
  const propByName = new Map(schema.properties.map((p) => [p.name, p]));
  const fields: ObjectFieldSpec[] = [];
  for (const f of definition.header) {
    if (!f.visible) continue;
    const prop = propByName.get(f.name);
    if (!prop) continue;
    fields.push({
      name: f.name,
      label: fieldLabel(f.name, f.label),
      type: prop.type,
      width: f.width,
    });
  }
  return fields;
}

/** Deep clone for edit draft — nested arrays/objects must not share identity with the query record. */
export function cloneForEdit(record: Record<string, unknown>): Record<string, unknown> {
  return structuredClone(record);
}

function lockAllows(
  record: Record<string, unknown>,
  rule: { field: string; allowed: Array<string | number | boolean> },
): boolean {
  if (!(rule.field in record)) return false;
  const v = record[rule.field];
  return rule.allowed.some((a) => a === v);
}

/** Profile status locks → editability. Missing lock fields → display-only. Null profile → no edit. */
export function resolveEntityCapabilities(
  profile: EntityProfile | null,
  record: Record<string, unknown>,
): EntityCapabilities {
  if (!profile) return { canEdit: false, canCreate: false, reason: "No profile" };
  const locks = profile.fields.editWhen;
  if (locks.length && !locks.every((r) => lockAllows(record, r))) {
    return { canEdit: false, canCreate: !!profile.create, reason: "Status lock" };
  }
  return { canEdit: true, canCreate: !!profile.create };
}

export function isHeaderFieldEditable(
  profile: EntityProfile | null,
  field: string,
  capabilities: EntityCapabilities,
): boolean {
  if (!capabilities.canEdit || !profile) return false;
  if (profile.fields.readOnly.includes(field)) return false;
  return profile.fields.editableHeader.includes(field);
}

export function isCollectionFieldEditable(
  profile: EntityProfile | null,
  collection: string,
  field: string,
  capabilities: EntityCapabilities,
): boolean {
  if (!capabilities.canEdit || !profile) return false;
  if (!profile.collections[collection]?.editable) return false;
  return (profile.fields.collectionEditable[collection] ?? []).includes(field);
}

/** requiredOnCreate blanks — client gate before onSubmit (SAP remains final authority). */
export function missingRequiredFields(
  profile: EntityProfile | null,
  draft: Record<string, unknown>,
): string[] {
  if (!profile) return [];
  const missing: string[] = [];
  for (const name of profile.fields.requiredOnCreate) {
    const v = draft[name];
    if (v == null || (typeof v === "string" && !v.trim())) missing.push(name);
  }
  return missing;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/**
 * Merge newly fetched projection into draft. Skip dirty paths and paths already present.
 * Collection arrays prefer draft length (deleted rows stay gone; local adds kept).
 */
export function mergeFetchedIntoDraft(
  draft: Record<string, unknown>,
  fetched: Record<string, unknown>,
  dirtyPaths: Set<string>,
): Record<string, unknown> {
  return mergeLevel(draft, fetched, dirtyPaths, "");
}

function mergeLevel(
  draft: Record<string, unknown>,
  fetched: Record<string, unknown>,
  dirtyPaths: Set<string>,
  prefix: string,
): Record<string, unknown> {
  const next = { ...draft };
  for (const [key, fVal] of Object.entries(fetched)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (dirtyPaths.has(path)) continue;

    if (Array.isArray(fVal) && Array.isArray(next[key])) {
      const dRows = next[key] as Record<string, unknown>[];
      const fRows = fVal as Record<string, unknown>[];
      // Prefer draft length: never restore deleted rows; keep local adds.
      next[key] = dRows.map((dRow, i) => {
        const fRow = fRows[i];
        if (!fRow) return { ...dRow };
        return mergeLevel(dRow, fRow, dirtyPaths, `${path}.${i}`);
      });
      continue;
    }

    if (isPlainObject(fVal) && isPlainObject(next[key])) {
      next[key] = mergeLevel(next[key], fVal, dirtyPaths, path);
      continue;
    }

    if (!(key in next) || next[key] === undefined) {
      next[key] = structuredClone(fVal);
    }
  }
  return next;
}

function setAtPathWalk(
  draft: Record<string, unknown>,
  parts: string[],
  value: unknown,
): Record<string, unknown> {
  if (parts.length === 1) return { ...draft, [parts[0]!]: value };
  const [head, ...rest] = parts;
  const key = head!;
  const child = draft[key];
  if (Array.isArray(child)) {
    const index = Number(rest[0]);
    const arr = child.map((row, i) => {
      if (i !== index) return row;
      return setAtPathWalk(row as Record<string, unknown>, rest.slice(1), value);
    });
    return { ...draft, [key]: arr };
  }
  const obj = isPlainObject(child) ? child : {};
  return { ...draft, [key]: setAtPathWalk(obj, rest, value) };
}

export function patchDraftField(
  draft: Record<string, unknown>,
  dirtyPaths: Set<string>,
  path: string,
  value: unknown,
): { draft: Record<string, unknown>; dirtyPaths: Set<string> } {
  const nextDirty = new Set(dirtyPaths);
  nextDirty.add(path);
  return { draft: setAtPathWalk(draft, path.split("."), value), dirtyPaths: nextDirty };
}

export function addCollectionRow(
  draft: Record<string, unknown>,
  dirtyPaths: Set<string>,
  collection: string,
  row: Record<string, unknown> = {},
): { draft: Record<string, unknown>; dirtyPaths: Set<string> } {
  const rows = Array.isArray(draft[collection])
    ? [...(draft[collection] as Record<string, unknown>[])]
    : [];
  rows.push({ ...row });
  const nextDirty = new Set(dirtyPaths);
  nextDirty.add(collection); // collection mutated — include on write (ReplaceCollections)
  return { draft: { ...draft, [collection]: rows }, dirtyPaths: nextDirty };
}

/** True when dirtyPaths touch the collection root or any `Collection.*` path. */
export function isCollectionDirty(dirtyPaths: Set<string>, collection: string): boolean {
  if (dirtyPaths.has(collection)) return true;
  const prefix = `${collection}.`;
  for (const p of dirtyPaths) {
    if (p.startsWith(prefix)) return true;
  }
  return false;
}

/**
 * Build update `data` for entities.write. Omits collections that are not dirty so the agent
 * does not set B1S-ReplaceCollectionsOnPatch (header-only saves must not clear lines).
 */
export function buildWriteData(
  draft: Record<string, unknown>,
  dirtyPaths: Set<string>,
  collectionNames: Iterable<string>,
): Record<string, unknown> {
  const data = { ...draft };
  for (const name of collectionNames) {
    if (!isCollectionDirty(dirtyPaths, name)) delete data[name];
  }
  return data;
}

export function removeCollectionRow(
  draft: Record<string, unknown>,
  dirtyPaths: Set<string>,
  collection: string,
  index: number,
): { draft: Record<string, unknown>; dirtyPaths: Set<string> } {
  const rows = Array.isArray(draft[collection])
    ? [...(draft[collection] as Record<string, unknown>[])]
    : [];
  rows.splice(index, 1);
  const prefix = `${collection}.`;
  const nextDirty = new Set<string>();
  nextDirty.add(collection); // collection mutated — merge must not restore deleted rows
  for (const p of dirtyPaths) {
    if (p === collection) continue;
    if (!p.startsWith(prefix)) {
      nextDirty.add(p);
      continue;
    }
    const rest = p.slice(prefix.length);
    const dot = rest.indexOf(".");
    const idxStr = dot === -1 ? rest : rest.slice(0, dot);
    const idx = Number(idxStr);
    if (!Number.isFinite(idx) || idx === index) continue;
    const field = dot === -1 ? "" : rest.slice(dot + 1);
    const newIdx = idx > index ? idx - 1 : idx;
    nextDirty.add(field ? `${collection}.${newIdx}.${field}` : `${collection}.${newIdx}`);
  }
  return { draft: { ...draft, [collection]: rows }, dirtyPaths: nextDirty };
}

/**
 * Durable write UI status.
 * `submitting` is optimistic (before `write` returns a requestId);
 * `pending` / `in_flight` / `done` / `failed` mirror `entities.watchWrite`.
 */
export type WriteUiStatus =
  | "submitting"
  | "pending"
  | "in_flight"
  | "done"
  | "failed"
  | null;

export type WriteStatusStrip = {
  design: "Information" | "Positive" | "Negative" | "Critical";
  text: string;
};

/** How long the Positive “Saved” strip stays visible before exiting edit. */
export const WRITE_DONE_VISIBLE_MS = 600;

/** MessageStrip copy for a write watch state. */
export function writeStatusMessage(
  status: WriteUiStatus,
  error?: string | null,
): WriteStatusStrip | null {
  if (!status) return null;
  switch (status) {
    case "submitting":
    case "pending":
      return { design: "Information", text: "Pending…" };
    case "in_flight":
      return { design: "Information", text: "Saving / In flight…" };
    case "failed":
      return { design: "Negative", text: error?.trim() || "Save failed" };
    case "done":
      return { design: "Positive", text: "Saved" };
  }
}

/** Save stays disabled while submitting / claimed / waiting / showing Done. */
export function shouldDisableSave(status: WriteUiStatus): boolean {
  return (
    status === "submitting" ||
    status === "pending" ||
    status === "in_flight" ||
    status === "done"
  );
}

/**
 * Cancel is locked once submit starts (optimistic enqueued) or while a
 * durable command is live / Done is painting.
 */
export function shouldDisableCancel(enqueued: boolean, status: WriteUiStatus): boolean {
  return (
    enqueued ||
    status === "submitting" ||
    status === "pending" ||
    status === "in_flight" ||
    status === "done"
  );
}

/** Permanent failure keeps the user in edit mode with the draft intact. */
export function shouldPreserveDraftOnFailure(status: WriteUiStatus): boolean {
  return status === "failed";
}

/**
 * After permanent failure the prior commandId is terminal (dedup). Mint a
 * fresh id so Save can enqueue a new write while keeping the draft.
 */
export function shouldMintNewCommandIdAfterFailed(status: WriteUiStatus): boolean {
  return status === "failed";
}

/**
 * After Done: drop the draft so display comes from the refetched projection
 * (server totals replace any local optimistic arithmetic).
 */
export function applyWriteDoneDisplay(
  _optimisticDraft: Record<string, unknown>,
  fetched: Record<string, unknown>,
): { draft: null; working: Record<string, unknown> } {
  return { draft: null, working: fetched };
}

/**
 * Exit sequence after Done: paint Positive briefly, then clear the edit session.
 * Caller awaits this before invalidate/clear so the strip is visible.
 */
export function waitWriteDoneVisible(
  ms: number = WRITE_DONE_VISIBLE_MS,
): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Cancel only clears the edit session before enqueue. After enqueue the command lives. */
export function shouldClearDraftOnCancel(enqueued: boolean): boolean {
  return !enqueued;
}

/** Navigating away must not cancel a durable write (watch abort ≠ command cancel). */
export function shouldAbortWriteOnNavigateAway(): boolean {
  return false;
}

/** Fresh UUID when entering edit mode or after permanent failure (dedup-safe retry). */
export function newEditCommandId(): string {
  return randomUuid();
}
