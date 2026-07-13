import { useState } from "react";
import {
  Button, BusyIndicator, MessageStrip,
  ObjectPage, ObjectPageSection, ObjectPageTitle, ObjectStatus,
  SplitterElement, SplitterLayout, Title, ToggleButton,
  Toolbar,
} from "@ui5/webcomponents-react";
import type { Issue, ModelDef } from "@hera/config-engine";
import { tabOf, useDraftModel, type TabKey } from "./useDraftModel.ts";
import { SettingsTab } from "./SettingsTab.tsx";
import { ParamsTab } from "./ParamsTab.tsx";
import { RulesTab } from "./RulesTab.tsx";
import { BomTab, RoutingTab } from "./LinesTabs.tsx";
import { TablesTab } from "./TablesTab.tsx";
import { PreviewPane } from "./PreviewPane.tsx";
import { usePreviewLookups } from "./usePreviewLookups.ts";
import "./ModelBuilderPage.css";

// Tab components mount their own editors now; the preview pane test-drives the draft.

// Stable placeholder so usePreviewLookups runs unconditionally (rules of hooks) before the
// draft has loaded; resolves to empty domains/tables without touching the agent.
const EMPTY_MODEL: ModelDef = {
  name: "", parameters: [], structure: { sections: [] }, computed: [], constraints: [],
  bom: [], routing: [], queryTables: [], pricing: { priceExpr: "0", quoteItemCode: "X" }, batchDefaults: [1],
};

export function ModelBuilderPage({ id }: { id: string }) {
  const m = useDraftModel(id);
  const [tab, setTab] = useState<TabKey>("params");
  const [previewOpen, setPreviewOpen] = useState(true);
  // previewRender lags previewOpen: it stays true through the slide-out so the exit animation plays,
  // then onAnimationEnd unmounts the pane (and lets the editor reclaim full width).
  const [previewRender, setPreviewRender] = useState(true);
  const togglePreview = () =>
    previewOpen ? setPreviewOpen(false) : (setPreviewRender(true), setPreviewOpen(true));
  // Shared with PreviewPane by query key (same skeleton) — RulesTab combo-table cells use its domains.
  const lookups = usePreviewLookups(m.draft ?? EMPTY_MODEL);
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
    // Signature layout: editor left, live test-drive right. Preview toggles off to give the editor
    // full width; toggling on slides it back in (SplitterElement can't animate, so we render/unrender).
    <SplitterLayout style={{ height: "100%", width: "100%" }}>
      <SplitterElement size={previewRender ? "58%" : "100%"} minSize={480}>

          {m.saveError && m.serverIssues.length === 0 ? (
            <MessageStrip design="Negative" hideCloseButton>{m.saveError.message}</MessageStrip>
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
            <ObjectPageSection id="settings" titleText={secTitle("Settings", "settings")}>
              <SettingsTab draft={draft} update={m.update} issues={allIssues}
                portalMeta={portalMeta} setPortalMeta={m.setPortalMeta} />
            </ObjectPageSection>
          </ObjectPage>

      </SplitterElement>
      {previewRender ? (
        <SplitterElement minSize={320}>
          <div
            className={previewOpen ? "preview-pane-slide-in" : "preview-pane-slide-out"}
            // Own animation only (onAnimationEnd bubbles from UI5 children); unmount after slide-out.
            onAnimationEnd={(e) => {
              if (e.target === e.currentTarget && !previewOpen) setPreviewRender(false);
            }}
          >
            <PreviewPane draft={draft} issues={m.issues} />
          </div>
        </SplitterElement>
      ) : null}
    </SplitterLayout>
  );
}
