import { useNavigate, useRouter, useRouterState, useMatches, Outlet } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Avatar,
  Breadcrumbs, BreadcrumbsItem,
  Button,
  NavigationLayout, Search, ShellBar, SideNavigation, SideNavigationItem,
  ToggleButton,
  UserMenu,
  UserMenuAccount,
  UserMenuItem,
} from "@ui5/webcomponents-react";
import type { SideNavigationPropTypes, NavigationLayoutDomRef, NavigationLayoutPropTypes } from "@ui5/webcomponents-react";
import { authClient } from "../auth-client.ts";
import { orpc, client } from "../orpc.ts";
import { useRef, useState, useEffect } from "react";
import { getTheme, setTheme } from '@ui5/webcomponents-base/dist/config/Theme.js';


// The app shell for every signed-in page. The tenant is the subdomain; the auth gate lives in the
// _authed route (beforeLoad), this only renders the chrome.
export function AppShell() {
  const navigate = useNavigate();
  const router = useRouter();
  const { data: session } = useQuery<Awaited<ReturnType<typeof authClient.getSession>>["data"]>({ queryKey: ["session"] });
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const navLayoutRef = useRef<NavigationLayoutDomRef>(null);
  const [navMode, setNavMode] = useState<NavigationLayoutPropTypes["mode"]>("Auto");
  // Read the real collapsed state off the ref so the first click is correct on any screen size,
  // keeping "Auto" responsiveness until the user takes manual control.
  const toggleNav = () => setNavMode(navLayoutRef.current?.isSideCollapsed() ? "Expanded" : "Collapsed");
  const [density, setDensity] = useState<Density>(() => (localStorage.getItem("density") as Density) ?? getDensity());
  const [theme, setThemeState] = useState<string>(() => localStorage.getItem("theme") ?? getTheme());

  // Org role decides whether the Settings (entity config) item shows. The server gates it too.
  const role = useQuery({
    queryKey: ["active-member-role"],
    queryFn: async () => (await authClient.organization.getActiveMember()).data?.role ?? "member",
  });
  const isAdmin = role.data === "admin" || role.data === "owner";

  const entities = useQuery(orpc.entities.getEnabled.queryOptions());
  const enabled = entities.data ?? [];

  // Open the agent's B1 Service Layer session once per app load so the first query/value-help
  // doesn't wait out the /Login round-trip. Best-effort: ignore failures (e.g. agent offline).
  useEffect(() => void client.entities.login().catch(() => {}), []);

  const onSelect: SideNavigationPropTypes["onSelectionChange"] = (e) => {
    const el = e.detail.item as HTMLElement;
    const entity = el.dataset.entity;
    const to = el.dataset.to;
    if (entity) navigate({ to: "/$entity", params: { entity } });
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
    queryClient.setQueryData(["session"], null);
    navigate({ to: "/login" });
  };

  return (
    <NavigationLayout
      ref={navLayoutRef}
      //mode={navMode}
      mode="Collapsed"
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
            logo={<img alt="SAP Logo" src="https://ui5.github.io/webcomponents/images/sap-logo-svg.svg" />}
            onLogoClick={() => navigate({ to: "/" })}
            searchField={<Search  placeholder="Search" showClearIcon />}
            showSearchField
            hideSearchButton
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
                avatarInitials={session?.user?.name?.substring(0, 2).toUpperCase() ?? 'U'}
                titleText={session?.user?.name}
                description={session?.user?.email}
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
        <SideNavigation onSelectionChange={onSelect}>
          <SideNavigationItem text="Home" icon="home" data-to="/" selected={pathname === "/"} />
          {enabled.map((ent) => (
            <SideNavigationItem
              key={ent.name}
              text={ent.name}
              icon="list"
              data-entity={ent.name}
              selected={pathname === `/${ent.name}`}
            />
          ))}
          <SideNavigationItem text="Configure" icon="wrench" data-to="/configure" selected={pathname === "/configure"} />
          {isAdmin ? (
            <SideNavigationItem text="Models" icon="tree" data-to="/models" selected={pathname.startsWith("/models")} />
          ) : null}
          {isAdmin ? (
            <SideNavigationItem text="Master data" icon="database" data-to="/masterdata" selected={pathname.startsWith("/masterdata")} />
          ) : null}
          {isAdmin ? (
            <SideNavigationItem
              text="Settings"
              icon="action-settings"
              data-to="/settings"
              selected={pathname === "/settings"}
            />
          ) : null}
        </SideNavigation>
      }
    >
      <Outlet />
    </NavigationLayout>
  );
}
