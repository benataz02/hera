import type { Entries, ModelDef, OutputOverrides, Outputs } from "@hera/config-engine";

// Pure view logic for the configuration wizard. Client-side mirrors of the server's
// RunCandidate/RunSelection jsonb shapes (web doesn't depend on @hera/db; structural match).
export type Candidate = { assignment: Entries; perBatch: { batchQty: number; outputs: Outputs }[] };
export type Sel = { candidateIdx: number; batchQty: number; overrides?: OutputOverrides };

export const fmt = (n: number): string => n.toLocaleString(undefined, { maximumFractionDigits: 2 });

export const statusUi = {
  draft: { state: "None", text: "Draft" },
  calculated: { state: "Information", text: "Calculated" },
  quoted: { state: "Positive", text: "Quoted" },
} as const;

// Params the run left open (assigned per candidate, not fixed in the run's entries),
// in model parameter order so labels are stable across candidates.
export function openKeys(model: ModelDef, runEntries: Entries, candidates: Candidate[]): string[] {
  const assigned = new Set<string>();
  for (const c of candidates) for (const k of Object.keys(c.assignment)) if (!(k in runEntries)) assigned.add(k);
  return model.parameters.map((p) => p.key).filter((k) => assigned.has(k));
}

export const candidateLabel = (keys: string[], assignment: Entries): string =>
  keys.length ? keys.map((k) => String(assignment[k] ?? "—")).join(" · ") : "Configuration";

// Lowest unit price per batch column -> candidate index (first wins on ties).
export function bestByBatch(candidates: Candidate[]): Record<number, number> {
  const best: Record<number, { idx: number; price: number }> = {};
  candidates.forEach((c, idx) => {
    for (const b of c.perBatch) {
      const cur = best[b.batchQty];
      if (!cur || b.outputs.unitPrice < cur.price) best[b.batchQty] = { idx, price: b.outputs.unitPrice };
    }
  });
  return Object.fromEntries(Object.entries(best).map(([q, v]) => [q, v.idx]));
}

export const isSelected = (sel: Sel[], candidateIdx: number, batchQty: number): boolean =>
  sel.some((s) => s.candidateIdx === candidateIdx && s.batchQty === batchQty);

export const toggleSelection = (sel: Sel[], candidateIdx: number, batchQty: number): Sel[] =>
  isSelected(sel, candidateIdx, batchQty)
    ? sel.filter((s) => !(s.candidateIdx === candidateIdx && s.batchQty === batchQty))
    : [...sel, { candidateIdx, batchQty }];

type BomOv = NonNullable<OutputOverrides["bom"]>[number];
type OpOv = NonNullable<OutputOverrides["ops"]>[number];
type AddedBom = NonNullable<OutputOverrides["addBom"]>[number];
type AddedOp = NonNullable<OutputOverrides["addOps"]>[number];

const upsert = <T extends { id: string }>(list: T[] | undefined, id: string, patch: Partial<T>): T[] => {
  const next = [...(list ?? [])];
  const i = next.findIndex((o) => o.id === id);
  if (i >= 0) next[i] = { ...next[i]!, ...patch };
  else next.push({ id, ...patch } as T);
  return next;
};

export const patchBom = (ov: OutputOverrides, id: string, patch: Partial<BomOv>): OutputOverrides =>
  ({ ...ov, bom: upsert(ov.bom, id, patch) });
export const patchOp = (ov: OutputOverrides, id: string, patch: Partial<OpOv>): OutputOverrides =>
  ({ ...ov, ops: upsert(ov.ops, id, patch) });
export const resetLine = (ov: OutputOverrides, kind: "bom" | "ops", id: string): OutputOverrides =>
  ({ ...ov, [kind]: (ov[kind] ?? []).filter((o) => o.id !== id) });
export const isEdited = (ov: OutputOverrides, kind: "bom" | "ops", id: string): boolean =>
  (ov[kind] ?? []).some((o) => o.id === id);
export const isRemoved = (ov: OutputOverrides, kind: "bom" | "ops", id: string): boolean =>
  (ov[kind] ?? []).some((o) => o.id === id && o.remove === true);

export const addBomLine = (ov: OutputOverrides): OutputOverrides =>
  ({ ...ov, addBom: [...(ov.addBom ?? []), { id: crypto.randomUUID(), itemCode: "NEW", qtyPerUnit: 1, unitPrice: 0 }] });
export const addOpLine = (ov: OutputOverrides): OutputOverrides =>
  ({ ...ov, addOps: [...(ov.addOps ?? []), { id: crypto.randomUUID(), resource: "NEW", setupMin: 0, runMinPerUnit: 0, ratePerHour: 0 }] });
export const patchAddedBom = (ov: OutputOverrides, id: string, patch: Partial<AddedBom>): OutputOverrides =>
  ({ ...ov, addBom: (ov.addBom ?? []).map((o) => (o.id === id ? { ...o, ...patch } : o)) });
export const patchAddedOp = (ov: OutputOverrides, id: string, patch: Partial<AddedOp>): OutputOverrides =>
  ({ ...ov, addOps: (ov.addOps ?? []).map((o) => (o.id === id ? { ...o, ...patch } : o)) });
export const removeAddedBom = (ov: OutputOverrides, id: string): OutputOverrides =>
  ({ ...ov, addBom: (ov.addBom ?? []).filter((o) => o.id !== id) });
export const removeAddedOp = (ov: OutputOverrides, id: string): OutputOverrides =>
  ({ ...ov, addOps: (ov.addOps ?? []).filter((o) => o.id !== id) });

// Same overrides with remove flags dropped: the display pass keeps removed rows visible
// (struck through) while the totals pass uses the full overrides.
export const withoutRemovals = (ov: OutputOverrides | undefined): OutputOverrides | undefined =>
  ov && {
    ...ov,
    bom: ov.bom?.map(({ remove: _remove, ...rest }) => rest),
    ops: ov.ops?.map(({ remove: _remove, ...rest }) => rest),
  };

export const cleanOverrides = (ov: OutputOverrides | undefined): OutputOverrides | undefined =>
  ov && (ov.bom?.length || ov.ops?.length || ov.addBom?.length || ov.addOps?.length) ? ov : undefined;
