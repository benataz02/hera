/**
 * LIVE verification against a real SAP B1 Service Layer (test DB).
 * Runs the actual agent code path — real ServiceLayerClient, real POST to B1 —
 * NOT the mock. Proves the full loop end-to-end and the idempotency guarantee.
 *
 * Needs (in root .env): DATABASE_URL, BETTER_AUTH_URL, HERA_AGENT_TOKEN,
 *   B1_BASE_URL (.../b1s/v1), B1_COMPANY_DB, B1_USER, B1_PASS, [B1_INSECURE_TLS=true]
 *
 * Run (server + db already up):  bun scripts/live-b1.ts
 */
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { RouterClient } from "@orpc/server";
import type { AppRouter } from "@hera/server/router";
import { db, pool, quote, agentRequest, tenantIntegration } from "@hera/db";
import { hashToken } from "../apps/server/src/crypto.ts";
import { ServiceLayerClient, SlError } from "../apps/agent/src/service-layer-client.ts";
import { processItem, cardCodeFromDedup, type CloudPort, type Item } from "../apps/agent/src/sync.ts";

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var ${name}`);
  return v;
}

const BASE = process.env.BETTER_AUTH_URL ?? "http://localhost:3000";
const AUTH = `${BASE}/api/auth`;
const RPC = `${BASE}/rpc`;
const AGENT_TOKEN = env("HERA_AGENT_TOKEN");
const stamp = Date.now();
const cookies = (res: Response) =>
  res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");

async function main(): Promise<void> {
  // --- real B1 client; fail fast if login doesn't work ---
  const sl = new ServiceLayerClient({
    baseUrl: env("B1_BASE_URL"),
    companyDb: env("B1_COMPANY_DB"),
    user: env("B1_USER"),
    pass: env("B1_PASS"),
    insecureTls: process.env.B1_INSECURE_TLS === "true",
  });
  // Probe login via a harmless GET (throws SlError on bad creds/endpoint).
  await sl.getBusinessPartner("__hera_probe_nonexistent__");
  console.log("B1 login OK ->", process.env.B1_BASE_URL);

  // Autodiscovery probe: real $metadata parse + a generic list (the read path's SL side).
  const sets = await sl.metadata();
  assert.ok(sets.find((s) => s.name === "BusinessPartners"), "discovery found BusinessPartners");
  console.log(`  discovered ${sets.length} entity sets`);
  const itemRows = await sl.listEntity("Items", 5);
  console.log(`  listed ${itemRows.length} Items (read path OK)`);

  // --- seed tenant + user + integration, then create a quote (via the real API) ---
  const email = `live+${stamp}@hera.test`;
  const signup = await fetch(`${AUTH}/sign-up/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: BASE },
    body: JSON.stringify({ email, password: "Passw0rd!live", name: "Live" }),
  });
  assert.ok(signup.ok, `sign-up failed ${signup.status}`);
  const cookie = cookies(signup);

  const slug = `live-${stamp}`;
  const orgRes = await fetch(`${AUTH}/organization/create`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie, origin: BASE },
    body: JSON.stringify({ name: "Live", slug }),
  });
  const orgId = ((await orgRes.json()) as { id: string }).id;
  assert.ok(orgId, "org created");
  await fetch(`${AUTH}/organization/set-active`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie, origin: BASE },
    body: JSON.stringify({ organizationId: orgId }),
  });
  await db
    .insert(tenantIntegration)
    .values({ tenantId: orgId, agentTokenHash: hashToken(AGENT_TOKEN), b1BaseUrl: process.env.B1_BASE_URL, companyDb: process.env.B1_COMPANY_DB })
    .onConflictDoNothing();

  const baseDomain = process.env.APP_BASE_DOMAIN ?? "localhost";
  const user: RouterClient<AppRouter> = createORPCClient(
    new RPCLink({ url: RPC, headers: { cookie, "x-forwarded-host": `${slug}.${baseDomain}` } }),
  );
  const orpcAgent: RouterClient<AppRouter> = createORPCClient(
    new RPCLink({ url: RPC, headers: { authorization: `Bearer ${AGENT_TOKEN}` } }),
  );
  const cloud: CloudPort = {
    ack: (i) => orpcAgent.sync.ack(i),
    nack: (i) => orpcAgent.sync.nack(i),
  };

  const q = await user.quote.create({ payload: { name: `HERA Live ${stamp}` } });
  const code = cardCodeFromDedup(q.id);
  console.log(`quote ${q.id} -> B1 CardCode ${code}`);

  // --- agent runs the REAL path: pull, POST to B1, ack ---
  const pull1 = await orpcAgent.sync.pull({ max: 10 });
  const item1 = pull1.items.find((i) => i.dedupKey === q.id) as Item | undefined;
  assert.ok(item1, "agent pulled the quote");
  assert.equal(item1.attempts, 1, "first delivery -> POST directly");
  await processItem(item1, sl, cloud);

  // verify cloud state flipped and the BP really exists in B1
  const [q2] = await db.select().from(quote).where(eq(quote.id, q.id));
  assert.equal(q2!.status, "synced", "quote synced");
  assert.equal(q2!.docEntry, code, "quote carries the B1 key");
  assert.equal(await sl.getBusinessPartner(code), code, "BusinessPartner exists in B1");
  console.log("  created + synced, BP present in B1");

  // --- idempotency: force redelivery (attempts>1) -> GET-before-POST acks, no 2nd POST ---
  const [ob] = await db.select().from(agentRequest).where(eq(agentRequest.dedupKey, q.id));
  await db.update(agentRequest).set({ status: "in_flight", leaseUntil: new Date(Date.now() - 1000) }).where(eq(agentRequest.id, ob!.id));
  const pull2 = await orpcAgent.sync.pull({ max: 10 });
  const item2 = pull2.items.find((i) => i.dedupKey === q.id) as Item | undefined;
  assert.ok(item2, "redelivered");
  assert.equal(item2.attempts, 2, "attempts grew -> GET-before-POST path");
  await processItem(item2, sl, cloud);
  const [q3] = await db.select().from(quote).where(eq(quote.id, q.id));
  assert.equal(q3!.status, "synced", "still synced, no error on redelivery");
  console.log("  redelivery acked via GET-before-POST (no second POST)");

  // --- the underlying guarantee: a real duplicate POST is physically rejected by B1 ---
  const dup = await sl
    .createBusinessPartner({ CardCode: code, CardName: "dup attempt" })
    .then(() => null)
    .catch((e) => e);
  assert.ok(dup instanceof SlError, "B1 rejects a duplicate CardCode");
  console.log(`  B1 rejected duplicate CardCode (${(dup as SlError).status}) -> unique key is the real guarantee`);

  console.log("\nLIVE B1 PASSED");
}

main()
  .catch((err) => {
    console.error("\nLIVE B1 FAILED:", err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
