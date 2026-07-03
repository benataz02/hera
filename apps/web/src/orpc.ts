import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { RouterClient } from "@orpc/server";
import type { AppRouter } from "@hera/server/router";
import { createTanstackQueryUtils } from "@orpc/tanstack-query";

// Same-origin (dev proxy / prod static) → cookies ride along automatically.
const link = new RPCLink({ url: `${window.location.origin}/rpc` });
export const client: RouterClient<AppRouter> = createORPCClient(link);
export const orpc = createTanstackQueryUtils(client);
