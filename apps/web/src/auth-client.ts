import { createAuthClient } from "better-auth/react";
import { organizationClient } from "better-auth/client/plugins";

// baseURL defaults to the current origin; auth lives at /api/auth (proxied in dev).
export const authClient = createAuthClient({ plugins: [organizationClient()] });

export type Session = Awaited<ReturnType<typeof authClient.getSession>>["data"];

/** The one session query. Spread it into ensureQueryData/useQuery/fetchQuery — never re-declare it. */
export const sessionQuery = {
  queryKey: ["session"] as const,
  queryFn: async (): Promise<Session> => (await authClient.getSession()).data ?? null,
  staleTime: 5 * 60_000,
};
