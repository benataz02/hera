import { useState } from "react";
import {
  Bar, Button, BusyIndicator, MessageStrip, MessageItem, MessageView, MessageViewButton,
  ObjectStatus, ResponsivePopover, SplitterElement, SplitterLayout, Tab, TabContainer, Text, Title,
} from "@ui5/webcomponents-react";
import type { Issue } from "@hera/config-engine";
import { tabOf, useDraftModel, type TabKey } from "./useDraftModel.ts";
import { SettingsTab } from "./SettingsTab.tsx";
import { ParamsTab } from "./ParamsTab.tsx";

// Tab components land in Tasks 5-9; until then a stub renders in their place.
const Stub = ({ name }: { name: string }) => <Text style={{ padding: "1rem" }}>{name} — next task.</Text>;

export function ModelBuilderPage({ id }: { id: string }) {
  const m = useDraftModel(id);
  const [tab, setTab] = useState<TabKey>("params");
  const [msgOpen, setMsgOpen] = useState(false);
  const allIssues: Issue[] = [...m.issues, ...m.serverIssues];
  const count = (t: TabKey) => allIssues.filter((i) => tabOf(i.path) === t).length;

  if (m.loading || !m.draft) {
    return m.loadError
      ? <MessageStrip design="Negative" hideCloseButton style={{ margin: "1rem" }}>{m.loadError.message}</MessageStrip>
      : <BusyIndicator active delay={0} style={{ width: "100%", marginTop: "4rem" }} />;
  }
  const draft = m.draft;

  // Jump from a MessageView item to its field: switch tab, then focus by the expr-<path> id.
  const jumpTo = (path: string) => {
    setTab(tabOf(path));
    setMsgOpen(false);
    setTimeout(() => document.getElementById(`expr-${path}`)?.focus(), 120);
  };

  const tabProps = (key: TabKey, text: string) => ({
    text,
    "data-key": key,
    selected: tab === key,
    additionalText: count(key) ? String(count(key)) : undefined,
    design: count(key) ? ("Negative" as const) : ("Default" as const),
  });

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column" }}>
      <Bar
        design="Header"
        startContent={
          <>
            <Title level="H4">{draft.name || "Untitled model"}</Title>
            {m.dirty ? <ObjectStatus state="Critical">Unsaved changes</ObjectStatus> : null}
          </>
        }
        endContent={
          <>
            <MessageViewButton id="model-msgs" counter={allIssues.length}
              type={allIssues.length ? "Negative" : "Positive"} onClick={() => setMsgOpen((o) => !o)} />
            <Button design="Emphasized" disabled={m.issues.length > 0 || !m.dirty || m.saving} onClick={m.save}>
              {m.saving ? "Saving…" : "Save model"}
            </Button>
          </>
        }
      />
      {m.saveError && m.serverIssues.length === 0 ? (
        <MessageStrip design="Negative" hideCloseButton>{m.saveError.message}</MessageStrip>
      ) : null}

      <ResponsivePopover opener="model-msgs" open={msgOpen} onClose={() => setMsgOpen(false)}>
        <MessageView showDetailsPageHeader={false}>
          {allIssues.map((i, idx) => (
            <MessageItem key={idx} type="Negative" titleText={i.message} subtitleText={i.path}
              onClick={() => jumpTo(i.path)} />
          ))}
        </MessageView>
        {allIssues.length === 0 ? <Text style={{ padding: "1rem" }}>Model is valid.</Text> : null}
      </ResponsivePopover>

      {/* Signature layout: editor left, live test-drive right. */}
      <SplitterLayout style={{ flex: "1 1 0", minHeight: 0, width: "100%" }}>
        <SplitterElement size="58%" minSize={480}>
          <TabContainer
            style={{ height: "100%", width: "100%" }}
            contentBackgroundDesign="Transparent"
            onTabSelect={(e) => setTab(((e.detail.tab as HTMLElement).dataset.key ?? "params") as TabKey)}
          >
            <Tab {...tabProps("params", "Parameters")}>
              <ParamsTab draft={draft} update={m.update} issues={allIssues} tables={m.tables} />
            </Tab>
            <Tab {...tabProps("rules", "Rules")}><Stub name="Rules" /></Tab>
            <Tab {...tabProps("bom", "BOM")}><Stub name="BOM" /></Tab>
            <Tab {...tabProps("routing", "Routing")}><Stub name="Routing" /></Tab>
            <Tab {...tabProps("tables", "Tables")}><Stub name="Tables" /></Tab>
            <Tab {...tabProps("settings", "Settings")}>
              <SettingsTab draft={draft} update={m.update} issues={allIssues} />
            </Tab>
          </TabContainer>
        </SplitterElement>
        <SplitterElement minSize={320}>
          <Stub name="Live preview (Task 9)" />
        </SplitterElement>
      </SplitterLayout>
    </div>
  );
}
