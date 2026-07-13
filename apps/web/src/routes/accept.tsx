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
// would bounce them to /select before acceptInvite ever runs. Works both signed-out
// (bounces to apex login and back here) and signed-in (accepts immediately).
export const Route = createFileRoute("/accept")({
  validateSearch: (s: Record<string, unknown>) => ({ token: typeof s.token === "string" ? s.token : "" }),
  component: Accept,
});

function Accept() {
  const { token } = Route.useSearch();
  const accept = useMutation({
    mutationFn: async () => {
      const { data } = await authClient.getSession();
      if (!data?.session)
        return hardRedirect(apexUrl(`/login?redirect=${encodeURIComponent(window.location.href)}`));
      await client.portal.acceptInvite({ token });
      // Hard navigation (not router `navigate`) so `_authed`'s beforeLoad re-reads
      // membership + role from scratch — the invitee just gained a new org membership
      // that the router's cached session/role query data doesn't know about yet.
      return hardRedirect("/portal");
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
