import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { RouterClient } from "@orpc/server";
import type { AppRouter } from "@hera/server/router";
import { createTanstackQueryUtils } from "@orpc/tanstack-query";

// Same-origin (dev proxy / prod static) → cookies ride along automatically.
const link = new RPCLink({ url: `${window.location.origin}/rpc` });
export const client: RouterClient<AppRouter> = createORPCClient(link);
export const orpc = createTanstackQueryUtils(client);

/**
 * Identity on the current tenant subdomain: session + membership + role in one call.
 * `_authed`'s beforeLoad primes it and re-runs on every navigation, so it is cached for the
 * page session — see the note there about why the role is deliberately not revalidated.
 */
export const meQuery = orpc.me.queryOptions({ staleTime: Infinity });

export type RouterOutputs = {
  dashboard: { overview: Awaited<ReturnType<typeof client.dashboard.overview>> };
};
