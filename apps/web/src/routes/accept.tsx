import { useEffect } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useMutation } from "@tanstack/react-query";
import { BusyIndicator, Button, IllustratedMessage } from "@ui5/webcomponents-react";
import "@ui5/webcomponents-fiori/dist/illustrations/ErrorScreen.js";
import { client } from "../orpc.ts";
import { authClient } from "../auth-client.ts";
import { apexUrl, hardRedirect } from "../lib/tenant.ts";

// Portal-invite landing page: `https://<slug>.<base>/accept?token=…`. Top-level (not
// under `_authed`) because the invitee has no membership yet — `_authed`'s beforeLoad
// would bounce them to /select before acceptInvite ever runs.
export const Route = createFileRoute("/accept")({
  validateSearch: (s: Record<string, unknown>) => ({ token: typeof s.token === "string" ? s.token : "" }),
  component: Accept,
});

function Accept() {
  const { token } = Route.useSearch();
  const accept = useMutation({
    mutationFn: async () => {
      // Invite email is the source of truth — never the browser session. An admin
      // opening their own copy-link would otherwise look like "this user exists".
      const { email, userExists } = await client.portal.peekInvite({ token });
      const { data } = await authClient.getSession();
      if (data?.user?.email?.toLowerCase() === email) {
        await client.portal.acceptInvite({ token });
        // Hard navigation (not router `navigate`) so `_authed`'s beforeLoad re-reads
        // membership + role from scratch — the invitee just gained a new org membership
        // that the router's cached session/role query data doesn't know about yet.
        return hardRedirect("/portal");
      }
      if (data?.session) await authClient.signOut();
      const path = userExists ? "/login" : "/signup";
      const q = new URLSearchParams({
        redirect: window.location.href,
        email,
      });
      return hardRedirect(apexUrl(`${path}?${q}`));
    },
  });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (token) accept.mutate();
  }, [token]);

  if (!token || accept.error) {
    return (
      <IllustratedMessage
        name="ErrorScreen"
        titleText="This invite link didn't work"
        subtitleText={accept.error?.message ?? "The link is incomplete — ask your supplier to send it again."}
      >
        <Button onClick={() => accept.mutate()}>Try again</Button>
      </IllustratedMessage>
    );
  }
  return <BusyIndicator active delay={0} style={{ width: "100%", marginTop: "4rem" }} />;
}
