import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Input, Button, MessageStrip, BusyIndicator } from "@ui5/webcomponents-react";
import { authClient } from "../auth-client.ts";
import { AuthLayout } from "../components/AuthLayout.tsx";
import {
  apexUrl, BASE_DOMAIN, hardRedirect, isApex, isReserved, SLUG_RE, toSlug, tenantUrl,
} from "../lib/tenant.ts";

export const Route = createFileRoute("/onboarding")({
  // Auth lives on the apex. Signed-in users with no org land here; any signed-in user may
  // also create an additional workspace. The apex dispatcher (`/`) routes everyone else.
  beforeLoad: async () => {
    if (!isApex()) return hardRedirect(apexUrl("/onboarding"));
    const { data } = await authClient.getSession();
    if (!data?.session) throw redirect({ to: "/login" });
  },
  component: Onboarding,
});

type Invite = { id: string; organizationId: string; organizationName: string };

const sanitizeSlug = (v: string) => v.toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 31);

function Onboarding() {
  const navigate = useNavigate();
  const [company, setCompany] = useState("");
  const [slug, setSlug] = useState("");
  const [slugEdited, setSlugEdited] = useState(false);

  const onCompany = (v: string) => {
    setCompany(v);
    if (!slugEdited) setSlug(toSlug(v));
  };

  const slugValid = SLUG_RE.test(slug) && !isReserved(slug);

  // Live availability. ponytail: treat any error as "unavailable" — Better Auth's checkSlug
  // returns ok when free and a 4xx when taken; that's the only signal we need here.
  const avail = useQuery({
    queryKey: ["slug-check", slug],
    enabled: slugValid,
    queryFn: async () => !(await authClient.organization.checkSlug({ slug })).error,
  });
  const available = slugValid && avail.data === true;

  // Pending invites addressed to this user's email (no mailer needed — they just appear).
  const invites = useQuery({
    queryKey: ["user-invitations"],
    queryFn: async () => {
      const res = await authClient.organization.listUserInvitations();
      return ((res.data ?? []) as Array<Invite & { status: string }>).filter((i) => i.status === "pending");
    },
  });

  const create = useMutation({
    mutationFn: async () => {
      const res = await authClient.organization.create({ name: company.trim(), slug });
      if (res.error || !res.data) throw new Error(res.error?.message ?? "Could not create company");
    },
    onSuccess: () => hardRedirect(tenantUrl(slug)),
  });

  const accept = useMutation({
    mutationFn: async (inv: Invite) => {
      const res = await authClient.organization.acceptInvitation({ invitationId: inv.id });
      if (res.error) throw new Error(res.error.message ?? "Could not accept invitation");
    },
    onSuccess: () => navigate({ to: "/" }), // apex dispatcher routes to the joined workspace
  });

  const busy = create.isPending || accept.isPending;
  const error = create.error ?? accept.error;
  const pending = invites.data ?? [];
  const canCreate = company.trim().length > 0 && available && !busy;

  return (
    <AuthLayout>
      <h2 className="auth-h1">Set up your workspace</h2>
      <p className="auth-sub">Create your company to get started, or join one you were invited to.</p>
      {error ? <MessageStrip design="Negative" hideCloseButton>{error.message}</MessageStrip> : null}

      {invites.isPending ? <BusyIndicator active /> : null}

      {pending.length > 0 ? (
        <div className="auth-invite-list">
          {pending.map((inv) => (
            <div className="auth-invite" key={inv.id}>
              <span><b>{inv.organizationName}</b><br /><small>You've been invited to join</small></span>
              <Button design="Emphasized" disabled={busy} onClick={() => accept.mutate(inv)}>Join</Button>
            </div>
          ))}
          <div className="auth-or">or create your own</div>
        </div>
      ) : null}

      <label className="auth-field">
        <span>Company name</span>
        <Input
          value={company}
          placeholder="ACME GmbH"
          onInput={(e) => onCompany(e.target.value)}
        />
      </label>

      <label className="auth-field">
        <span>Workspace URL</span>
        <Input
          value={slug}
          placeholder="acme"
          onInput={(e) => { setSlugEdited(true); setSlug(sanitizeSlug(e.target.value)); }}
          onKeyDown={(e) => e.key === "Enter" && canCreate && create.mutate()}
        />
        <small className="auth-sub">
          {slug ? `${slug}.${BASE_DOMAIN}` : `your-company.${BASE_DOMAIN}`}
          {slug && !slugValid ? " · use a-z, 0-9, hyphens" : ""}
          {slugValid && avail.isFetching ? " · checking…" : ""}
          {available ? " · ✓ available" : ""}
          {slugValid && avail.data === false ? " · ✗ taken" : ""}
        </small>
      </label>

      <Button
        design={pending.length > 0 ? "Default" : "Emphasized"}
        disabled={!canCreate}
        onClick={() => create.mutate()}
      >
        {create.isPending ? "Setting up…" : "Create company"}
      </Button>
    </AuthLayout>
  );
}
