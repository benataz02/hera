import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useMutation, useQuery, skipToken } from "@tanstack/react-query";
import {
  Card, CardHeader, Input, Button, Label, MessageStrip, ObjectStatus, FlexBox,
} from "@ui5/webcomponents-react";
import { authClient } from "../../auth-client.ts";
import { orpc } from "../../orpc.ts";

export const Route = createFileRoute("/_authed/")({ component: Home });

// UI5 v2 uses string-literal value states (no ValueState enum).
const STATE: Record<string, "None" | "Information" | "Positive" | "Negative"> = {
  draft: "None",
  syncing: "Information",
  synced: "Positive",
  failed: "Negative",
};

function Home() {
  const [name, setName] = useState("");
  const [quoteId, setQuoteId] = useState<string | null>(null);
  const [inviteEmail, setInviteEmail] = useState("");

  const create = useMutation(
    orpc.quote.create.mutationOptions({ onSuccess: (q) => setQuoteId(q.id) }),
  );

  // Live SSE stream of this quote's status — flips syncing -> synced when the agent acks.
  const watch = useQuery(
    orpc.quote.watch.experimental_liveOptions({
      input: quoteId ? { id: quoteId } : skipToken,
    }),
  );

  const invite = useMutation({
    mutationFn: async (email: string) => {
      const res = await authClient.organization.inviteMember({ email, role: "member" });
      if (res.error) throw new Error(res.error.message ?? "Could not invite teammate");
    },
    onSuccess: () => setInviteEmail(""),
  });

  const status = watch.data?.status;
  const docEntry = watch.data?.docEntry;

  return (
    <div style={{ padding: "1rem", maxWidth: 640, margin: "0 auto", display: "flex", flexDirection: "column", gap: "1rem" }}>
      <Card header={<CardHeader titleText="Create a quote" subtitleText="Syncs to SAP B1 via the on-prem agent" />}>
        <FlexBox direction="Column" style={{ padding: "1rem", gap: "1rem" }}>
          <Label>Customer / quote name</Label>
          <Input value={name} onInput={(e) => setName(e.target.value)} placeholder="ACME GmbH" />
          <Button
            design="Emphasized"
            disabled={create.isPending || name.length === 0}
            onClick={() => create.mutate({ payload: { name } })}
          >
            Create &amp; sync
          </Button>

          {quoteId ? (
            <FlexBox direction="Column" style={{ gap: "0.5rem" }}>
              <Label>Quote {quoteId.slice(0, 8)}…</Label>
              <ObjectStatus state={status ? STATE[status] : "None"}>
                {status ?? "pending"}
                {docEntry ? ` · B1 ${docEntry}` : ""}
              </ObjectStatus>
            </FlexBox>
          ) : null}
        </FlexBox>
      </Card>

      <Card header={<CardHeader titleText="Invite a teammate" subtitleText="They join this company when they sign up" />}>
        <FlexBox direction="Column" style={{ padding: "1rem", gap: "0.75rem" }}>
          {invite.isSuccess ? (
            <MessageStrip design="Positive" hideCloseButton>Invitation created.</MessageStrip>
          ) : null}
          {invite.error ? (
            <MessageStrip design="Negative" hideCloseButton>{invite.error.message}</MessageStrip>
          ) : null}
          <Input
            type="Email"
            value={inviteEmail}
            placeholder="teammate@company.com"
            onInput={(e) => setInviteEmail(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && inviteEmail && invite.mutate(inviteEmail)}
          />
          {/* ponytail: invite row is created but not emailed (no mailer); the invitee
              accepts it from /onboarding via listUserInvitations. */}
          <Button disabled={invite.isPending || inviteEmail.length === 0} onClick={() => invite.mutate(inviteEmail)}>
            {invite.isPending ? "Inviting…" : "Send invite"}
          </Button>
        </FlexBox>
      </Card>
    </div>
  );
}
