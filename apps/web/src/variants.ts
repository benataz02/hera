import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { orpc } from "./orpc.ts";

export type { ListVariantDef, ObjectVariantDef, FilterCond, FilterOp } from "@hera/db";

// VariantManagement's dialog flags come back as boolean | "true" | "false" (string-bool). Coerce.
export const truthy = (v: unknown): boolean => v === true || v === "true";

// Dirty = live view differs from the saved one. JSON compare is order-sensitive, which is what we
// want — column/sort/filter order are meaningful parts of the view.
// ponytail: structural compare via JSON.stringify; specs are built deterministically.
export const sameDef = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

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
