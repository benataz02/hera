import { ORPCError } from "@orpc/server";
import { agentPost } from "@hera/b1";
import { agentTarget, viaB1 } from "./b1.ts";
import { PRINTABLE } from "./entity-profiles.ts";

// PDF rendering is the agent's SAP B1 API Gateway hop, not a Service Layer read — so it goes
// through agentPost on a route of its own rather than a transport method. One implementation,
// called by an admin procedure and a portal one; each adds its own fence before getting here.

export type PrintedDocument = { pdf: string; fileName: string };

export async function printDocument(tenantId: string, entity: string, docEntry: number): Promise<PrintedDocument> {
  if (!PRINTABLE.has(entity)) throw new ORPCError("FORBIDDEN", { message: `${entity} cannot be printed` });
  const target = await agentTarget(tenantId);
  return viaB1(async () => (await agentPost(target, "/print", { entity, docEntry })) as PrintedDocument);
}
