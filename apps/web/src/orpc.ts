import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { RouterClient } from "@orpc/server";
import type { AppRouter } from "@hera/server/router";
import { createTanstackQueryUtils } from "@orpc/tanstack-query";

// Same-origin (dev proxy / prod static) → cookies ride along automatically.
const link = new RPCLink({ url: `${window.location.origin}/rpc` });
export const client: RouterClient<AppRouter> = createORPCClient(link);
export const orpc = createTanstackQueryUtils(client);

// Query key for a master-data source resolution (Configurator value-help). Shared so the editor can
// invalidate the exact entry the runtime caches with staleTime/gcTime: Infinity — keep them in sync.
export const mdResolveKey = (id: string) => ["cfg-md", id] as const;
