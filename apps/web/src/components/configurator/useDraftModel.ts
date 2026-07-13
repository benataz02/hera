import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { checkModel, type Issue, type ModelDef } from "@hera/config-engine";
import { orpc } from "../../orpc.ts";

export type TabKey = "params" | "rules" | "bom" | "routing" | "tables" | "settings";

export const issueFor = (issues: Issue[], path: string) => issues.find((i) => i.path === path);

export function tabOf(path: string): TabKey {
  if (path.startsWith("parameters") || path.startsWith("structure") || path.startsWith("computed") || path === "model")
    return "params";
  if (path.startsWith("constraints")) return "rules";
  if (path.startsWith("bom")) return "bom";
  if (path.startsWith("routing")) return "routing";
  return "settings"; // pricing.*
}

// One draft ModelDef in memory; checkModel on every change is the same gate the server runs
// on save, so "0 issues" here means the save cannot be rejected for model errors.
export function useDraftModel(id: string) {
  const qc = useQueryClient();
  const rec = useQuery(orpc.models.get.queryOptions({ input: { id } }));
  const tablesQ = useQuery(orpc.models.tables.list.queryOptions());
  const [draft, setDraft] = useState<ModelDef | null>(null);
  const [dirty, setDirty] = useState(false);
  const [serverIssues, setServerIssues] = useState<Issue[]>([]);
  const [portalMeta, setPortalMetaState] = useState<{ portal: boolean; portalDescription: string } | null>(null);

  useEffect(() => {
    if (rec.data && draft === null) setDraft(rec.data.definition);
  }, [rec.data, draft]);

  useEffect(() => {
    if (rec.data && portalMeta === null)
      setPortalMetaState({ portal: rec.data.portal, portalDescription: rec.data.portalDescription ?? "" });
  }, [rec.data, portalMeta]);

  const tables = tablesQ.data ?? [];
  const issues = useMemo(
    () => (draft ? checkModel(draft, tables.map((t) => t.name)) : []),
    [draft, tables],
  );

  const saveMut = useMutation(
    orpc.models.save.mutationOptions({
      onSuccess: () => {
        setDirty(false);
        setServerIssues([]);
        qc.invalidateQueries({ queryKey: orpc.models.list.queryOptions().queryKey });
        qc.invalidateQueries({ queryKey: orpc.models.get.queryOptions({ input: { id } }).queryKey });
      },
      onError: (e) => {
        // models.save rejects invalid definitions with BAD_REQUEST + data.issues (span Issues).
        const data = (e as { data?: { issues?: Issue[] } }).data;
        setServerIssues(data?.issues ?? []);
      },
    }),
  );

  return {
    draft,
    update: (fn: (d: ModelDef) => ModelDef) => {
      setDraft((d) => (d ? fn(d) : d));
      setDirty(true);
      setServerIssues([]);
    },
    issues,
    serverIssues,
    dirty,
    portalMeta,
    setPortalMeta: (p: { portal: boolean; portalDescription: string }) => {
      setPortalMetaState(p);
      setDirty(true);
    },
    save: () => draft && portalMeta && saveMut.mutate({
      id, definition: draft,
      portal: portalMeta.portal, portalDescription: portalMeta.portalDescription || null,
    }),
    saving: saveMut.isPending,
    saveError: saveMut.error as Error | null,
    loading: rec.isPending,
    loadError: rec.error as Error | null,
    tables,
  };
}
