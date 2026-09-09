import { useBlocker } from "@tanstack/react-router";
import {
  Button, BusyIndicator, MessageStrip,
  ObjectPage, ObjectPageSection, ObjectPageTitle, ObjectStatus,
  Title, Toolbar,
} from "@ui5/webcomponents-react";
import type { Issue, ModelDef } from "@hera/config-engine";
import { tabOf, useDraftModel, type TabKey } from "./useDraftModel.ts";
import { useSectionParam } from "../../sectionParam.ts";
import { confirm } from "../confirm.ts";
import { SettingsTab } from "./SettingsTab.tsx";
import { ParamsTab } from "./ParamsTab.tsx";
import { RulesTab } from "./RulesTab.tsx";
import { TablesTab } from "./TablesTab.tsx";
import { BomTab, RoutingTab } from "./LinesTabs.tsx";
import { HistoryTab } from "./HistoryTab.tsx";
import { usePreviewLookups } from "./usePreviewLookups.ts";

// Stable placeholder so usePreviewLookups runs unconditionally (rules of hooks) before the
// draft has loaded; enabled:false until then, so it never hits the agent.
const EMPTY_MODEL: ModelDef = {
  name: "", parameters: [], structure: { sections: [] }, computed: [], constraints: [],
  bom: [], routing: [], pricing: { priceExpr: "0", quoteItemCode: "X" }, batchDefaults: [1],
};

// Section ids, in render order — also the allow-list for `?section=` (a stale link must not
// select a tab that no longer exists, which would render an empty page).
const TABS: TabKey[] = ["params", "rules", "tables", "bom", "routing", "history", "settings"];

export function ModelBuilderPage({ id }: { id: string }) {
  const m = useDraftModel(id);
  const [section, setSection] = useSectionParam();
  const tab = TABS.includes(section as TabKey) ? (section as TabKey) : "params";

  // Guard against losing an unsaved draft: intercept in-app navigation (including switching models,
  // which remounts via key={id}) and confirm; enableBeforeUnload covers hard reload / tab close.
  useBlocker({
    shouldBlockFn: async ({ current, next }) => {
      // Switching tabs is a search-param navigation on this same page (see useSectionParam) —
      // never a reason to prompt; only leaving the builder is.
      if (current.pathname === next.pathname) return false;
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

  // Same lookups feed the params preview and RulesTab's combo-table cells. Query definitions are
  // tenant masterdata, so nothing about the unsaved draft affects them.
  const lookups = usePreviewLookups(m.draft ?? EMPTY_MODEL, { enabled: tab === "params" && !!m.draft });
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
    <div style={{ height: "100%", display: "flex", flexDirection: "column" }}>
      {m.saveError ? (
        <MessageStrip design="Negative" hideCloseButton>
          {m.serverIssues.length > 0
            ? `Save failed — ${m.serverIssues.length} issue${m.serverIssues.length === 1 ? "" : "s"}; see the tab counts.`
            : m.saveError.message}
        </MessageStrip>
      ) : null}

      <ObjectPage
        style={{ flex: 1, minHeight: 0, height: "100%" }}
        mode="IconTabBar"
        selectedSectionId={tab}
        onSelectedSectionChange={(e) => setSection(e.detail.selectedSectionId)}
        titleArea={
          <ObjectPageTitle header={<Title level="H4">{draft.name || "Untitled model"}</Title>}
            subHeader={m.dirty ? <ObjectStatus state="Critical">Unsaved changes</ObjectStatus> : undefined}
            actionsBar={
              <Toolbar design="Transparent">
                <Button design="Emphasized" disabled={m.issues.length > 0 || !m.dirty || m.saving} onClick={() => void m.save()}>
                  {m.saving ? "Saving…" : "Save"}
                </Button>
              </Toolbar>
            }
          />
        }
      >
        <ObjectPageSection id="params" titleText={secTitle("Parameters", "params")}>
          <ParamsTab modelId={id} draft={draft} update={m.update} issues={allIssues} tables={m.tableCols}
            lookups={lookups.data} lookupsError={lookups.error} onRetryLookups={() => void lookups.refetch()} />
        </ObjectPageSection>
        <ObjectPageSection id="rules" titleText={secTitle("Rules", "rules")}>
          <RulesTab draft={draft} update={m.update} issues={allIssues} lookups={lookups.data} tables={m.tableCols} />
        </ObjectPageSection>
        <ObjectPageSection id="tables" titleText={secTitle("Tables", "tables")}>
          <TablesTab draft={draft} update={m.update} issues={allIssues} tables={m.tableCols} />
        </ObjectPageSection>
        <ObjectPageSection id="bom" titleText={secTitle("BOM", "bom")}>
          <BomTab draft={draft} update={m.update} issues={allIssues} tables={m.tableCols} />
        </ObjectPageSection>
        <ObjectPageSection id="routing" titleText={secTitle("Routing", "routing")}>
          <RoutingTab draft={draft} update={m.update} issues={allIssues} tables={m.tableCols} />
        </ObjectPageSection>
        <ObjectPageSection id="history" titleText={secTitle("History", "history")}>
          <HistoryTab draft={draft} update={m.update} issues={allIssues} modelId={id} dirty={m.dirty} />
        </ObjectPageSection>
        <ObjectPageSection id="settings" titleText={secTitle("Settings", "settings")}>
          <SettingsTab draft={draft} update={m.update} issues={allIssues} tables={m.tableCols}
            portalMeta={portalMeta} setPortalMeta={m.setPortalMeta} />
        </ObjectPageSection>
      </ObjectPage>
    </div>
  );
}
