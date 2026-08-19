import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
// Plain `Search`, not `ShellBarSearch`: the latter collapses itself back to a magnifier button on
// icon-press / empty Enter, and that toggle isn't switchable from the outside. `Search` never sets
// `collapsed`, so the field stays open. Same base component otherwise — scopes, items, popover.
import { Search, SearchItem, SearchItemGroup, SearchScope } from "@ui5/webcomponents-react";
import { orpc } from "../orpc.ts";

// ShellBar's `content` slot only knows left/right (it splits on a single ShellBarSpacer), so a
// truly centred field has to leave the flow. The bar spans the full viewport width and sits at
// the top, so viewport centre == bar centre. The height var is inherited from the ShellBar host
// through the slot, which keeps the vertical centring theme-correct (2.75rem / 3.25rem).
if (typeof document !== "undefined" && !document.getElementById("hera-shell-search-style")) {
  const el = document.createElement("style");
  el.id = "hera-shell-search-style";
  el.textContent = `
.hera-shell-search{position:fixed;top:0;left:50%;transform:translateX(-50%);
  height:var(--_ui5_shellbar_root_height,3.25rem);display:flex;align-items:center;
  width:min(34rem,42vw)}
.hera-shell-search>*{width:100%}
ui5-search.hera-shellbar-search{background-image:none}
/* ponytail: below this the centred field would sit on top of the branding — drop it rather than
   overlap. Move to the ShellBar's own collapsible search slot if mobile search is ever needed. */
@media (max-width:900px){.hera-shell-search{display:none}}`;
  document.head.appendChild(el);
}

/** One thing the search can jump to or do. `group` is the popover section header. */
export type SearchEntry = {
  group: string;
  text: string;
  description?: string;
  icon?: string;
  run: () => void;
};

// Scope values double as the group headers, so filtering is `entry.group === scope` — no mapping.
const ALL = "all";
// Unscoped, one group can't bury the others; scoped, there's only one list so let it breathe.
const CAP = { all: 6, scoped: 20 };

// Global shellbar search. Menus + settings come from the caller (it already holds the nav data);
// objects are fetched on the first keystroke and cached by TanStack for the rest of the session.
// ponytail: client-side substring match over the two list endpoints the app already caches. Add a
// server-side search procedure when a tenant outgrows a single list response.
export function GlobalSearch({ entries, isAdmin }: { entries: SearchEntry[]; isAdmin: boolean }) {
  const navigate = useNavigate();
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [scope, setScope] = useState(ALL);
  const needle = q.trim().toLowerCase();

  const configs = useQuery({ ...orpc.configs.list.queryOptions(), enabled: !!needle });
  const models = useQuery({ ...orpc.models.list.queryOptions(), enabled: !!needle && isAdmin });

  const hits = useMemo(() => {
    if (!needle) return [];
    const objects: SearchEntry[] = [
      ...(configs.data ?? []).map((c) => ({
        group: "Configurations",
        text: c.name,
        description: [c.customer, c.modelName, c.status].filter(Boolean).join(" · "),
        icon: "sales-quote",
        run: () => navigate({ to: "/configs/$id", params: { id: c.id } }),
      })),
      ...(models.data ?? []).map((m) => ({
        group: "Models",
        text: m.name,
        description: "Configurator model",
        icon: "tree",
        run: () => navigate({ to: "/models/$id", params: { id: m.id } }),
      })),
    ];
    return [...entries, ...objects].filter(
      (e) =>
        (scope === ALL || e.group === scope) &&
        (e.text.toLowerCase().includes(needle) || (e.description ?? "").toLowerCase().includes(needle)),
    );
  }, [needle, scope, entries, configs.data, models.data, navigate]);

  // Keep first-seen group order so menus stay above objects and settings.
  const groups = useMemo(() => {
    const cap = scope === ALL ? CAP.all : CAP.scoped;
    const by = new Map<string, SearchEntry[]>();
    for (const h of hits) {
      const g = by.get(h.group) ?? [];
      if (g.length < cap) g.push(h);
      by.set(h.group, g);
    }
    return [...by];
  }, [hits, scope]);

  const pick = (e: SearchEntry) => {
    setQ("");
    setOpen(false);
    e.run();
  };

  return (
    <div className="hera-shell-search" slot="content" data-hide-order="99">
      <Search
        className="hera-shellbar-search"
        placeholder="Search menus, objects and settings"
        value={q}
        showClearIcon
        noTypeahead
        open={open && groups.length > 0}
        loading={configs.isFetching || models.isFetching}
        scopeValue={scope}
        scopes={
          <>
            <SearchScope value={ALL} text="All" />
            <SearchScope value="Menus" text="Menus" />
            <SearchScope value="Configurations" text="Configurations" />
            {isAdmin ? <SearchScope value="Models" text="Models" /> : null}
            <SearchScope value="Settings" text="Settings" />
          </>
        }
        onScopeChange={(e) => setScope(e.detail.scope?.value ?? ALL)}
        onInput={(e) => { setQ(e.target.value ?? ""); setOpen(true); }}
        onOpen={() => setOpen(true)}
        onClose={() => setOpen(false)}
        onSearch={() => { if (hits[0]) pick(hits[0]); }}
      >
        {groups.map(([name, items]) => (
          <SearchItemGroup key={name} headerText={name}>
            {items.map((it, i) => (
              <SearchItem
                key={`${name}:${i}`}
                text={it.text}
                description={it.description}
                icon={it.icon}
                onClick={() => pick(it)}
              />
            ))}
          </SearchItemGroup>
        ))}
      </Search>
    </div>
  );
}
