import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { RPCHandler } from "@orpc/server/fetch";
import { auth } from "./auth.ts";
import { router } from "./orpc/router.ts";
import { startHistorySync } from "./history-sync.ts";

const app = new Hono();
const rpc = new RPCHandler(router);

startHistorySync();

// Layer 1 identity — Better Auth owns /api/auth/*.
app.all("/api/auth/*", (c) => auth.handler(c.req.raw));

// oRPC — both browser (session) and agent (bearer) procedures live here.
app.use("/rpc/*", async (c, next) => {
  const { matched, response } = await rpc.handle(c.req.raw, {
    prefix: "/rpc",
    context: { headers: c.req.raw.headers },
  });
  if (matched) return c.newResponse(response.body, response);
  await next();
});

// Serve the built SPA in production. In dev the SPA runs on Vite and proxies /rpc + /api here.
const webDist = process.env.WEB_DIST ?? "../web/dist";
app.use("/*", serveStatic({ root: webDist }));
app.get("/*", serveStatic({ path: `${webDist}/index.html` }));

export default { port: Number(process.env.PORT ?? 3000), fetch: app.fetch };
