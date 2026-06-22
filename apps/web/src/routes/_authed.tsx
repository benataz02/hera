import { createFileRoute, redirect, Outlet, useNavigate, useRouterState } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import {
  Avatar,
  NavigationLayout, ShellBar, ShellBarItem, SideNavigation, SideNavigationItem,
  ToggleButton,
} from "@ui5/webcomponents-react";
import type { SideNavigationPropTypes } from "@ui5/webcomponents-react";
import { authClient } from "../auth-client.ts";
import { orpc } from "../orpc.ts";
import { apexUrl, currentSlug, hardRedirect, tenantUrl } from "../lib/tenant.ts";

// The app shell for every signed-in page. The tenant is the subdomain; on the apex this
// route is just the lobby dispatcher (it never renders the app there).
export const Route = createFileRoute("/_authed")({
  beforeLoad: async () => {
    const slug = currentSlug();
    const { data } = await authClient.getSession();

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
  const { data: session } = authClient.useSession();
  const pathname = useRouterState({ select: (s) => s.location.pathname });

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
    if (entity) navigate({ to: "/entities/$entity", params: { entity } });
    else if (el.dataset.to === "/settings") navigate({ to: "/settings" });
    else if (el.dataset.to === "/configure") navigate({ to: "/configure" });
    else if (el.dataset.to === "/models") navigate({ to: "/models" });
    else navigate({ to: "/" });
  };

  const signOut = async () => {
    await authClient.signOut();
    navigate({ to: "/login" });
  };

  return (
    <NavigationLayout
      header={
        <ShellBar 
          primaryTitle="HERA" 
          secondaryTitle={session?.user?.email ?? ""}
          logo={
            <img alt="SAP Logo" src="https://ui5.github.io/webcomponents/images/sap-logo-svg.svg" />
          }
            profile={
            <Avatar
              id="user-menu-opener"
              initials='U'
            />
          }
          showNotifications
          assistant={<ToggleButton icon="da" tooltip="Joule" />}
        >
          <ShellBarItem icon="log" text="Sign out" onClick={signOut} />
        </ShellBar>
      }
      sideContent={
        <SideNavigation onSelectionChange={onSelect}>
          <SideNavigationItem text="Home" icon="home" data-to="/" selected={pathname === "/"} />
          <SideNavigationItem text="Configure" icon="wrench" data-to="/configure" selected={pathname === "/configure"} />
          {enabled.map((ent) => (
            <SideNavigationItem
              key={ent.name}
              text={ent.name}
              icon="list"
              data-entity={ent.name}
              selected={pathname === `/entities/${ent.name}`}
            />
          ))}
          {isAdmin ? (
            <SideNavigationItem
              text="Models"
              icon="create-form"
              data-to="/models"
              selected={pathname.startsWith("/models")}
            />
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
