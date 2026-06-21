import { createFileRoute, redirect, useNavigate, Link } from "@tanstack/react-router";
import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Input, Button, MessageStrip } from "@ui5/webcomponents-react";
import { authClient } from "../auth-client.ts";
import { AuthLayout } from "../components/AuthLayout.tsx";
import { SocialButtons } from "../components/SocialButtons.tsx";
import { apexUrl, hardRedirect, isApex } from "../lib/tenant.ts";

export const Route = createFileRoute("/login")({
  // Auth lives on the apex only. Already signed in? Hand off to the apex dispatcher (`/`).
  beforeLoad: async () => {
    if (!isApex()) return hardRedirect(apexUrl("/login"));
    const { data } = await authClient.getSession();
    if (data?.session) throw redirect({ to: "/" });
  },
  component: Login,
});

function Login() {
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  const signIn = useMutation({
    mutationFn: async (vars: { email: string; password: string }) => {
      const res = await authClient.signIn.email(vars);
      if (res.error) throw new Error(res.error.message ?? "Sign in failed");
    },
    // `/` is the apex dispatcher — it routes to the tenant subdomain / onboarding / picker.
    onSuccess: () => navigate({ to: "/" }),
  });

  const submit = () => email && password && signIn.mutate({ email, password });

  return (
    <AuthLayout>
      <h2 className="auth-h1">Welcome back</h2>
      <p className="auth-sub">Sign in to your HERA workspace.</p>
      {signIn.error ? <MessageStrip design="Negative" hideCloseButton>{signIn.error.message}</MessageStrip> : null}
      <label className="auth-field">
        <span>Email</span>
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
      <Button design="Emphasized" disabled={signIn.isPending} onClick={submit}>
        {signIn.isPending ? "Signing in…" : "Sign in"}
      </Button>
      <div className="auth-or">or</div>
      <SocialButtons />
      <p className="auth-alt">New to HERA? <Link to="/signup">Create an account</Link></p>
    </AuthLayout>
  );
}
