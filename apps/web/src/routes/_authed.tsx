import { createFileRoute, redirect } from "@tanstack/react-router";
import { authClient, sessionQuery } from "../auth-client.ts";
import { meQuery } from "../orpc.ts";
import { apexUrl, currentSlug, hardRedirect, tenantUrl } from "../lib/tenant.ts";
import { AppShell } from "../components/AppShell.tsx";

// The app shell for every signed-in page. The tenant is the subdomain; on the apex this
// route is just the lobby dispatcher (it never renders the app there).
export const Route = createFileRoute("/_authed")({
  beforeLoad: async ({ context, location }) => {
    const slug = currentSlug();

    if (!slug) {
      // Apex lobby: no tenant to resolve, so this is the one branch that reads the session
      // directly. Route the user to their tenant subdomain, onboarding, or the picker.
      const data = await context.queryClient.ensureQueryData(sessionQuery);
      if (!data?.session) throw redirect({ to: "/login" });
      // Deliberately uncached: accept.tsx reaches this dispatcher via a client-side navigate
      // right after joining an org, and a cached list would miss the new membership.
      const orgs = (await authClient.organization.list()).data ?? [];
      if (orgs.length === 0) throw redirect({ to: "/onboarding" });
      if (orgs.length === 1) return hardRedirect(tenantUrl(orgs[0]!.slug));
      throw redirect({ to: "/select" });
    }

    // Tenant subdomain: one call covers signed-in, member-of-this-workspace, and role.
    // beforeLoad re-runs on every navigation, so it's cached — an in-app route change costs
    // no network. Retry is off so a rejection bounces immediately. UNAUTHORIZED means auth,
    // which lives on the apex; anything else means this isn't their workspace.
    // The server re-checks membership on every procedure regardless — this is UX, not the boundary.
    const me = await context.queryClient
      .ensureQueryData({ ...meQuery, retry: false })
      .catch((e: unknown) => (e as { code?: string }).code ?? "FORBIDDEN");
    if (typeof me === "string") {
      return hardRedirect(apexUrl(me === "UNAUTHORIZED" ? "/login" : "/select"));
    }

    // Role decides which app this shell renders. UX only — the server procedures are the boundary.
    const path = location.pathname;
    if (me.role === "client" && !path.startsWith("/portal")) throw redirect({ to: "/portal" });
    if (me.role !== "client" && path.startsWith("/portal")) throw redirect({ to: "/" });
  },
  component: AppShell,
});
