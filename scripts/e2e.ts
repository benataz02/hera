/**
 * End-to-end smoke test of the live path: cloud -> agent -> Service Layer.
 * Everything on one machine in dev; the exact same script passes through a tunnel in production,
 * because the only difference is the `agentUrl` in the tenant's sap_connection row.
 *
 *   bun --env-file=.env scripts/e2e.ts <slug>
 *
 * Read-only. It does not post a quotation — do that from the Create quote step in the UI, where
 * the dedup UDF and the run's own commandId are in play.
 */
import { db, pool, organization, sapConnection } from "@hera/db";
import { eq } from "drizzle-orm";
import { countOf, nextLinkOf, rowsOf } from "@hera/b1";
import { tenantConnector } from "../apps/server/src/b1.ts";
import { docHistoryQuery, flattenDocs } from "../apps/server/src/doc-history.ts";
import { snapshotQueries } from "../apps/server/src/dashboard-snapshot.ts";

const slug = process.argv[2] ?? process.env.SLUG ?? "alumigraf";
let failures = 0;

async function step(name: string, fn: () => Promise<string>) {
  const started = performance.now();
  try {
    const detail = await fn();
    console.log(`  ok   ${name} — ${detail} (${Math.round(performance.now() - started)}ms)`);
  } catch (e) {
    failures++;
    console.error(`  FAIL ${name} — ${e instanceof Error ? e.message : String(e)}`);
  }
}

const [org] = await db.select({ id: organization.id }).from(organization).where(eq(organization.slug, slug)).limit(1);
if (!org) throw new Error(`no organization '${slug}' — run seed:dev, then seed:agent`);

const [conn] = await db.select().from(sapConnection).where(eq(sapConnection.tenantId, org.id)).limit(1);
if (!conn) throw new Error(`no sap_connection for '${slug}' — run seed:agent`);
const { b1 } = await tenantConnector(org.id);
console.log(`e2e against ${slug} via ${conn.agentUrl}\n`);

await step("agent /health", async () => {
  // The one unauthenticated route; proves the process is up before blaming the Service Layer.
  const res = await fetch(new URL("/health", conn.agentUrl));
  if (!res.ok) throw new Error(`status ${res.status}`);
  return JSON.stringify(await res.json());
});

await step("read a page of Items", async () => {
  const res = await b1.readEntitySet("Items", { select: ["ItemCode", "ItemName"], top: 5 });
  const rows = rowsOf(res.data);
  if (!rows.length) throw new Error("no rows");
  return `${rows.length} rows, first ${rows[0]!.ItemCode}`;
});

await step("value-help paging by $skip", async () => {
  const q = { select: ["ItemCode"], orderby: "ItemCode", top: 2 };
  const p1 = rowsOf((await b1.readEntitySet("Items", q)).data);
  const p2 = rowsOf((await b1.readEntitySet("Items", { ...q, skip: 2 })).data);
  if (!p1.length || !p2.length) throw new Error("a page came back empty");
  if (p1[0]!.ItemCode === p2[0]!.ItemCode) throw new Error("$skip did not move the window");
  return `${p1[0]!.ItemCode} … then ${p2[0]!.ItemCode}`;
});

await step("$count rides on the same read", async () => {
  const res = await b1.readEntitySet("Items", { select: ["ItemCode"], top: 1, count: true });
  const total = countOf(res.data);
  if (total === undefined) throw new Error("no @odata.count in the response");
  return `${total} items`;
});

await step("nextLink follows within the Service Layer", async () => {
  const res = await b1.readEntitySet("Items", { select: ["ItemCode"], maxPageSize: 2 });
  const next = nextLinkOf(res.data);
  if (!next) return "single page — nothing to follow";
  return `${rowsOf((await b1.readNext(next)).data).length} rows on page 2`;
});

await step("/next refuses a foreign origin", async () => {
  await b1.readNext("https://evil.example/steal").then(
    () => { throw new Error("the agent accepted a foreign nextLink"); },
    () => {},
  );
  return "rejected by the agent";
});

await step("doc-history crossjoin", async () => {
  const [anyOrder] = rowsOf((await b1.readEntitySet("Orders", { select: ["CardCode"], top: 1 })).data);
  if (!anyOrder) return "no orders in this company — skipped";
  const cardCode = String(anyOrder.CardCode);
  const res = await b1.crossJoin(docHistoryQuery("Orders", { cardCode, top: 5 }));
  return `${flattenDocs("order", res.data, { cardCode }).length} rows for ${cardCode}`;
});

await step("dashboard snapshot streams", async () => {
  const q = snapshotQueries(new Date());
  const orders = rowsOf((await b1.readEntitySet("Orders", { ...q.orders, top: 5 })).data);
  return `${orders.length} orders in the 13-month window`;
});

await step("scoped $metadata for Orders", async () => {
  const xml = await b1.metadata({
    scope: "entityset", annotation: "labelWithField,labelWithTable", entityset: "Orders", dependency: true,
  });
  if (!xml.includes("EntityType")) throw new Error("no EntityType in the response");
  return `${Math.round(xml.length / 1024)} KB of EDMX`;
});

await pool.end();
console.log(failures ? `\n${failures} step(s) failed` : "\nall steps passed");
process.exit(failures ? 1 : 0);
