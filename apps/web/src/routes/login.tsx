import { createFileRoute, redirect, useNavigate, Link } from "@tanstack/react-router";
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Input, Button, MessageStrip } from "@ui5/webcomponents-react";
import { authClient } from "../auth-client.ts";
import { AuthLayout } from "../components/AuthLayout.tsx";
import { SocialButtons } from "../components/SocialButtons.tsx";
import { apexUrl, hardRedirect, isApex, safeRedirect } from "../lib/tenant.ts";

export const Route = createFileRoute("/login")({
  validateSearch: (s: Record<string, unknown>): { redirect?: string } => ({
    redirect: typeof s.redirect === "string" ? s.redirect : undefined,
  }),
  // Auth lives on the apex only. Already signed in? Hand off to the apex dispatcher (`/`),
  // or straight back to `redirect` (e.g. an invite accept link) when it's safe to do so.
  beforeLoad: async ({ context, search }) => {
    if (!isApex())
      return hardRedirect(
        apexUrl(`/login${search.redirect ? `?redirect=${encodeURIComponent(search.redirect)}` : ""}`),
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
  component: Login,
});

function Login() {
  const navigate = useNavigate();
  const { redirect: redirectTo } = Route.useSearch();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  const queryClient = useQueryClient();

  const signIn = useMutation({
    mutationFn: async (vars: { email: string; password: string }) => {
      const { data } = await authClient.getSession();
      if (data?.session) return data; // Prevent duplicate session creation
      const res = await authClient.signIn.email(vars);
      if (res.error) throw new Error(res.error.message ?? "Sign in failed");
      return res.data;
    },
    // `/` is the apex dispatcher — it routes to the tenant subdomain / onboarding / picker.
    onSuccess: async () => {
      // Invalidate the cached null session and re-fetch with the newly-set cookie
      // so _authed's beforeLoad → ensureQueryData sees the real session.
      await queryClient.fetchQuery({
        queryKey: ["session"],
        queryFn: async () => (await authClient.getSession()).data ?? null,
        staleTime: 0, // bypass the 5-min default — we need a real fetch after sign-in
      });
      const to = safeRedirect(redirectTo);
      if (to) return void hardRedirect(to);
      navigate({ to: "/" });
    },
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
      <p className="auth-alt">
        New to HERA? <Link to="/signup" search={{ redirect: redirectTo }}>Create an account</Link>
      </p>
    </AuthLayout>
  );
}
