import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { organization } from "better-auth/plugins";
import { db } from "@hera/db/client";
import * as schema from "@hera/db/schema";
import { ensureConfiguratorVariants, ensureEntityVariants } from "./seed-variants.ts";

const baseDomain = process.env.APP_BASE_DOMAIN ?? "lvh.me";

export const auth = betterAuth({
  database: drizzleAdapter(db, { provider: "pg", schema }),
  secret: process.env.BETTER_AUTH_SECRET,
  baseURL: process.env.BETTER_AUTH_URL,
  emailAndPassword: { 
    enabled: true,
		minPasswordLength: 4, // Default is 8, lower it for dev
		maxPasswordLength: 128,
  },
  socialProviders: {
    google: {
      clientId: process.env.GOOGLE_CLIENT_ID ?? "",
      clientSecret: process.env.GOOGLE_CLIENT_SECRET ?? "",
    },
    microsoft: {
      clientId: process.env.MICROSOFT_CLIENT_ID ?? "",
      clientSecret: process.env.MICROSOFT_CLIENT_SECRET ?? "",
    }
  },
  plugins: [
    organization({
      organizationHooks: {
        // org = tenant. The configurator lists are variant-backed and there is no "enable" event to
        // seed them from, so a new tenant gets its Standard views here or it lands on a viewless list.
        afterCreateOrganization: async ({ organization: org, user }) => {
          await ensureConfiguratorVariants(org.id, user.id);
          await ensureEntityVariants(org.id, user.id);
        },
      },
    }),
  ],
  // Cheap session reads: every oRPC call resolves a session, and the tenant/role boundary
  // (membershipFromHost) is a live DB join on top of it. Safe to cache because nothing reads
  // session.activeOrganizationId. Cost: a revoked session stays valid for up to maxAge.
  session: { cookieCache: { enabled: true, maxAge: 300 } },
  // Auth lives on the apex, but the app POSTs (sign-out) from every tenant subdomain, so those
  // origins need trusting; baseURL's own origin is trusted automatically. A pattern without
  // `://` is matched against URL.host — which includes the port — hence both forms: prod
  // (`acme.hera.app`) and dev (`acme.lvh.me:5173`).
  trustedOrigins: [`*.${baseDomain}`, `*.${baseDomain}:*`, `http://192.168.1.134:5173`],
  advanced: {
    crossSubDomainCookies: { enabled: true, domain: `.${baseDomain}` },
  },
});
