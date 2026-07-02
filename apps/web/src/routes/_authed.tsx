import { createFileRoute, redirect } from "@tanstack/react-router";
import { authClient } from "../auth-client.ts";
import { apexUrl, currentSlug, hardRedirect, tenantUrl } from "../lib/tenant.ts";
import { AppShell } from "../components/AppShell.tsx";

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
  component: AppShell,
});
