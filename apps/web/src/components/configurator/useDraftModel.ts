import { useDeferredValue, useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { checkModel, type Issue, type ModelDef, type Val } from "@hera/config-engine";
import { orpc } from "../../orpc.ts";
import { toast } from "../toast.ts";

export type TabKey = "params" | "rules" | "bom" | "routing" | "tables" | "history" | "settings";

export type TableCol = { key: string; label: string; type: "string" | "number" | "boolean" };
// config_table cells are scalar (ValZ), unlike the full Val union which includes string[].
export type TableCell = Exclude<Val, string[]>;
export type TableDraft = { id?: string; name: string; columns: TableCol[]; rows: TableCell[][] };
// Pending edits key by server id; one unsaved new table at a time keys by this.
export const NEW_TABLE_KEY = "new";

export const issueFor = (issues: Issue[], path: string) => issues.find((i) => i.path === path);

function colKeys(columns: unknown): string[] {
  if (!Array.isArray(columns)) return [];
  const keys: string[] = [];
  for (const c of columns) {
    if (typeof c === "string") keys.push(c);
    else if (c && typeof c === "object" && "key" in c && typeof c.key === "string") keys.push(c.key);
  }
  return keys;
}

export function tabOf(path: string): TabKey {
  if (path.startsWith("parameters") || path.startsWith("structure") || path.startsWith("computed") || path === "model")
    return "params";
  if (path.startsWith("constraints")) return "rules";
  if (path.startsWith("bom")) return "bom";
  if (path.startsWith("routing")) return "routing";
  if (path.startsWith("history")) return "history";
  if (path.startsWith("tables")) return "tables";
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
  // Lookup tables are their own server rows, but the builder saves them with the model's Save
  // button. Edits buffer here per table and flush on save, so switching tables in the Tables tab
  // (or leaving the tab) keeps them, and one Save commits the lot.
  const [tableEdits, setTableEdits] = useState<Record<string, TableDraft>>({});

  useEffect(() => {
    if (rec.data && draft === null) setDraft(rec.data.definition);
  }, [rec.data, draft]);

  useEffect(() => {
    if (rec.data && portalMeta === null)
      setPortalMetaState({ portal: rec.data.portal, portalDescription: rec.data.portalDescription ?? "" });
  }, [rec.data, portalMeta]);

  const tables = tablesQ.data ?? [];
  const tableCols = useMemo(
    () => tables.map((t) => ({ name: t.name, columns: colKeys(t.columns) })),
    [tables],
  );
  // Commit model: dialogs (ParamDialog, ComboTableDialog) buffer edits and commit on OK; inline
  // editors (RulesTab, SettingsTab, title edits) mutate this draft directly per keystroke. Validation
  // runs against a deferred draft so checkModel lags fast typing instead of blocking every keystroke.
  const deferredDraft = useDeferredValue(draft);
  const modelIssues = useMemo(
    () => (deferredDraft ? checkModel(deferredDraft, tableCols) : []),
    [deferredDraft, tableCols],
  );

  // The same rules models.tables.save enforces, checked here so a bad pending table disables Save
  // and shows a count on the Tables tab instead of failing server-side mid-flush.
  const tableIssues = useMemo<Issue[]>(() => {
    const out: Issue[] = [];
    for (const [key, t] of Object.entries(tableEdits)) {
      const at = (message: string) => out.push({ path: `tables.${key}`, message });
      const label = t.name.trim() || "New lookup table";
      if (!t.name.trim()) at("Lookup table needs a name");
      if (!t.columns.length) at(`"${label}" needs at least one column`);
      if (t.columns.some((c) => !c.key.trim())) at(`"${label}" has a column with no key`);
      if (t.rows.some((r) => r.length !== t.columns.length))
        at(`"${label}" has a row that doesn't match its columns`);
    }
    return out;
  }, [tableEdits]);

  const issues = useMemo(() => [...modelIssues, ...tableIssues], [modelIssues, tableIssues]);

  const tableSaveMut = useMutation(orpc.models.tables.save.mutationOptions());

  const saveMut = useMutation(
    orpc.models.save.mutationOptions({
      onSuccess: (row) => {
        setDirty(false);
        setServerIssues([]);
        qc.invalidateQueries({ queryKey: orpc.models.list.queryOptions().queryKey });
        // save RETURNs the saved row, so seed the cache with it instead of refetching models.get.
        qc.setQueryData(orpc.models.get.queryOptions({ input: { id } }).queryKey, row);
        toast("Model saved");
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
    dirty: dirty || Object.keys(tableEdits).length > 0,
    portalMeta,
    setPortalMeta: (p: { portal: boolean; portalDescription: string }) => {
      setPortalMetaState(p);
      setDirty(true);
    },
    tableEdits,
    editTable: (key: string, d: TableDraft | null) =>
      setTableEdits((m) => {
        if (d) return { ...m, [key]: d };
        if (!(key in m)) return m;
        return Object.fromEntries(Object.entries(m).filter(([k]) => k !== key));
      }),
    save: async () => {
      if (!draft || !portalMeta) return;
      // Pending lookup tables go first: they're separate server rows and the likeliest rejection
      // (duplicate name), so a failure here leaves the model untouched rather than half-saved.
      try {
        for (const t of Object.values(tableEdits)) {
          await tableSaveMut.mutateAsync({
            id: t.id, name: t.name.trim(), columns: t.columns, rows: t.rows,
          });
        }
      } catch {
        return; // surfaced through saveError
      }
      if (Object.keys(tableEdits).length) {
        setTableEdits({});
        qc.invalidateQueries({ queryKey: orpc.models.tables.list.queryOptions().queryKey });
      }
      saveMut.mutate({
        id, definition: draft,
        portal: portalMeta.portal, portalDescription: portalMeta.portalDescription || null,
      });
    },
    saving: saveMut.isPending || tableSaveMut.isPending,
    saveError: (tableSaveMut.error ?? saveMut.error) as Error | null,
    loading: rec.isPending,
    loadError: rec.error as Error | null,
    tableCols,
    savedQueryTables: rec.data?.definition.queryTables ?? [],
  };
}
