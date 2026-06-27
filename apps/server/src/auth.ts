import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { organization } from "better-auth/plugins";
import { db } from "@hera/db/client";
import * as schema from "@hera/db/schema";

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
  plugins: [organization()],
  advanced: {
    crossSubDomainCookies: { enabled: true, domain: `.${baseDomain}` },
    disableOriginCheck: true
  },
});
