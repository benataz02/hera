import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { organization } from "better-auth/plugins";
import { db } from "@hera/db/client";
import * as schema from "@hera/db/schema";
import { ensureConfiguratorVariants } from "./seed-variants.ts";

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
        },
      },
    }),
  ],
  advanced: {
    crossSubDomainCookies: { enabled: true, domain: `.${baseDomain}` },
    disableOriginCheck: true
  },
});
