import { ORPCError } from "@orpc/server";
import { z } from "zod";
import { userProcedure } from "../base.ts";
import { assertAgentReady, runRequest } from "./entities.ts";

// The "Query" data source: the agent runs a read-only OData GET against its B1 Service Layer and
// returns the rows. The path is admin-authored (in the model) and resolved by the runtime (filter
// substituted with current picks) before it gets here. B1 creds stay on-prem — same agent hop as
// entities.list. ponytail: only the agent's B1 Service Layer is wired; a Beas/other `source` needs
//           its own client + creds in the agent .env (kept as a label here for that day).
export const configureRouter = {
  query: userProcedure
    .input(z.object({ source: z.string(), path: z.string() }))
    .handler(async ({ input, context }) => {
      if (!input.path.startsWith("/")) throw new ORPCError("BAD_REQUEST", { message: "path must start with /" });
      await assertAgentReady(context.tenantId);
      const result = await runRequest(context.tenantId, "query", { path: input.path, source: input.source });
      // OData lists come back as { value: [...] }; pass the rows straight through.
      const rows = (result as { value?: unknown[] } | unknown[] | null);
      const arr = Array.isArray(rows) ? rows : (rows?.value ?? []);
      return { rows: arr as Record<string, unknown>[] };
    }),
};
