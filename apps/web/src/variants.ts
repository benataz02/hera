import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { orpc } from "./orpc.ts";
import { EMPTY_SPEC, sameDef, type ListVariantDef, type FilterCond, type FilterOp } from "./listSpec.ts";

// The pure list-view logic lives in listSpec.ts (no orpc import, so it's unit-testable); re-exported
// here so pages have a single import path.
export * from "./listSpec.ts";

export type VariantPage = "list" | "object";

// One place for the variant query + mutations so both pages stay thin.
export function useVariants(page: VariantPage, entity: string) {
  const qc = useQueryClient();
  const opts = orpc.variants.list.queryOptions({ input: { page, entity } });
  const query = useQuery(opts);
  const invalidate = () => qc.invalidateQueries({ queryKey: opts.queryKey });
  const save = useMutation(orpc.variants.save.mutationOptions({ onSuccess: invalidate }));
  const remove = useMutation(orpc.variants.remove.mutationOptions({ onSuccess: invalidate }));
  const setWidths = useMutation(orpc.variants.setWidths.mutationOptions());
  return {
    variants: query.data?.variants ?? [],
    isAdmin: query.data?.isAdmin ?? false,
    isLoading: query.isPending,
    save,
    remove,
    setWidths,
  };
}

// The applied view: it drives the query, the dirty marker and what a Save persists. Owned here so
// the page can run its own query off `spec` while ListReport renders the chrome from the same state.
export function useListSpec(entity: string) {
  const { variants, isAdmin, isLoading, save, remove, setWidths } = useVariants("list", entity);
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
    save,
    remove,
    setWidths,
  };
}

export type ListSpec = ReturnType<typeof useListSpec>;
