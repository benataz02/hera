import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { organization } from "better-auth/plugins";
import { db } from "@hera/db/client";
import * as schema from "@hera/db/schema";

const baseDomain = process.env.APP_BASE_DOMAIN ?? "localhost";
const envTrustedOrigins = (process.env.APP_TRUSTED_ORIGINS ?? "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);
const trustedOrigins = [
  ...new Set([
    "http://localhost:5173",
    "http://localhost:5174",
    "http://localhost:5175",
    "http://127.0.0.1:5173",
    "http://127.0.0.1:5174",
    "http://127.0.0.1:5175",
    "http://localhost:3000",
    `http://${baseDomain}`,
    `http://*.${baseDomain}`,
    `https://*.${baseDomain}`,
    // dev: apex + tenant subdomains run on the Vite port, e.g. http://acme.lvh.me:5173
    `http://${baseDomain}:5173`,
    `http://${baseDomain}:5174`,
    `http://*.${baseDomain}:5173`,
    `http://*.${baseDomain}:5174`,
    `http://192.168.1.131:5173`,
    ...envTrustedOrigins,
  ]),
];

const socialProviders: Record<string, { clientId: string; clientSecret: string }> = {};
if (process.env.GOOGLE_CLIENT_ID) {
  socialProviders.google = {
    clientId: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET ?? "",
  };
}
if (process.env.MICROSOFT_CLIENT_ID) {
  socialProviders.microsoft = {
    clientId: process.env.MICROSOFT_CLIENT_ID,
    clientSecret: process.env.MICROSOFT_CLIENT_SECRET ?? "",
  };
}

export const auth = betterAuth({
  database: drizzleAdapter(db, { provider: "pg", schema }),
  secret: process.env.BETTER_AUTH_SECRET,
  baseURL: process.env.BETTER_AUTH_URL,
  emailAndPassword: { 
    enabled: true,
		minPasswordLength: 4, // Default is 8, lower it for dev
		maxPasswordLength: 128,
  },
  socialProviders,
  plugins: [organization()],
  databaseHooks: {
    // No mailer in this milestone, so verification is off — but Better Auth blocks
    // listing/accepting org invitations for unverified emails. Treat every signup as
    // verified so the invite-accept flow works.
    // ponytail: auto-verify because there's no email loop; when a mailer lands, drop this
    //           and set emailAndPassword.requireEmailVerification + a sender instead.
    user: {
      create: {
        before: async (user) => ({ data: { ...user, emailVerified: true } }),
      },
    },
    // No active-org hook: the tenant is resolved from the request host (orpc/base.ts),
    // not from session.activeOrganizationId. The web still calls setActive on entry only
    // to keep Better Auth's org-plugin endpoints (invite, active member) on the right org.
  },
  trustedOrigins,
  // Share the session cookie across the apex and every tenant subdomain.
  // ponytail: the `.${baseDomain}` cookie-domain is the one dev knob to verify in a browser
  //           (a `.localhost` domain can be refused); fall back to the Caddy `*.hera.local`
  //           profile for browser dev if so.
  advanced: {
    crossSubDomainCookies: { enabled: true, domain: `.${baseDomain}` },
  },
});
