import { useRef, useState } from "react";
import { useBlocker } from "@tanstack/react-router";
import {
  Bar, Button, BusyIndicator, MessageStrip,
  ObjectPage, ObjectPageSection, ObjectPageTitle, ObjectStatus,
  SplitterElement, SplitterLayout, Title, ToggleButton,
  Toolbar,
} from "@ui5/webcomponents-react";
import type { Entries, Issue, ModelDef } from "@hera/config-engine";
import { tabOf, useDraftModel, type TabKey } from "./useDraftModel.ts";
import { confirm } from "../confirm.ts";
import { SettingsTab } from "./SettingsTab.tsx";
import { ParamsTab } from "./ParamsTab.tsx";
import { RulesTab } from "./RulesTab.tsx";
import { BomTab, RoutingTab } from "./LinesTabs.tsx";
import { TablesTab } from "./TablesTab.tsx";
import { HistoryTab } from "./HistoryTab.tsx";
import { ConfiguratorForm, ConsistencyStatus } from "./ConfiguratorForm.tsx";
import { usePreviewLookups } from "./usePreviewLookups.ts";

// Tab components mount their own editors now; the preview pane test-drives the draft.

// Stable placeholder so usePreviewLookups runs unconditionally (rules of hooks) before the
// draft has loaded; resolves to empty domains/tables without touching the agent.
const EMPTY_MODEL: ModelDef = {
  name: "", parameters: [], structure: { sections: [] }, computed: [], constraints: [],
  bom: [], routing: [], queryTables: [], pricing: { priceExpr: "0", quoteItemCode: "X" }, batchDefaults: [1],
};

// Slide the preview pane open/closed by animating its flex-basis (see the SplitterLayout below).
const PANE_ANIM = "flex-basis 0.28s cubic-bezier(0.2, 0, 0, 1)";

export function ModelBuilderPage({ id }: { id: string }) {
  const m = useDraftModel(id);
  const [tab, setTab] = useState<TabKey>("params");
  
  const [previewOpen, setPreviewOpen] = useState(true);
  // Animate flex-basis only during a button toggle, never while dragging the splitter (drag mutates the
  // size directly, and a transition there would feel laggy). Cleared on the slide's transitionend.
  const [animating, setAnimating] = useState(false);
  
  const togglePreview = () => {
    setAnimating(true);
    setPreviewOpen((v) => !v);
  };

  // Guard against losing an unsaved draft: intercept in-app navigation (including switching models,
  // which remounts via key={id}) and confirm; enableBeforeUnload covers hard reload / tab close.
  useBlocker({
    shouldBlockFn: async () => {
      if (!m.dirty || m.saving) return false;
      return !(await confirm({
        title: "Discard changes?",
        message: "This model has unsaved changes. Leave without saving?",
        actionText: "Discard",
        destructive: true,
      }));
    },
    enableBeforeUnload: () => m.dirty,
  });

  // The preview test-drives the draft with the real engine. While the draft has errors we keep
  // rendering the last valid one so a single bad keystroke doesn't blank the form.
  const [entries, setEntries] = useState<Entries>({});
  const lastGood = useRef<ModelDef>(EMPTY_MODEL);
  if (m.draft && m.issues.length === 0) lastGood.current = m.draft;
  const previewModel = m.draft && m.issues.length === 0 ? m.draft : lastGood.current;

  // Same lookups feed the preview form and RulesTab's combo-table cells.
  const lookups = usePreviewLookups(previewModel);
  const allIssues: Issue[] = [...m.issues, ...m.serverIssues];
  const count = (t: TabKey) => allIssues.filter((i) => tabOf(i.path) === t).length;

  if (m.loading || !m.draft || !m.portalMeta) {
    return m.loadError
      ? <MessageStrip design="Negative" hideCloseButton style={{ margin: "1rem" }}>{m.loadError.message}</MessageStrip>
      : <BusyIndicator active delay={0} style={{ width: "100%", marginTop: "4rem" }} />;
  }
  const draft = m.draft;
  const portalMeta = m.portalMeta;

  // Anchor-bar label carries the section's open issue count, e.g. "Rules (2)".
  const secTitle = (label: string, key: TabKey) => (count(key) ? `${label} (${count(key)})` : label);

  return (
    // SplitterElement.size maps to flex-basis (grow:0), so we drive width from explicit sizes and keep
    // BOTH panes mounted — animating flex-basis slides the preview open/closed instead of snapping.
    // Collapsed = 0% width, no min-size, resizer hidden (preview not resizable) so no stray splitter bar.
    <SplitterLayout 
      style={{ height: "100%", width: "100%" }}
      onTransitionEnd={(e) => { if (e.propertyName === "flex-basis") setAnimating(false); }}
    >
      <SplitterElement 
        size={previewOpen ? "58%" : "100%"} 
        minSize={480}
        style={{ transition: animating ? PANE_ANIM : undefined }}
      >

          {m.saveError ? (
            <MessageStrip design="Negative" hideCloseButton>
              {m.serverIssues.length > 0
                ? `Save failed — ${m.serverIssues.length} issue${m.serverIssues.length === 1 ? "" : "s"}; see the tab counts.`
                : m.saveError.message}
            </MessageStrip>
          ) : null}

          <ObjectPage
            mode="IconTabBar"
            selectedSectionId={tab}
            onSelectedSectionChange={(e) => setTab(e.detail.selectedSectionId as TabKey)}
            titleArea={
              <ObjectPageTitle header={<Title level="H4">{draft.name || "Untitled model"}</Title>}
                subHeader={m.dirty ? <ObjectStatus state="Critical">Unsaved changes</ObjectStatus> : undefined}
                actionsBar={
                  <Toolbar design="Transparent">
                    <ToggleButton icon="show" pressed={previewOpen} onClick={togglePreview}>
                      Preview
                    </ToggleButton>
                    <Button design="Emphasized" disabled={m.issues.length > 0 || !m.dirty || m.saving} onClick={m.save}>
                      {m.saving ? "Saving…" : "Save"}
                    </Button>
                  </Toolbar>
                }
              />
            }
          >
            <ObjectPageSection id="params" titleText={secTitle("Parameters", "params")}>
              <ParamsTab draft={draft} update={m.update} issues={allIssues} tables={m.tables} />
            </ObjectPageSection>
            <ObjectPageSection id="rules" titleText={secTitle("Rules", "rules")}>
              <RulesTab draft={draft} update={m.update} issues={allIssues} lookups={lookups.data} />
            </ObjectPageSection>
            <ObjectPageSection id="bom" titleText={secTitle("BOM", "bom")}>
              <BomTab draft={draft} update={m.update} issues={allIssues} />
            </ObjectPageSection>
            <ObjectPageSection id="routing" titleText={secTitle("Routing", "routing")}>
              <RoutingTab draft={draft} update={m.update} issues={allIssues} />
            </ObjectPageSection>
            <ObjectPageSection id="tables" titleText="Tables"><TablesTab draft={draft} update={m.update} /></ObjectPageSection>
            <ObjectPageSection id="history" titleText={secTitle("History", "history")}>
              <HistoryTab draft={draft} update={m.update} issues={allIssues} modelId={id} dirty={m.dirty} />
            </ObjectPageSection>
            <ObjectPageSection id="settings" titleText={secTitle("Settings", "settings")}>
              <SettingsTab draft={draft} update={m.update} issues={allIssues}
                portalMeta={portalMeta} setPortalMeta={m.setPortalMeta} />
            </ObjectPageSection>
          </ObjectPage>

      </SplitterElement>
      <SplitterElement 
        size={previewOpen ? "42%" : "0%"} 
        minSize={previewOpen ? 320 : 0}
        resizable={previewOpen}
        style={{ transition: animating ? PANE_ANIM : undefined }}
      >
        <div style={{ flex: 1, minWidth: 0, height: "100%", display: "flex", flexDirection: "column", minHeight: 0, opacity: previewOpen ? 1 : 0, transition: "opacity 0.28s ease" }}>
          {m.issues.length > 0 ? (
            <MessageStrip design="Critical" hideCloseButton>
              Showing the last valid version — fix {m.issues.length} error{m.issues.length === 1 ? "" : "s"} to preview the current draft.
            </MessageStrip>
          ) : null}
          {lookups.error ? (
            <div style={{ padding: "0 1rem", display: "flex", alignItems: "center", gap: "0.5rem" }}>
              <MessageStrip design="Negative" hideCloseButton style={{ flex: 1 }}>{lookups.error.message}</MessageStrip>
              <Button onClick={() => lookups.refetch()}>Retry</Button>
            </div>
          ) : null}
          <div style={{ flex: 1, overflowY: "auto", minHeight: 0, padding: "0 1rem 1rem" }}>
            <ConfiguratorForm model={previewModel} lookups={lookups.data} entries={entries} onChange={setEntries}
              loading={lookups.isFetching} />
          </div>
          <Bar design="Footer"
            startContent={<ConsistencyStatus model={previewModel} lookups={lookups.data} entries={entries} />} />
        </div>
      </SplitterElement>
    </SplitterLayout>
  );
}