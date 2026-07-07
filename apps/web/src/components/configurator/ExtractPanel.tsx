import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import {
  BusyIndicator, Button, FileUploader, List, ListItemCustom, MessageStrip, ObjectStatus, Panel, Text,
} from "@ui5/webcomponents-react";
import type { Entries, ModelDef, Val } from "@hera/config-engine";
import { orpc } from "../../orpc.ts";

// Upload a customer drawing → server-side Gemini extraction → per-parameter suggestions.
// Suggest-and-confirm: values enter `entries` only through an explicit Accept click; invalid
// (out-of-domain) suggestions render with their reason and no Accept action.

const MAX_BYTES = 15 * 1024 * 1024;
const MIME_BY_EXT: Record<string, "application/pdf" | "image/png" | "image/jpeg"> = {
  pdf: "application/pdf", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
};

async function toBase64(f: File): Promise<string> {
  const buf = new Uint8Array(await f.arrayBuffer());
  let bin = "";
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return btoa(bin);
}

type Suggestion = { paramKey: string; value: Val; evidence: string; valid: boolean; reason?: string };

export function ExtractPanel({ modelId, model, entries, onChange }: {
  modelId: string;
  model: ModelDef;
  entries: Entries;
  onChange: (next: Entries) => void;
}) {
  const [fileError, setFileError] = useState<string | null>(null);
  const [handled, setHandled] = useState<Set<string>>(new Set()); // accepted or dismissed paramKeys
  const extract = useMutation(orpc.extraction.extract.mutationOptions({ onSuccess: () => setHandled(new Set()) }));

  const pick = async (file: File | null | undefined) => {
    setFileError(null);
    if (!file) return;
    const mimeType = MIME_BY_EXT[file.name.split(".").pop()?.toLowerCase() ?? ""];
    if (!mimeType) return setFileError("Only PDF, PNG or JPEG drawings are supported.");
    if (file.size > MAX_BYTES) return setFileError("The file exceeds the 15MB limit.");
    extract.mutate({ modelId, file: { name: file.name, mimeType, dataBase64: await toBase64(file) } });
  };

  const accept = (list: Suggestion[]) => {
    const next = { ...entries };
    for (const s of list) {
      const p = model.parameters.find((x) => x.key === s.paramKey);
      next[s.paramKey] = p?.ui === "multicombo" ? [String(s.value)] : s.value; // multicombo entries are string[]
    }
    onChange(next);
    setHandled((h) => new Set([...h, ...list.map((s) => s.paramKey)]));
  };
  const dismiss = (key: string) => setHandled((h) => new Set([...h, key]));

  const suggestions: Suggestion[] = extract.data?.suggestions ?? [];
  const open = suggestions.filter((s) => !handled.has(s.paramKey));
  const openValid = open.filter((s) => s.valid);
  const labelOf = (key: string) => model.parameters.find((p) => p.key === key)?.label ?? key;

  return (
    <Panel headerText="Extract from drawing" fixed>
      <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
        <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
          <FileUploader hideInput accept=".pdf,.png,.jpg,.jpeg" disabled={extract.isPending}
            onChange={(e) => void pick(e.target.files?.[0])}>
            <Button icon="upload">Upload drawing</Button>
          </FileUploader>
          {extract.isPending ? <BusyIndicator active delay={0} size="S" text="Reading drawing…" /> : null}
          {openValid.length > 1 ? (
            <Button design="Emphasized" onClick={() => accept(openValid)}>Accept all valid ({openValid.length})</Button>
          ) : null}
        </div>

        {fileError ? <MessageStrip design="Negative" hideCloseButton>{fileError}</MessageStrip> : null}
        {extract.error ? (
          <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
            <MessageStrip design="Negative" hideCloseButton>{extract.error.message}</MessageStrip>
            <Button style={{ alignSelf: "start" }} onClick={() => extract.mutate(extract.variables!)}>Retry</Button>
          </div>
        ) : null}
        {extract.isSuccess && suggestions.length === 0 ? (
          <Text>Nothing could be extracted from this drawing.</Text>
        ) : null}

        {open.length ? (
          <List>
            {open.map((s) => (
              <ListItemCustom key={s.paramKey}>
                <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", width: "100%", padding: "0.25rem 0" }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <Text style={{ fontWeight: "bold" }}>{labelOf(s.paramKey)}: {String(s.value)}</Text>
                    <Text style={{ display: "block", fontSize: "0.8rem" }}>{s.evidence}</Text>
                    {!s.valid ? <ObjectStatus state="Negative">{s.reason}</ObjectStatus> : null}
                  </div>
                  {s.valid ? <Button design="Positive" onClick={() => accept([s])}>Accept</Button> : null}
                  <Button design="Transparent" onClick={() => dismiss(s.paramKey)}>Dismiss</Button>
                </div>
              </ListItemCustom>
            ))}
          </List>
        ) : null}
      </div>
    </Panel>
  );
}
