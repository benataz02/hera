import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ObjectVariantDef } from "@hera/db";
import { orpc } from "./orpc.ts";
import { EMPTY_SPEC, sameDef, type ListVariantDef, type FilterCond, type FilterOp } from "./listSpec.ts";
import {
  EMPTY_OBJECT_DEF,
  findDuplicateVariantName,
  normalizeObjectDef,
  pickDefaultVariantId,
  type SaveAsInput,
  type VariantRow,
} from "./components/objectVariantLogic.ts";

// The pure list-view logic lives in listSpec.ts (no orpc import, so it's unit-testable); re-exported
// here so pages have a single import path.
export * from "./listSpec.ts";
export type { SaveAsInput, VariantRow } from "./components/objectVariantLogic.ts";

export type VariantPage = "list" | "object";

// One place for the variant query + mutations so both pages stay thin.
//
// A `portal:` key is served by portal.variants instead: variants.list is userProcedure, which
// fences client accounts out entirely. Both queries are declared unconditionally (hooks rules)
// and exactly one is enabled — the disabled one never fetches and is never read.
export function useVariants(page: VariantPage, entity: string) {
  const qc = useQueryClient();
  const readOnly = entity.startsWith("portal:");

  const opts = orpc.variants.list.queryOptions({ input: { page, entity } });
  const internal = useQuery({ ...opts, enabled: !readOnly });
  const portal = useQuery({
    ...orpc.portal.variants.queryOptions({ input: { page, entity } }),
    enabled: readOnly,
  });

  const data = readOnly ? portal.data : internal.data;
  const invalidate = () => qc.invalidateQueries({ queryKey: opts.queryKey });
  const save = useMutation(orpc.variants.save.mutationOptions({ onSuccess: invalidate }));
  const remove = useMutation(orpc.variants.remove.mutationOptions({ onSuccess: invalidate }));
  const setWidths = useMutation(orpc.variants.setWidths.mutationOptions());
  return {
    variants: data?.variants ?? [],
    isAdmin: data?.isAdmin ?? false,
    isLoading: readOnly ? portal.isPending : internal.isPending,
    /** a portal client cannot create, edit or delete a view — the chrome for it is hidden */
    readOnly,
    save,
    remove,
    setWidths,
  };
}

/** Object-page views: select by immutable id; draft definition stays separate from persisted rows. */
export function useObjectVariants(entity: string, recordKey?: string) {
  const qc = useQueryClient();
  const { variants: raw, isAdmin, isLoading, save, remove } = useVariants("object", entity);
  const variants: VariantRow[] = raw.map((v) => ({
    id: v.id,
    name: v.name,
    shared: v.shared,
    isDefault: v.isDefault,
    isStandard: v.isStandard,
    canManage: v.canManage,
    definition: v.definition,
    author: v.author,
  }));

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [definition, setDefinition] = useState<ObjectVariantDef>(EMPTY_OBJECT_DEF);
  const [initedFor, setInitedFor] = useState("");

  useEffect(() => {
    if (isLoading || initedFor === entity) return;
    const id = pickDefaultVariantId(variants);
    setSelectedId(id);
    const row = variants.find((v) => v.id === id);
    setDefinition(row ? normalizeObjectDef(row.definition) : EMPTY_OBJECT_DEF);
    setInitedFor(entity);
  }, [isLoading, entity, initedFor, variants]);

  const selected = variants.find((v) => v.id === selectedId) ?? null;
  const persisted = selected ? normalizeObjectDef(selected.definition) : null;

  const invalidateObjectGet = (_variantId: string) => undefined;

  const select = (id: string) => {
    const row = variants.find((v) => v.id === id);
    if (!row) return;
    setSelectedId(id);
    setDefinition(normalizeObjectDef(row.definition));
  };

  const saveDef = async (def: ObjectVariantDef) => {
    if (!selected) throw new Error("No view selected");
    if (!selected.canManage) throw new Error("Not allowed to edit this view");
    await save.mutateAsync({
      id: selected.id,
      page: "object",
      entity,
      name: selected.name,
      definition: def,
      shared: selected.shared,
      isDefault: selected.isDefault,
    });
    setDefinition(def);
    await invalidateObjectGet(selected.id);
  };

  const saveAs = async (input: SaveAsInput) => {
    const name = input.name.trim();
    if (!name) throw new Error("Name is required");
    if (findDuplicateVariantName(variants, name, input.shared)) {
      throw new Error(input.shared ? "A shared view with this name already exists" : "A personal view with this name already exists");
    }
    if (input.shared && !isAdmin) throw new Error("Only admins can publish shared views");
    const { id } = await save.mutateAsync({
      page: "object",
      entity,
      name,
      definition,
      shared: input.shared,
      isDefault: input.isDefault,
    });
    setSelectedId(id);
    await invalidateObjectGet(id);
  };

  const rename = async (id: string, name: string) => {
    const row = variants.find((v) => v.id === id);
    if (!row) throw new Error("View not found");
    if (row.isStandard) throw new Error("Standard view cannot be renamed");
    if (!row.canManage) throw new Error("Not allowed to edit this view");
    const trimmed = name.trim();
    if (!trimmed) throw new Error("Name is required");
    if (findDuplicateVariantName(variants, trimmed, row.shared, id)) {
      throw new Error(row.shared ? "A shared view with this name already exists" : "A personal view with this name already exists");
    }
    await save.mutateAsync({
      id,
      page: "object",
      entity,
      name: trimmed,
      definition: normalizeObjectDef(row.definition),
      shared: row.shared,
      isDefault: row.isDefault,
    });
  };

  const setDefault = async (id: string, value: boolean) => {
    const row = variants.find((v) => v.id === id);
    if (!row) throw new Error("View not found");
    // Same gate as list VariantItem readOnly={!canManage || isStandard}.
    if (!row.canManage || row.isStandard) throw new Error("Not allowed to edit this view");
    await save.mutateAsync({
      id,
      page: "object",
      entity,
      name: row.name,
      definition: normalizeObjectDef(row.definition),
      shared: row.shared,
      isDefault: value,
    });
  };

  const setShared = async (id: string, value: boolean) => {
    const row = variants.find((v) => v.id === id);
    if (!row) throw new Error("View not found");
    if (row.isStandard) throw new Error("Standard view cannot change sharing");
    if (!isAdmin || !row.canManage) throw new Error("Only admins can publish shared views");
    await save.mutateAsync({
      id,
      page: "object",
      entity,
      name: row.name,
      definition: normalizeObjectDef(row.definition),
      shared: value,
      isDefault: row.isDefault,
    });
  };

  const removeVariant = async (id: string) => {
    const row = variants.find((v) => v.id === id);
    if (!row) throw new Error("View not found");
    if (row.isStandard) throw new Error("Standard view cannot be deleted");
    if (!row.canManage) throw new Error("Not allowed to delete this view");
    await remove.mutateAsync({ id });
    if (selectedId === id) {
      const rest = variants.filter((v) => v.id !== id);
      const next = pickDefaultVariantId(rest);
      setSelectedId(next);
      const nextRow = rest.find((v) => v.id === next);
      setDefinition(nextRow ? normalizeObjectDef(nextRow.definition) : EMPTY_OBJECT_DEF);
    }
  };

  return {
    variants,
    selectedId,
    definition,
    setDefinition,
    dirty: !sameDef(definition, persisted),
    ready: initedFor === entity,
    isAdmin,
    isLoading,
    select,
    save: saveDef,
    saveAs,
    rename,
    setDefault,
    setShared,
    remove: removeVariant,
  };
}

export type ObjectVariants = ReturnType<typeof useObjectVariants>;

// The applied view: it drives the query, the dirty marker and what a Save persists. Owned here so
// the page can run its own query off `spec` while ListReport renders the chrome from the same state.
export function useListSpec(entity: string) {
  const { variants, isAdmin, isLoading, readOnly, save, remove, setWidths } = useVariants("list", entity);
  const [spec, setSpec] = useState<ListVariantDef>(EMPTY_SPEC);
  const [selectedName, setSelectedName] = useState("");
  // Which entity `spec` was initialised for. Gates the query so an entity switch can't fire one
  // render's worth of requests carrying the previous entity's field names.
  const [initedFor, setInitedFor] = useState("");

  // Apply the user's default view once per entity: a personal default wins over the shared Standard.
  useEffect(() => {
    if (isLoading || initedFor === entity) return;
    const personal = variants.find((v) => v.isDefault && !v.shared);
    const def = personal ?? variants.find((v) => v.isDefault) ?? variants[0];
    setSelectedName(def?.name ?? "");
    // No variant at all (seed never ran) falls back to an unnamed empty view rather than blocking
    // the page forever — the user can still filter and Save As.
    setSpec(def ? (def.definition as ListVariantDef) : EMPTY_SPEC);
    setInitedFor(entity);
  }, [isLoading, entity, initedFor, variants]);

  const selectedDef = (variants.find((v) => v.name === selectedName)?.definition as ListVariantDef) ?? null;

  const applyVariant = (name: string) => {
    setSelectedName(name);
    setSpec((variants.find((v) => v.name === name)?.definition as ListVariantDef) ?? EMPTY_SPEC);
  };

  const setCond = (field: string, op: FilterOp, value: FilterCond["value"] | "") =>
    setSpec((s) => {
      const rest = s.filter.filter((c) => c.field !== field);
      const empty = value === "" || value == null;
      return { ...s, filter: empty ? rest : [...rest, { field, op, value }] };
    });

  return {
    entity,
    spec,
    setSpec,
    setCond,
    /** variants loaded and a view applied — gate the page's query on this */
    ready: initedFor === entity,
    variants,
    selectedName,
    setSelectedName,
    applyVariant,
    dirty: !sameDef(spec, selectedDef),
    isAdmin,
    readOnly,
    save,
    remove,
    setWidths,
  };
}

export type ListSpec = ReturnType<typeof useListSpec>;
