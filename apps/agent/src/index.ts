import { readFileSync } from "node:fs";
import { createHash, timingSafeEqual } from "node:crypto";
import { DirectTransport, ServiceLayer, B1Error, type B1Transport } from "@hera/b1";
import { ApiGateway, type ApiGatewayConfig } from "./api-gateway.ts";

// One agent service, one B1 company database. A second company DB means a second agent on a
// second port with its own agent.json — which is what keeps ServiceLayer exactly as the sample
// designed it (companyDb fixed at construction, one session, one licence slot) and removes the
// per-request company plumbing entirely.
//
// The HTTP surface is operation-shaped, not a generic proxy: each operation is its own endpoint,
// so it can be authorized and audited on-prem, and a leaked cloud token cannot issue arbitrary
// Service Layer calls.

type ServiceConfig = {
  url?: string; slUrl?: string; basePath?: string; auth?: "session" | "basic";
  companyDb?: string; user: string; pass: string;
  allowSelfSigned?: boolean; timeoutMs?: number;
};
type AgentConfig = { port?: number; secret: string; b1: ServiceConfig; beas?: ServiceConfig; apiGateway?: ApiGatewayConfig };

const configPath = process.env.HERA_AGENT_CONFIG ?? "agent.json";
const config = JSON.parse(readFileSync(configPath, "utf8")) as AgentConfig;
if (!config.secret) throw new Error(`${configPath}: "secret" is required — it is the only auth in dev`);

const logger = { info: (m: string) => console.log(m), warn: (m: string, x?: unknown) => console.warn(m, x ?? "") };

const build = (c: ServiceConfig) =>
  new ServiceLayer({ ...c, url: c.url ?? c.slUrl ?? "", logger });

const services = { b1: build(config.b1), ...(config.beas ? { beas: build(config.beas) } : {}) };
const transports: Record<string, B1Transport> = Object.fromEntries(
  Object.entries(services).map(([k, sl]) => [k, new DirectTransport(sl)]),
);

// Optional: an install without a Reporting Service simply has no apiGateway block, and /print
// answers 503 rather than the agent refusing to start.
const gateway = config.apiGateway ? new ApiGateway(config.apiGateway, logger) : null;

const sha = (s: string) => createHash("sha256").update(s).digest();
const secretHash = sha(config.secret);
/** Hashed compare so the lengths always match and the comparison stays constant-time. */
function authorized(req: Request): boolean {
  const header = req.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  return timingSafeEqual(sha(token), secretHash);
}

type Handler = (t: B1Transport, body: any) => Promise<unknown>;

const routes: Record<string, Handler> = {
  "/entity-set": (t, b) => t.readEntitySet(b.entitySet, b.query),
  "/entity": (t, b) => t.readEntity(b.entitySet, b.key, b.query),
  "/next": (t, b) => t.readNext(b.nextLink, b.maxPageSize),
  "/cross-join": (t, b) => t.crossJoin(b),
  "/create": (t, b) => t.createEntity(b.entitySet, b.data, { prefer: b.prefer }),
  "/update": (t, b) => t.updateEntity(b.entitySet, b.key, b.data, { etag: b.etag }),
  "/delete": (t, b) => t.deleteEntity(b.entitySet, b.key, { etag: b.etag }),
  "/metadata": async (t, b) => ({ status: 200, data: await t.metadata(b) }),
};

const fail = (status: number, code: string | number | null, message: string) =>
  Response.json({ error: { status, code, message } }, { status: status === 401 ? 401 : 502 });

const server = Bun.serve({
  port: config.port ?? 4000,
  idleTimeout: 255,
  async fetch(req) {
    const { pathname } = new URL(req.url);
    if (pathname === "/health") return Response.json({ ok: true, services: Object.keys(services) });
    if (!authorized(req)) return fail(401, null, "Bad agent secret");
    if (req.method !== "POST") return fail(405, null, "Method not allowed");

    logger.info(`${req.method} ${pathname}`);
    try {
      // Print is not a B1Transport operation: it talks to a different service on a different
      // port, so it sits beside the /{target}/{operation} split rather than inside it.
      if (pathname === "/print") {
        if (!gateway) throw new B1Error(503, null, "No apiGateway block in agent.json — printing is not configured");
        const b = (await req.json()) as { entity?: unknown; docEntry?: unknown };
        return Response.json(await gateway.exportPdf(String(b.entity ?? ""), Number(b.docEntry)));
      }

      const [, target, ...rest] = pathname.split("/");
      const transport = target ? transports[target] : undefined;
      const handler = routes[`/${rest.join("/")}`];
      if (!transport) return fail(404, null, `Unknown target '${target}'`);
      if (!handler) return fail(404, null, `Unknown operation '${pathname}'`);

      return Response.json(await handler(transport, await req.json()));
    } catch (e) {
      if (e instanceof B1Error) {
        logger.warn(`${pathname}: ${e.message}`);
        return fail(e.status, e.code, e.message);
      }
      logger.warn(`${pathname}:`, e instanceof Error ? e.message : String(e));
      return fail(502, null, e instanceof Error ? e.message : String(e));
    }
  },
});

console.log(`hera-agent on :${server.port} — services: ${Object.keys(services).join(", ")}${gateway ? " + print" : ""}`);

// Release the B1 licence slot when the service stops.
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, async () => {
    await Promise.all(Object.values(services).map((s) => s.logout()));
    process.exit(0);
  });
}
