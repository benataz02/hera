import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { RouterClient } from "@orpc/server";
import type { AppRouter } from "@hera/server/router";
import { ServiceLayerClient } from "./service-layer-client.ts";
import { BeasClient } from "./beas-client.ts";
import {
  processItem, processRequest, type CloudPort, type RequestCloudPort, type Item, type RequestRow,
} from "./sync.ts";

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var ${name}`);
  return v;
}

const link = new RPCLink({
  url: env("HERA_CLOUD_RPC_URL"),
  headers: { authorization: `Bearer ${env("HERA_AGENT_TOKEN")}` },
});
const orpc: RouterClient<AppRouter> = createORPCClient(link);
const cloud: CloudPort & RequestCloudPort = {
  ack: (i) => orpc.sync.ack(i),
  nack: (i) => orpc.sync.nack(i),
  fulfill: (i) => orpc.sync.fulfill(i),
  fail: (i) => orpc.sync.fail(i),
};

const sl = new ServiceLayerClient({
  baseUrl: env("B1_BASE_URL"),
  companyDb: env("B1_COMPANY_DB"),
  user: env("B1_USER"),
  pass: env("B1_PASS"),
  insecureTls: process.env.B1_INSECURE_TLS === "true",
  timeoutMs: process.env.B1_TIMEOUT_MS ? Number(process.env.B1_TIMEOUT_MS) : undefined,
});

// Optional second on-prem source; only tenants whose models use target:"beas" need it.
const beas = process.env.BEAS_BASE_URL
  ? new BeasClient({
      baseUrl: process.env.BEAS_BASE_URL,
      user: process.env.BEAS_USER,
      pass: process.env.BEAS_PASS,
      insecureTls: process.env.BEAS_INSECURE_TLS === "true",
    })
  : undefined;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// ponytail: diagnostic detail — Bun hides the real syscall error in .cause/.code; flatten them.
const msg = (e: unknown): string => {
  if (!(e instanceof Error)) return String(e);
  const code = (e as { code?: string }).code;
  const cause = (e as { cause?: unknown }).cause;
  const causeMsg = cause instanceof Error ? cause.message : cause ? String(cause) : "";
  return [e.message, code && `code=${code}`, causeMsg && `cause=${causeMsg}`]
    .filter(Boolean)
    .join(" | ");
};

async function main(): Promise<void> {
  const url = process.env.HERA_CLOUD_RPC_URL;
  console.log("[agent] starting pull loop ->", url);
  for (;;) {
    const t0 = Date.now();
    try {
      const { items } = await orpc.sync.pull({ max: 20 });
      // ponytail: per-cycle heartbeat for debugging the connect issue; drop once stable.
      console.log(`[agent] pull ok after ${Date.now() - t0}ms: ${items.length} item(s)`);
      for (const row of items) {
        // Per-item isolation: a poison row dead-letters; it never crash-loops the batch.
        try {
          if (row.kind === "quote") await processItem(row as Item, sl, cloud);
          else await processRequest(row as RequestRow, sl, cloud, beas);
        } catch (e) {
          console.error("[agent] item failed (lease will redeliver):", row.id, msg(e));
        }
      }
    } catch (e) {
      console.error(`[agent] pull failed after ${Date.now() - t0}ms (url=${url}), backing off 3s:`, msg(e));
      await sleep(3000);
    }
  }
}

main();
