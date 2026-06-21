/**
 * Fire a test quote as the dev user and wait for the running agent to sync it to B1.
 * Handy for the live demo without the browser.
 *
 * Run (server + agent up, after seed:dev):  bun scripts/make-quote.ts [name]
 */
import { eq } from "drizzle-orm";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { RouterClient } from "@orpc/server";
import type { AppRouter } from "@hera/server/router";
import { db, pool, quote } from "@hera/db";

const BASE = process.env.BETTER_AUTH_URL ?? "http://localhost:3000";
const AUTH = `${BASE}/api/auth`;
const name = process.argv[2] ?? `CLI quote ${Date.now()}`;

async function main(): Promise<void> {
  const res = await fetch(`${AUTH}/sign-in/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: BASE },
    body: JSON.stringify({ email: "dev@hera.test", password: "hera-dev-1234" }),
  });
  if (!res.ok) throw new Error(`sign-in failed ${res.status} — run 'bun run seed:dev' first`);
  const cookie = res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");

  const user: RouterClient<AppRouter> = createORPCClient(new RPCLink({ url: `${BASE}/rpc`, headers: { cookie } }));
  const q = await user.quote.create({ payload: { name } });
  console.log(`created quote ${q.id} (${q.status}) — waiting for the agent…`);

  const deadline = Date.now() + 30_000;
  for (;;) {
    const [row] = await db.select().from(quote).where(eq(quote.id, q.id));
    if (row!.status === "synced") {
      console.log(`SYNCED -> B1 ${row!.docEntry}`);
      return;
    }
    if (row!.status === "failed") throw new Error("quote failed to sync (check agent logs)");
    if (Date.now() > deadline) throw new Error("timeout waiting for sync (is dev:agent running?)");
    await new Promise((r) => setTimeout(r, 500));
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
