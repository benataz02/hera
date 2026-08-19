import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { RouterClient } from "@orpc/server";
import type { AppRouter } from "@hera/server/router";
import { ServiceLayerClient, type EntitySchema } from "./service-layer-client.ts";
import { BeasClient } from "./beas-client.ts";
import { processRequest, type RequestCloudPort, type RequestRow, type WriteRequestRow } from "./sync.ts";
import { processWrite, type WriteCloudPort } from "./write-sync.ts";
import {
  parseWriteCapabilities,
  validateWriteCapabilities,
  type WriteCapability,
} from "./write-capabilities.ts";

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
const cloud: RequestCloudPort = {
  fulfill: (i) => orpc.sync.fulfill(i),
  fail: (i) => orpc.sync.fail(i),
};
const writeCloud: WriteCloudPort = {
  ack: (i) => orpc.sync.ack(i),
  nack: (i) => orpc.sync.nack(i),
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

const configuredCapabilities = parseWriteCapabilities(process.env.B1_CREATE_CAPABILITIES);
/** Last EDMX-validated list; re-sent on each pull so checked_at stays within the ~90s stale window. */
let lastValidatedCapabilities: WriteCapability[] | undefined;

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

/** Validate against EDMX, cache, and heartbeat. Startup + after metadata only. */
async function validateAndReport(schemas: EntitySchema[]): Promise<WriteCapability[]> {
  const { valid, errors } = validateWriteCapabilities(configuredCapabilities, schemas);
  for (const e of errors) console.warn("[agent] create capability rejected:", e);
  lastValidatedCapabilities = valid;
  await orpc.sync.heartbeat({ capabilities: valid });
  console.log(
    `[agent] reported ${valid.length} create capability(ies):`,
    valid.map((c) => `${c.entity}:${c.dedupField}`).join(",") || "(none)",
  );
  return valid;
}

/** Re-send cached list (no EDMX hop) so write_capabilities_checked_at stays fresh while pulling. */
async function refreshCapabilityHeartbeat(): Promise<void> {
  if (lastValidatedCapabilities === undefined) return;
  await orpc.sync.heartbeat({ capabilities: lastValidatedCapabilities });
}

async function main(): Promise<void> {
  const url = process.env.HERA_CLOUD_RPC_URL;
  console.log("[agent] starting pull loop ->", url);
  try {
    const schemas = await sl.metadata();
    await validateAndReport(schemas);
  } catch (e) {
    console.error("[agent] initial create-capability report failed:", msg(e));
  }
  for (;;) {
    const t0 = Date.now();
    try {
      const { items } = await orpc.sync.pull({ max: 20 });
      // ponytail: per-cycle heartbeat for debugging the connect issue; drop once stable.
      console.log(`[agent] pull ok after ${Date.now() - t0}ms: ${items.length} item(s)`);
      try {
        await refreshCapabilityHeartbeat();
      } catch (e) {
        console.error("[agent] capability heartbeat refresh failed:", msg(e));
      }
      for (const row of items) {
        // Per-item isolation: a poison row dead-letters; it never crash-loops the batch.
        try {
          if ((row as RequestRow).kind === "write") {
            // Durable writes: ack/nack only after SAP confirmation. Never fulfill/fail.
            await processWrite(row as WriteRequestRow, sl, writeCloud);
            continue;
          }
          const result = await processRequest(row as RequestRow, sl, cloud, beas);
          if ((row as RequestRow).kind === "metadata" && Array.isArray(result)) {
            try {
              await validateAndReport(result as EntitySchema[]);
            } catch (e) {
              console.error("[agent] post-metadata capability report failed:", msg(e));
            }
          }
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
