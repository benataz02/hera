import { keepPreviousData, useQuery } from "@tanstack/react-query";
import type { ModelDef } from "@hera/config-engine";
import { orpc } from "../../orpc.ts";

// Only domain refs and queryTables affect lookup resolution. Sending this skeleton (instead of
// the full draft) keeps the TanStack query key stable while the admin types expressions, so the
// agent is only hit when a lookup source actually changes. queryTables come from the last saved
// model — unsaved path edits on the Tables tab must not refetch.
export function lookupSkeleton(d: ModelDef, queryTables: ModelDef["queryTables"]): ModelDef {
  return {
    name: "",
    parameters: d.parameters.map((p) => ({ key: p.key, label: "", type: p.type, ui: p.ui, domain: p.domain })),
    structure: { sections: [] },
    computed: [],
    constraints: [],
    bom: [],
    routing: [],
    queryTables,
    pricing: { priceExpr: "0", quoteItemCode: "X" },
    batchDefaults: [1],
  };
}

export function usePreviewLookups(
  draft: ModelDef,
  { enabled, queryTables }: { enabled: boolean; queryTables: ModelDef["queryTables"] },
) {
  return useQuery({
    ...orpc.models.previewLookups.queryOptions({ input: { definition: lookupSkeleton(draft, queryTables) } }),
    enabled,
    staleTime: 5 * 60_000, // matches the server-side configs.lookups cache window
    retry: false, // agent-offline should show its message, not spin
    placeholderData: keepPreviousData, // editing a query source keeps loaded fields visible instead of blanking
  });
}
