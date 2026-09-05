import { useMemo, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  BusyIndicator, DynamicPage, DynamicPageTitle, Icon, IllustratedMessage, Input,
  List, ListItemCustom, MessageStrip, Option, Select, Tag, Title, ToggleButton, Toolbar, ToolbarButton,
} from "@ui5/webcomponents-react";
import "@ui5/webcomponents-fiori/dist/illustrations/NoEntries.js";
import { orpc } from "../../orpc.ts";

// What SAP exposes, browsable. The categories come from the ported B1 mapping; anything B1 adds
// later that the mapping has not heard of falls into "other" rather than disappearing.
const ANY = "__any__";

export function EntityCatalogPage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [category, setCategory] = useState(ANY);
  const [search, setSearch] = useState("");
  const [refreshing, setRefreshing] = useState(false);

  const list = useQuery({ ...orpc.entities.list.queryOptions({ input: {} }), retry: false, staleTime: 5 * 60_000 });
  const pinsOpts = orpc.entities.navPins.queryOptions();
  const pins = useQuery(pinsOpts);
  const setPin = useMutation(orpc.entities.setNavPin.mutationOptions({
    onSuccess: () => qc.invalidateQueries({ queryKey: pinsOpts.queryKey }),
  }));
  const pinned = useMemo(() => new Set((pins.data?.entities ?? []).map((p) => p.name)), [pins.data]);

  const entities = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (list.data?.entities ?? [])
      .filter((e) => category === ANY || e.categories.includes(category))
      .filter((e) => !q || e.name.toLowerCase().includes(q) || e.label.toLowerCase().includes(q) || e.table.toLowerCase().includes(q));
  }, [list.data, category, search]);

  return (
    <DynamicPage
      titleArea={
        <DynamicPageTitle
          heading={<Title>Entities</Title>}
          subheading={<span>{`${entities.length} entity sets`}</span>}
          actionsBar={
            <Toolbar design="Transparent">
              <ToolbarButton icon="refresh" text="Refresh from SAP" disabled={refreshing}
                onClick={async () => {
                  setRefreshing(true);
                  try { await list.refetch(); } finally { setRefreshing(false); }
                }} />
            </Toolbar>
          }
        />
      }>
      <div style={{ display: "flex", gap: "0.75rem", padding: "0 0 0.75rem", flexWrap: "wrap" }}>
        <Input icon={<Icon name="search" />} placeholder="Search entity sets" showClearIcon
          value={search} onInput={(e) => setSearch(e.target.value ?? "")} style={{ minWidth: "18rem" }} />
        <Select onChange={(e) => setCategory((e.detail.selectedOption as HTMLElement).dataset.v ?? ANY)}>
          <Option data-v={ANY} selected={category === ANY}>All areas</Option>
          {(list.data?.categories ?? []).map((c) => (
            <Option key={c} data-v={c} selected={category === c}>{c}</Option>
          ))}
        </Select>
      </div>

      {list.error ? <MessageStrip design="Negative" hideCloseButton>{list.error.message}</MessageStrip> : null}
      {list.isPending ? <BusyIndicator active delay={0} /> : null}

      {list.data && !entities.length ? (
        <IllustratedMessage name="NoEntries" design="Auto" titleText="Nothing matches"
          subtitleText="Try another business area or a different search term." />
      ) : null}

      <List onItemClick={(e) => {
        const orig = (e.detail as { originalEvent?: Event }).originalEvent?.target;
        if (orig instanceof Element && orig.closest("ui5-toggle-button")) return;
        const entity = (e.detail.item as HTMLElement).dataset.entity;
        if (entity) navigate({ to: "/b1/$entity", params: { entity } });
      }}>
        {entities.map((e) => {
          const on = pinned.has(e.name);
          return (
            <ListItemCustom key={e.name} data-entity={e.name}>
              <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", width: "100%" }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
                    <span>{e.label}</span>
                    {e.entityClass !== "standard" ? <Tag design="Set2">{e.entityClass.toUpperCase()}</Tag> : null}
                  </div>
                  <div style={{ opacity: 0.7, fontSize: "0.875rem" }}>{e.name}</div>
                </div>
                <span style={{ opacity: 0.7 }}>{e.table}</span>
                <ToggleButton
                  icon="pushpin-off"
                  pressed={on}
                  tooltip={on ? "Remove from menu" : "Add to menu"}
                  onClick={(ev) => {
                    ev.stopPropagation();
                    ev.preventDefault();
                    setPin.mutate({ name: e.name, label: e.label, pinned: !on });
                  }}
                />
              </div>
            </ListItemCustom>
          );
        })}
      </List>
    </DynamicPage>
  );
}
