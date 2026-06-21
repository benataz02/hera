import { createAuthClient } from "better-auth/react";
import { organizationClient } from "better-auth/client/plugins";

// baseURL defaults to the current origin; auth lives at /api/auth (proxied in dev).
export const authClient = createAuthClient({ plugins: [organizationClient()] });
