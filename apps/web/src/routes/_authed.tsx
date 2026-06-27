import { createFileRoute, redirect, Outlet, useNavigate, useRouter, useRouterState } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Avatar,
  Button,
  NavigationLayout, ShellBar, SideNavigation, SideNavigationItem,
  SideNavigationSubItem,
  ToggleButton,
  UserMenu,
  UserMenuAccount,
  UserMenuItem,
} from "@ui5/webcomponents-react";
import type { SideNavigationPropTypes, NavigationLayoutDomRef, NavigationLayoutPropTypes } from "@ui5/webcomponents-react";
import { authClient } from "../auth-client.ts";
import { orpc } from "../orpc.ts";
import { apexUrl, currentSlug, hardRedirect, tenantUrl } from "../lib/tenant.ts";
import { useRef, useState, useEffect } from "react";
import { getTheme, setTheme } from '@ui5/webcomponents-base/dist/config/Theme.js';

// The app shell for every signed-in page. The tenant is the subdomain; on the apex this
// route is just the lobby dispatcher (it never renders the app there).
export const Route = createFileRoute("/_authed")({
  beforeLoad: async ({ context }) => {
    const slug = currentSlug();
    const data = await context.queryClient.ensureQueryData({
      queryKey: ["session"],
      queryFn: async () => (await authClient.getSession()).data ?? null,
      staleTime: 0,
    });

    if (!slug) {
      // Apex lobby: route the user to their tenant subdomain, onboarding, or the picker.
      if (!data?.session) throw redirect({ to: "/login" });
      const orgs = (await authClient.organization.list()).data ?? [];
      if (orgs.length === 0) throw redirect({ to: "/onboarding" });
      if (orgs.length === 1) return hardRedirect(tenantUrl(orgs[0]!.slug));
      throw redirect({ to: "/select" });
    }

    // Tenant subdomain: auth on the apex, so bounce there if signed out.
    if (!data?.session) return hardRedirect(apexUrl("/login"));
    // One call validates membership (FORBIDDEN if not a member) and points Better Auth's
    // org-plugin endpoints (invite, active member) at this tenant. The server re-checks too.
    const res = await authClient.organization.setActive({ organizationSlug: slug });
    if (res.error) return hardRedirect(apexUrl("/select")); // not a member of this workspace
  },
  component: AuthedLayout,
});

function AuthedLayout() {
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

  const onSelect: SideNavigationPropTypes["onSelectionChange"] = (e) => {
    const el = e.detail.item as HTMLElement;
    const entity = el.dataset.entity;
    const to = el.dataset.to;
    if (entity) navigate({ to: "/$entity", params: { entity } });
    else if (to === "/settings") navigate({ to: "/settings" });
    else if (to === "/configure") navigate({ to: "/configure" });
    else if (to === "/models") navigate({ to: "/models" });
    else if (to === "/tables") navigate({ to: "/tables" });
    else navigate({ to: "/" });
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
            logo={<img alt="SAP Logo" src="https://ui5.github.io/webcomponents/images/sap-logo-svg.svg" />}
            onLogoClick={() => navigate({ to: "/" })}
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
            <SideNavigationItem text="Tables" icon="table-view" data-to="/tables" selected={pathname.startsWith("/tables")} />
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
