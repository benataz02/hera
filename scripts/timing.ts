import { eq } from "drizzle-orm";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { RouterClient } from "@orpc/server";
import type { AppRouter } from "@hera/server/router";
import { db, pool, agentRequest } from "@hera/db";

const BASE = process.env.BETTER_AUTH_URL ?? "http://localhost:3000";
const res = await fetch(`${BASE}/api/auth/sign-in/email`, {
  method: "POST",
  headers: { "content-type": "application/json", origin: BASE },
  body: JSON.stringify({ email: "dev@hera.test", password: "hera-dev-1234" }),
});
const cookie = res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
const user: RouterClient<AppRouter> = createORPCClient(new RPCLink({ url: `${BASE}/rpc`, headers: { cookie } }));

const t0 = Date.now();
const q = await user.quote.create({ payload: { name: "timing" } });
let lastStatus = "";
for (;;) {
  const [row] = await db.select().from(agentRequest).where(eq(agentRequest.dedupKey, q.id));
  if (row && row.status !== lastStatus) {
    console.log(`+${Date.now() - t0}ms  ${row.status}${row.docEntry ? " " + row.docEntry : ""}`);
    lastStatus = row.status;
  }
  if (row && (row.status === "done" || row.status === "failed")) break;
  if (Date.now() - t0 > 40000) { console.log("timeout"); break; }
  await new Promise((r) => setTimeout(r, 100));
}
await pool.end();
process.exit(0);
