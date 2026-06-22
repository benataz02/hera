/**
 * Backbone end-to-end self-check. Assert-based, no framework.
 *
 *   Part A — cloud loop against REAL Postgres + a running server:
 *            sign-up -> org -> active -> quote.create (atomic outbox) ->
 *            agent pull/claim (attempts, lease, no double-claim, redelivery) ->
 *            ack (idempotent) -> quote.watch SSE flips syncing->synced.
 *
 *   Part B — agent delivery decision against a MOCK B1 (no sandbox needed):
 *            proves "effectively once": attempts==1 POSTs directly; a unique-key
 *            CONFLICT resolves by GET+ack, never a second POST; errors classify
 *            into transient vs permanent.
 *
 * Run:  docker compose up -d db && bun run db:migrate && bun --cwd apps/server dev &
 *       bun run e2e
 *
 * The live-sandbox run (real B1 document created, real DocEntry) is the manual step
 * in INITIAL-SPEC verification — this script proves everything the cloud owns.
 */
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { RouterClient } from "@orpc/server";
import type { AppRouter } from "@hera/server/router";
import { db, pool, quote, agentRequest, tenantIntegration } from "@hera/db";
import type { Model } from "@hera/config-engine";
import { hashToken } from "../apps/server/src/crypto.ts";
import {
  processItem, processRequest, type SlPort, type CloudPort,
  type SlReadPort, type RequestCloudPort,
} from "../apps/agent/src/sync.ts";
import { SlError, parseEdmx } from "../apps/agent/src/service-layer-client.ts";

const BASE = process.env.BETTER_AUTH_URL ?? "http://localhost:3000";
const AUTH = `${BASE}/api/auth`;
const RPC = `${BASE}/rpc`;
const BASE_DOMAIN = process.env.APP_BASE_DOMAIN ?? "localhost";
const AGENT_TOKEN = `e2e-agent-${Date.now()}`;
const stamp = Date.now();

const cookies = (res: Response) =>
  res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");

async function partA(): Promise<void> {
  console.log("Part A — cloud loop");

  // 1. sign up (auto session)
  const email = `e2e+${stamp}@hera.test`;
  const signup = await fetch(`${AUTH}/sign-up/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: BASE },
    body: JSON.stringify({ email, password: "Passw0rd!e2e", name: "E2E" }),
  });
  assert.ok(signup.ok, `sign-up failed ${signup.status}: ${await signup.text()}`);
  const cookie = cookies(signup);
  assert.ok(cookie.includes("="), "session cookie set");

  // 2. create org, 3. set active
  const slug = `acme-${stamp}`;
  const orgRes = await fetch(`${AUTH}/organization/create`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie, origin: BASE },
    body: JSON.stringify({ name: "ACME", slug }),
  });
  const orgJson = (await orgRes.json()) as { id?: string };
  assert.ok(orgRes.ok, `org create failed ${orgRes.status}: ${JSON.stringify(orgJson)}`);
  const orgId = orgJson.id!;

  const setRes = await fetch(`${AUTH}/organization/set-active`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie, origin: BASE },
    body: JSON.stringify({ organizationId: orgId }),
  });
  assert.ok(setRes.ok, `set-active failed ${setRes.status}: ${await setRes.text()}`);

  // 4. seed the agent identity for this tenant
  await db
    .insert(tenantIntegration)
    .values({ tenantId: orgId, agentTokenHash: hashToken(AGENT_TOKEN), companyDb: "STUB" })
    .onConflictDoNothing();

  // Tenant is resolved from the request host. Direct to :3000 has no subdomain, so the
  // user client announces its tenant via X-Forwarded-Host (orpc/base.ts reads it).
  const user: RouterClient<AppRouter> = createORPCClient(
    new RPCLink({ url: RPC, headers: { cookie, "x-forwarded-host": `${slug}.${BASE_DOMAIN}` } }),
  );
  const agent: RouterClient<AppRouter> = createORPCClient(
    new RPCLink({ url: RPC, headers: { authorization: `Bearer ${AGENT_TOKEN}` } }),
  );

  // 5. quote.create writes quote + outbox atomically
  const a = await user.quote.create({ payload: { name: "ACME GmbH" } });
  assert.equal(a.status, "syncing", "new quote is syncing");
  const [qa] = await db.select().from(quote).where(eq(quote.id, a.id));
  assert.equal(qa!.status, "syncing");
  const [oba] = await db.select().from(agentRequest).where(eq(agentRequest.dedupKey, a.id));
  assert.ok(oba, "queue row committed in same tx as the quote");
  assert.equal(oba!.status, "pending");
  assert.equal(oba!.kind, "quote");

  // 6. agent claims it; attempts incremented at claim time
  const pull1 = await agent.sync.pull({ max: 50 });
  const claimedA = pull1.items.find((i) => i.id === oba!.id);
  assert.ok(claimedA, "agent pulled the row");
  assert.equal(claimedA!.attempts, 1, "first claim -> attempts 1 -> POST directly");

  // 7. no double-claim: create B, pull returns B but NOT the leased A
  const b = await user.quote.create({ payload: { name: "Beta" } });
  const [obb] = await db.select().from(agentRequest).where(eq(agentRequest.dedupKey, b.id));
  const pull2 = await agent.sync.pull({ max: 50 });
  assert.ok(pull2.items.find((i) => i.id === obb!.id), "B is claimable");
  assert.ok(!pull2.items.find((i) => i.id === oba!.id), "A's lease blocks a second claim");

  // 8. ack A -> synced (+docEntry), and it is idempotent
  await agent.sync.ack({ id: oba!.id, docEntry: "C-E2E-1" });
  const [qa2] = await db.select().from(quote).where(eq(quote.id, a.id));
  assert.equal(qa2!.status, "synced");
  assert.equal(qa2!.docEntry, "C-E2E-1");
  await agent.sync.ack({ id: oba!.id, docEntry: "C-E2E-1" }); // re-ack must not throw
  const [qa3] = await db.select().from(quote).where(eq(quote.id, a.id));
  assert.equal(qa3!.status, "synced", "re-ack is idempotent");

  // 9. redelivery: expire B's lease -> reclaimed with attempts 2 (triggers GET-before-POST)
  await db.update(agentRequest).set({ leaseUntil: new Date(Date.now() - 1000) }).where(eq(agentRequest.id, obb!.id));
  const pull3 = await agent.sync.pull({ max: 50 });
  const reB = pull3.items.find((i) => i.id === obb!.id);
  assert.ok(reB, "expired lease redelivers");
  assert.equal(reB!.attempts, 2, "redelivery grows attempts -> GET-before-POST path");

  // 10. quote.watch streams syncing -> synced
  const c = await user.quote.create({ payload: { name: "Gamma" } });
  const [obc] = await db.select().from(agentRequest).where(eq(agentRequest.dedupKey, c.id));
  await agent.sync.pull({ max: 50 }); // claim C
  const seen: string[] = [];
  const iter = await user.quote.watch({ id: c.id });
  const consume = (async () => {
    for await (const ev of iter) {
      seen.push(ev.status);
      if (ev.status === "synced") break;
    }
  })();
  await new Promise((r) => setTimeout(r, 200)); // let it emit the initial syncing
  await agent.sync.ack({ id: obc!.id, docEntry: "C-E2E-2" });
  await Promise.race([
    consume,
    new Promise((_, rej) => setTimeout(() => rej(new Error("watch timeout")), 8000)),
  ]);
  assert.ok(seen.includes("syncing"), "watch observed syncing");
  assert.ok(seen.includes("synced"), "watch observed synced");

  // 11. entities: the org creator is owner -> adminProcedure passes. Enable one read-only entity.
  await user.entities.setEnabled({
    entities: [{
      name: "Items",
      keys: ["ItemCode"],
      properties: [{ name: "ItemCode", type: "Edm.String", nullable: false }],
      editable: false,
    }],
  });
  const enabledList = await user.entities.getEnabled();
  assert.ok(enabledList.find((e) => e.name === "Items"), "entity persisted to config");

  // gate (no agent needed): unenabled read and read-only write are rejected up front.
  await assert.rejects(() => user.entities.list({ entity: "Nope" }), /not enabled/i, "list of unenabled -> FORBIDDEN");
  await assert.rejects(() => user.entities.create({ entity: "Items", data: {} }), /read-only/i, "create on read-only -> FORBIDDEN");

  // request/reply round-trip: the browser call parks; we act as the agent and fulfill it.
  const listPromise = user.entities.list({ entity: "Items" });
  let reqId: string | undefined;
  for (let i = 0; i < 30 && !reqId; i++) {
    const p = await agent.sync.pull({ max: 50 });
    reqId = p.items.find((it) => it.kind === "list")?.id;
    if (!reqId) await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok(reqId, "agent pulled the list request");
  await agent.sync.fulfill({ id: reqId!, result: [{ ItemCode: "A1" }] });
  assert.deepEqual(await listPromise, [{ ItemCode: "A1" }], "request/reply returned the agent's result");

  // 12. configurator: model CRUD (admin), linting, and a configured quote that the server
  // re-validates + evaluates before the (unchanged) durable write.
  const model: Model = {
    name: `Cfg ${stamp}`,
    family: "test",
    parameters: [
      { name: "size", label: "Size", type: "enum", domain: { kind: "static", values: ["S", "M", "L"] } },
      { name: "color", label: "Color", type: "enum", domain: { kind: "static", values: ["red", "blue"] } },
    ],
    // "L" is only available in blue — a bidirectional constraint.
    constraints: [{ expr: `size != "L" or color == "blue"`, vars: ["size", "color"] }],
    formulas: [],
    bom: [{ item: `concat("ITEM-", size)`, qtyExpr: "1" }],
    routing: [],
    pricing: { costExpr: "10", markupExpr: "0.2" },
  };
  const saved = await user.config.save({ definition: model });
  assert.ok(saved.id, "model saved");
  assert.ok((await user.config.list()).some((m) => m.id === saved.id), "model appears in list");
  const got = await user.config.get({ id: saved.id });
  assert.equal((got.definition as { name: string }).name, model.name, "get returns the definition");

  // the linter rejects an unparseable expression
  await assert.rejects(
    () => user.config.save({ definition: { ...model, formulas: [{ name: "bad", expr: "1 +" }] } }),
    /./,
    "unparseable formula rejected at save",
  );

  // a valid configuration: server re-validates + computes the BOM, stores it on the quote payload
  const cq = await user.quote.create({
    payload: { name: "Configured" },
    config: { modelId: saved.id, batches: [1], configurations: [{ assignment: { size: "L", color: "blue" } }] },
  });
  assert.equal(cq.status, "syncing", "configured quote created");
  const [cqRow] = await db.select().from(quote).where(eq(quote.id, cq.id));
  const cfg = (cqRow!.payload as { config?: { configurations: { bom: unknown[] }[] } }).config;
  assert.ok(cfg, "config stored on the quote payload");
  assert.equal(cfg!.configurations.length, 1, "one configuration");
  assert.deepEqual(cfg!.configurations[0]!.bom, [{ item: "ITEM-L", qty: 1 }], "server computed the BOM");

  // an inconsistent configuration is rejected by server re-validation (L requires blue)
  await assert.rejects(
    () =>
      user.quote.create({
        payload: { name: "Bad" },
        config: { modelId: saved.id, batches: [1], configurations: [{ assignment: { size: "L", color: "red" } }] },
      }),
    /Invalid configuration/,
    "inconsistent config rejected server-side",
  );

  console.log("  ok");
}

// --- Part B: the delivery decision, mocked B1 ---
function mockCloud() {
  const calls: { ack: unknown[]; nack: unknown[] } = { ack: [], nack: [] };
  const cloud: CloudPort = {
    ack: async (i) => void calls.ack.push(i),
    nack: async (i) => void calls.nack.push(i),
  };
  return { cloud, calls };
}
const UUID = "11111111-1111-1111-1111-111111111111";
const item = (attempts: number) => ({
  id: "i1",
  kind: "quote",
  payload: { data: { name: "X" } },
  dedupKey: UUID,
  attempts,
});

async function partB(): Promise<void> {
  console.log("Part B — agent decision (mock B1)");

  // attempts==1, create ok -> POST directly, no GET, ack
  {
    let gets = 0, posts = 0;
    const sl: SlPort = {
      getBusinessPartner: async () => (gets++, null),
      createBusinessPartner: async (bp) => (posts++, bp.CardCode),
    };
    const { cloud, calls } = mockCloud();
    await processItem(item(1), sl, cloud);
    assert.equal(gets, 0, "attempts=1 skips GET");
    assert.equal(posts, 1, "POSTed once");
    assert.equal(calls.ack.length, 1, "acked");
    assert.equal(calls.nack.length, 0);
  }

  // attempts==2, already exists -> GET, no POST, ack
  {
    let gets = 0, posts = 0;
    const sl: SlPort = {
      getBusinessPartner: async () => (gets++, "QEXISTS"),
      createBusinessPartner: async (bp) => (posts++, bp.CardCode),
    };
    const { cloud, calls } = mockCloud();
    await processItem(item(2), sl, cloud);
    assert.equal(gets, 1, "attempts>1 GETs first");
    assert.equal(posts, 0, "existing -> no POST");
    assert.equal(calls.ack.length, 1);
  }

  // THE invariant: unique-key conflict resolves by GET+ack, never a second POST
  {
    let gets = 0, posts = 0;
    const sl: SlPort = {
      getBusinessPartner: async () => (gets++, "QEXISTS"),
      createBusinessPartner: async () => {
        posts++;
        throw new SlError(400, -2035, "Business Partner code already exists");
      },
    };
    const { cloud, calls } = mockCloud();
    await processItem(item(1), sl, cloud);
    assert.equal(posts, 1, "tried POST once");
    assert.equal(gets, 1, "conflict -> GET to confirm");
    assert.equal(calls.ack.length, 1, "resolved by ack, NOT a duplicate POST");
    assert.equal(calls.nack.length, 0);
  }

  // transient (5xx) -> nack transient
  {
    const sl: SlPort = {
      getBusinessPartner: async () => null,
      createBusinessPartner: async () => {
        throw new SlError(503, undefined, "service unavailable");
      },
    };
    const { cloud, calls } = mockCloud();
    await processItem(item(1), sl, cloud);
    assert.equal((calls.nack[0] as { kind: string }).kind, "transient");
  }

  // business rejection (400, not a conflict) -> nack permanent
  {
    const sl: SlPort = {
      getBusinessPartner: async () => null,
      createBusinessPartner: async () => {
        throw new SlError(400, -10, "Field CardName is mandatory");
      },
    };
    const { cloud, calls } = mockCloud();
    await processItem(item(1), sl, cloud);
    assert.equal((calls.nack[0] as { kind: string }).kind, "permanent");
  }

  console.log("  ok");
}

// --- Part C: EDMX parsing + request dispatch, both pure (no server, no B1) ---
const SAMPLE_EDMX = `<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx Version="1.0" xmlns:edmx="http://schemas.microsoft.com/ado/2007/06/edmx">
  <edmx:DataServices>
    <Schema Namespace="SAPB1">
      <EntityType Name="Item">
        <Key><PropertyRef Name="ItemCode"/></Key>
        <Property Name="ItemCode" Type="Edm.String" Nullable="false"/>
        <Property Name="ItemName" Type="Edm.String"/>
        <Property Name="OnHand" Type="Edm.Double" Nullable="false"/>
      </EntityType>
      <EntityContainer Name="ServiceContainer">
        <EntitySet Name="Items" EntityType="SAPB1.Item"/>
      </EntityContainer>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`;

async function partC(): Promise<void> {
  console.log("Part C — EDMX parse + request dispatch (pure)");

  const schemas = parseEdmx(SAMPLE_EDMX);
  const items = schemas.find((s) => s.name === "Items");
  assert.ok(items, "EntitySet -> schema");
  assert.deepEqual(items!.keys, ["ItemCode"], "key extracted");
  assert.equal(items!.properties.length, 3, "all properties extracted");
  const onHand = items!.properties.find((p) => p.name === "OnHand")!;
  assert.equal(onHand.type, "Edm.Double", "property type");
  assert.equal(onHand.nullable, false, "Nullable=false respected");
  assert.equal(items!.properties.find((p) => p.name === "ItemName")!.nullable, true, "absent Nullable defaults true");

  // dispatch: 'list' -> sl.listEntity(entity, top) -> cloud.fulfill(result)
  {
    const calls: Record<string, unknown> = {};
    const sl: SlReadPort = {
      metadata: async () => [],
      listEntity: async (entity, top) => ((calls.list = { entity, top }), [{ ItemCode: "X" }]),
      getEntity: async () => ({}),
      createEntity: async () => ({}),
      updateEntity: async () => ({ ok: true }),
    };
    const cloud: RequestCloudPort = {
      fulfill: async (i) => void (calls.fulfill = i),
      fail: async (i) => void (calls.fail = i),
    };
    await processRequest({ id: "r1", kind: "list", payload: { entity: "Items", top: 5 } }, sl, cloud);
    assert.deepEqual(calls.list, { entity: "Items", top: 5 }, "list dispatched with params");
    assert.deepEqual(calls.fulfill, { id: "r1", result: [{ ItemCode: "X" }] }, "fulfilled with result");
    assert.equal(calls.fail, undefined, "no fail on success");
  }

  // dispatch error path: SL throws -> cloud.fail (never fulfill)
  {
    let failed: { id: string; error: string } | undefined;
    const sl: SlReadPort = {
      metadata: async () => { throw new Error("boom"); },
      listEntity: async () => [],
      getEntity: async () => ({}),
      createEntity: async () => ({}),
      updateEntity: async () => ({ ok: true }),
    };
    const cloud: RequestCloudPort = {
      fulfill: async () => assert.fail("should not fulfill on error"),
      fail: async (i) => void (failed = i),
    };
    await processRequest({ id: "r2", kind: "metadata", payload: {} }, sl, cloud);
    assert.equal(failed?.id, "r2");
    assert.match(failed!.error, /boom/, "error message forwarded");
  }

  console.log("  ok");
}

const runA = !process.argv.includes("--unit");
try {
  if (runA) await partA();
  await partB();
  await partC();
  console.log("\nE2E PASSED");
} catch (err) {
  console.error("\nE2E FAILED:", err);
  process.exitCode = 1;
} finally {
  await pool.end();
}
