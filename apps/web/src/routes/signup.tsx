import { createFileRoute, redirect, useNavigate, Link } from "@tanstack/react-router";
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Input, Button, MessageStrip } from "@ui5/webcomponents-react";
import { authClient } from "../auth-client.ts";
import { AuthLayout } from "../components/AuthLayout.tsx";
import { SocialButtons } from "../components/SocialButtons.tsx";
import { apexUrl, hardRedirect, isApex, safeRedirect } from "../lib/tenant.ts";

export const Route = createFileRoute("/signup")({
  validateSearch: (s: Record<string, unknown>): { redirect?: string } => ({
    redirect: typeof s.redirect === "string" ? s.redirect : undefined,
  }),
  beforeLoad: async ({ context, search }) => {
    if (!isApex())
      return hardRedirect(
        apexUrl(`/signup${search.redirect ? `?redirect=${encodeURIComponent(search.redirect)}` : ""}`),
      );
    const data = await context.queryClient.ensureQueryData({
      queryKey: ["session"],
      queryFn: async () => (await authClient.getSession()).data ?? null,
    });
    if (data?.session) {
      const to = safeRedirect(search.redirect);
      if (to) return hardRedirect(to);
      throw redirect({ to: "/" });
    }
  },
  component: Signup,
});

function Signup() {
  const navigate = useNavigate();
  const { redirect: redirectTo } = Route.useSearch();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  const queryClient = useQueryClient();

  const signUp = useMutation({
    mutationFn: async (vars: { name: string; email: string; password: string }) => {
      const { data } = await authClient.getSession();
      if (data?.session) return data; // Prevent duplicate session creation
      // ponytail: no email verification — no mailer in the repo. Enable Better Auth
      //           requireEmailVerification + a sender when one exists.
      const res = await authClient.signUp.email(vars);
      if (res.error) throw new Error(res.error.message ?? "Sign up failed");
      return res.data;
    },
    onSuccess: async () => {
      await queryClient.fetchQuery({
        queryKey: ["session"],
        queryFn: async () => (await authClient.getSession()).data ?? null,
        staleTime: 0,
      });
      const to = safeRedirect(redirectTo);
      if (to) return void hardRedirect(to);
      navigate({ to: "/onboarding" }); // brand-new user has no org yet
    },
  });

  const submit = () => name && email && password && signUp.mutate({ name, email, password });

  return (
    <AuthLayout>
      <h2 className="auth-h1">Create your account</h2>
      <p className="auth-sub">Start syncing quotes to SAP B1.</p>
      {signUp.error ? <MessageStrip design="Negative" hideCloseButton>{signUp.error.message}</MessageStrip> : null}
      <label className="auth-field">
        <span>Name</span>
        <Input value={name} onInput={(e) => setName(e.target.value)} />
      </label>
      <label className="auth-field">
        <span>Work email</span>
        <Input type="Email" value={email} onInput={(e) => setEmail(e.target.value)} />
      </label>
      <label className="auth-field">
        <span>Password</span>
        <Input
          type="Password"
          value={password}
          onInput={(e) => setPassword(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
        />
      </label>
      <Button design="Emphasized" disabled={signUp.isPending} onClick={submit}>
        {signUp.isPending ? "Creating…" : "Create account"}
      </Button>
      <div className="auth-or">or</div>
      <SocialButtons callbackURL="/onboarding" />
      <p className="auth-alt">
        Already have an account? <Link to="/login" search={{ redirect: redirectTo }}>Sign in</Link>
      </p>
    </AuthLayout>
  );
}
