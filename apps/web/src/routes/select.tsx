import { createFileRoute, redirect, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Button, BusyIndicator } from "@ui5/webcomponents-react";
import { authClient } from "../auth-client.ts";
import { AuthLayout } from "../components/AuthLayout.tsx";
import { apexUrl, hardRedirect, isApex, tenantUrl } from "../lib/tenant.ts";

// Apex org picker for users who belong to more than one workspace.
export const Route = createFileRoute("/select")({
  beforeLoad: async ({ context }) => {
    if (!isApex()) return hardRedirect(apexUrl("/select"));
    const data = await context.queryClient.ensureQueryData({
      queryKey: ["session"],
      queryFn: async () => (await authClient.getSession()).data ?? null,
      staleTime: 0,
    });
    if (!data?.session) throw redirect({ to: "/login" });
  },
  component: Select,
});

function Select() {
  const orgs = useQuery({
    queryKey: ["user-orgs"],
    queryFn: async () => (await authClient.organization.list()).data ?? [],
  });

  return (
    <AuthLayout>
      <h2 className="auth-h1">Choose a workspace</h2>
      <p className="auth-sub">Pick the company you want to act as.</p>

      {orgs.isPending ? <BusyIndicator active /> : null}

      <div className="auth-invite-list">
        {(orgs.data ?? []).map((o) => (
          <div className="auth-invite" key={o.id}>
            <span><b>{o.name}</b><br /><small>{o.slug}</small></span>
            <Button design="Emphasized" onClick={() => hardRedirect(tenantUrl(o.slug))}>Open</Button>
          </div>
        ))}
      </div>

      <p className="auth-alt"><Link to="/onboarding">Create a new company</Link></p>
    </AuthLayout>
  );
}
