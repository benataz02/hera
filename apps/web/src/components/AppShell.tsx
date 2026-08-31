import { useNavigate, useRouter, useRouterState, Outlet } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Avatar, Button,
  NavigationLayout, ShellBar, SideNavigation, SideNavigationGroup, SideNavigationItem,
  ToggleButton,
  UserMenu,
  UserMenuAccount,
  UserMenuItem,
} from "@ui5/webcomponents-react";
import type { SideNavigationPropTypes, NavigationLayoutDomRef, NavigationLayoutPropTypes } from "@ui5/webcomponents-react";
import { authClient } from "../auth-client.ts";
import { meQuery, orpc } from "../orpc.ts";
import { GlobalSearch, type SearchEntry } from "./GlobalSearch.tsx";
import { useRef, useState, useEffect, useMemo } from "react";
import { getTheme, setTheme } from '@ui5/webcomponents-base/dist/config/Theme.js';


// The app shell for every signed-in page. The tenant is the subdomain; the auth gate lives in the
// _authed route (beforeLoad), this only renders the chrome.
export function AppShell() {
  const navigate = useNavigate();
  const router = useRouter();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const navLayoutRef = useRef<NavigationLayoutDomRef>(null);
  const [navMode, setNavMode] = useState<NavigationLayoutPropTypes["mode"]>("Auto");
  // Read the real collapsed state off the ref so the first click is correct on any screen size,
  // keeping "Auto" responsiveness until the user takes manual control.
  const toggleNav = () => setNavMode(navLayoutRef.current?.isSideCollapsed() ? "Expanded" : "Collapsed");
  const [density, setDensity] = useState<Density>(() => (localStorage.getItem("density") as Density) ?? getDensity());
  const [theme, setThemeState] = useState<string>(() => localStorage.getItem("theme") ?? getTheme());

  // Identity + org role in one query, already primed by _authed's beforeLoad — a cache read.
  // Role decides whether the Settings item shows; the server gates it too.
  const me = useQuery(meQuery);
  const user = me.data?.user;
  const isAdmin = me.data?.role === "admin" || me.data?.role === "owner";
  const isClient = me.data?.role === "client";
  const pins = useQuery({ ...orpc.entities.navPins.queryOptions(), enabled: isAdmin });

  const onSelect: SideNavigationPropTypes["onSelectionChange"] = (e) => {
    const el = e.detail.item as HTMLElement;
    const to = el.dataset.to;
    if (!to) return;
    const pin = /^\/b1\/([^/]+)$/.exec(to);
    if (pin) navigate({ to: "/b1/$entity", params: { entity: pin[1]! } });
    else navigate({ to: to });
  };

  const THEMES = [
    { id: 'sap_horizon', labelKey: 'Morning Horizon' },
    { id: 'sap_horizon_dark', labelKey: 'Evening Horizon' },
    { id: 'sap_fiori_3', labelKey: 'Quartz Light' },
    { id: 'sap_fiori_3_dark', labelKey: 'Quartz Dark' },
    { id: 'sap_fiori_3_hcb', labelKey: 'High Contrast Black' },
    { id: 'sap_fiori_3_hcw', labelKey: 'High Contrast White' },
  ] as const;

  // What the shellbar search can reach besides objects: the same targets as the side nav, plus the
  // appearance settings that otherwise only live in the user menu.
  const searchEntries = useMemo<SearchEntry[]>(() => {
    const page = (text: string, to: string, icon: string) => ({ group: "Menus", text, icon, run: () => navigate({ to }) });
    return [
      page("Home", "/", "home"),
      page("Configurations", "/configs", "sales-quote"),
      ...(isAdmin
        ? [
            page("Entities", "/b1", "database"),
            ...(pins.data?.entities ?? []).map((p) => ({
              group: "Menus" as const,
              text: p.label,
              description: p.name,
              icon: "document",
              run: () => navigate({ to: "/b1/$entity", params: { entity: p.name } }),
            })),
            page("Configurator models", "/models", "tree"),
            page("Settings", "/settings", "action-settings"),
          ]
        : []),
      ...THEMES.map((t) => ({
        group: "Settings", text: t.labelKey, description: "Theme", icon: "palette",
        run: () => setThemeState(t.id),
      })),
      { group: "Settings", text: "Compact", description: "Density", icon: "resize-horizontal", run: () => setDensity('compact') },
      { group: "Settings", text: "Cozy", description: "Density", icon: "resize-horizontal", run: () => setDensity('cozy') },
    ];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAdmin, navigate, pins.data]);

  type Density = 'cozy' | 'compact';

  function getDensity(): Density {
    return document.body.classList.contains('ui5-content-density-compact') ? 'compact' : 'cozy';
  }

  useEffect (() => {
    if (density === 'compact') {
      document.body.classList.add('ui5-content-density-compact');
      document.body.classList.remove('ui5-content-density-cozy');
    } else {
      document.body.classList.add('ui5-content-density-cozy');
      document.body.classList.remove('ui5-content-density-compact');
    }
    localStorage.setItem('density', density);
  }, [density]);

  useEffect(() => {
    setTheme(theme);
    localStorage.setItem('theme', theme);
  }, [theme]);

  const queryClient = useQueryClient();

  const signOut = async () => {
    await authClient.signOut();
    queryClient.clear(); // drop session + role caches, not just the session
    navigate({ to: "/login" });
  };

  return (
    <NavigationLayout
      ref={navLayoutRef}
      mode={navMode}
      header={
        <>
          <ShellBar
            startButton={
              <>
                <Button
                  icon="nav-back"
                  tooltip='Back'
                  onClick={() => router.history.back()}
                />
                <Button
                  icon="menu"
                  tooltip='Menu'
                  onClick={toggleNav}
                />
              </>
            }
            primaryTitle="HERA"
            /* logo={<img alt="HERA" src="/hera.png" />} */
            onLogoClick={() => navigate({ to: "/" })}
            content={isClient ? undefined : <GlobalSearch entries={searchEntries} isAdmin={isAdmin} />}
            profile={<Avatar id="user-menu-opener" initials='BA' />}
            onProfileClick={() => setUserMenuOpen((open) => !open)}
            showNotifications
            assistant={<ToggleButton icon="da" tooltip="Joule" />}
          >
          </ShellBar>
          <UserMenu
            open={userMenuOpen}
            opener="user-menu-opener"
            onClose={() => setUserMenuOpen(false)}
            onSignOutClick={signOut}
            accounts={
              <UserMenuAccount
                avatarInitials={user?.name?.substring(0, 2).toUpperCase() ?? 'U'}
                titleText={user?.name}
                description={user?.email}
              />
            }
            showEditAccounts
            showEditButton
            showManageAccount
            showOtherAccounts
          >
            <UserMenuItem text="Themes" icon="person-placeholder" >
              {THEMES.map((t) => (
                <UserMenuItem
                  key={t.id}
                  text={t.labelKey}
                  icon={theme === t.id ? "sys-enter" : ""}
                  onClick={() => setThemeState(t.id)}
                >
                </UserMenuItem>
              ))}
            </UserMenuItem>
            <UserMenuItem text="Density" icon="person-placeholder" >
              <UserMenuItem
                data-id="compact"
                text="Compact"
                icon={density === "compact" ? "sys-enter" : ""}
                onClick={() => setDensity('compact')}
              >
              </UserMenuItem>
              <UserMenuItem
                data-id="cozy"
                text="Cozy"
                icon={density === "cozy" ? "sys-enter" : ""}
                onClick={() => setDensity('cozy')}
              >
              </UserMenuItem>
            </UserMenuItem>
          </UserMenu>
        </>
      }
      sideContent={
        <SideNavigation
          onSelectionChange={onSelect}
          fixedItems={isAdmin ? (
            <SideNavigationItem text="Settings" icon="action-settings" data-to="/settings"
              selected={pathname === "/settings"} />
          ) : undefined}
        >
          {isClient ? (
            <>
              {/* "New request" leaves the nav — it is a button on the Projects page now. */}
              <SideNavigationItem text="My requests" icon="sales-order" data-to="/portal"
                selected={pathname === "/portal" || pathname === "/portal/new" || (pathname.startsWith("/portal/") && !pathname.startsWith("/portal/docs"))} />
              <SideNavigationItem text="Quotations" icon="sales-quote" data-to="/portal/docs/Quotations"
                selected={pathname.startsWith("/portal/docs/Quotations")} />
              <SideNavigationItem text="Sales orders" icon="sales-order-item" data-to="/portal/docs/Orders"
                selected={pathname.startsWith("/portal/docs/Orders")} />
              <SideNavigationItem text="Deliveries" icon="shipping-status" data-to="/portal/docs/DeliveryNotes"
                selected={pathname.startsWith("/portal/docs/DeliveryNotes")} />
              <SideNavigationItem text="Invoices" icon="monitor-payments" data-to="/portal/docs/Invoices"
                selected={pathname.startsWith("/portal/docs/Invoices")} />
            </>
          ) : (
            <>
              <SideNavigationItem text="Home" icon="home" data-to="/" selected={pathname === "/"} />
              {isAdmin ? (
                <SideNavigationGroup text="SAP Business One" expanded>
                  <SideNavigationItem text="Entities" icon="database" data-to="/b1"
                    selected={pathname === "/b1"} />
                  {(pins.data?.entities ?? []).map((p) => (
                    <SideNavigationItem key={p.name} text={p.label} icon="document"
                      data-to={`/b1/${p.name}`}
                      selected={pathname === `/b1/${p.name}` || pathname.startsWith(`/b1/${p.name}/`)} />
                  ))}
                </SideNavigationGroup>
              ) : null}
              <SideNavigationGroup text="Configurator" expanded>
                <SideNavigationItem
                  text="Configurations"
                  icon="sales-quote"
                  data-to="/configs"
                  selected={pathname === "/configs" || pathname.startsWith("/configs/")}
                />
                {isAdmin ? (
                  <SideNavigationItem
                    text="Configurator models"
                    icon="tree"
                    data-to="/models"
                    selected={pathname === "/models" || pathname.startsWith("/models/")}
                  />
                ) : null}
              </SideNavigationGroup>
            </>
          )}
        </SideNavigation>
      }
    >
      <Outlet />
    </NavigationLayout>
  );
}
