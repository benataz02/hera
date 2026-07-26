import { useRef } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import type { ModelDef } from "@hera/config-engine";
import { orpc } from "../../orpc.ts";

// Only domain refs and queryTables affect lookup resolution. Sending this skeleton (instead of
// the full draft) keeps the TanStack query key stable while the admin types expressions, so the
// agent is only hit when a lookup source actually changes.
export function lookupSkeleton(d: ModelDef): ModelDef {
  return {
    name: "",
    parameters: d.parameters.map((p) => ({ key: p.key, label: "", type: p.type, ui: p.ui, domain: p.domain })),
    structure: { sections: [] },
    computed: [],
    constraints: [],
    bom: [],
    routing: [],
    // A just-added query has an empty path; fetching it throws and errors out the whole resolve,
    // blanking every other domain. It can't resolve to anything anyway — drop it.
    queryTables: d.queryTables.filter((q) => q.path),
    pricing: { priceExpr: "0", quoteItemCode: "X" },
    batchDefaults: [1],
  };
}

// Query paths are edited per keystroke but only Test fetch *commits* one — it's the sole writer of
// a query's `columns`. Keying on the committed bits (targets + columns + every domain ref) means a
// half-typed path never reaches the agent; the rebuild then picks up whatever paths/names the draft
// currently has. Trade-off: renaming a query alone shows up in the preview on the next commit.
export const commitKey = (d: ModelDef) => JSON.stringify([
  d.parameters.map((p) => [p.key, p.type, p.ui, p.domain]),
  d.queryTables.map((q) => [q.target, q.columns]),
]);

export function usePreviewLookups(draft: ModelDef) {
  const key = commitKey(draft);
  // useRef, not useMemo: React may drop a memo cache, and that would send the in-progress path.
  const pinned = useRef<{ key: string; definition: ModelDef } | null>(null);
  if (!pinned.current || pinned.current.key !== key) pinned.current = { key, definition: lookupSkeleton(draft) };

  return useQuery({
    ...orpc.models.previewLookups.queryOptions({ input: { definition: pinned.current.definition } }),
    staleTime: 5 * 60_000, // matches the server-side configs.lookups cache window
    retry: false, // agent-offline should show its message, not spin
    placeholderData: keepPreviousData, // editing a query source keeps loaded fields visible instead of blanking
  });
}
