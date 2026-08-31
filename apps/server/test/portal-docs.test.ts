import { afterEach, describe, expect, test } from "bun:test";
import { db, configModel } from "@hera/db";
import { call, makeTenant, makeUser, bindClient, tenantHeaders, TEST_MODEL } from "./harness.ts";
import { startMockAgent, connectTenant, type MockAgent } from "./mock-agent.ts";
import { router } from "../src/orpc/router.ts";

// The portal document surface. Two rules carry everything here:
//   1. every read is ANDed with the caller's own CardCode, added AFTER the spec is compiled, so
//      a client's own filter can neither replace it nor observe it;
//   2. the schema a portal read compiles against is filtered to the allowlist, so a field
//      outside it is dropped from $select and *throws* if it appears in a filter.

const code = (p: Promise<unknown>) => p.then(() => "OK", (e) => (e as { code?: string }).code ?? "ERR");
const EMPTY = { select: [], filter: [], orderby: [], filterBar: [] };

const edmx = await Bun.file(
  new URL("../../../packages/b1/test/fixtures/entity-metadata.edmx", import.meta.url),
).text();

let agent: MockAgent | null = null;
afterEach(() => { agent?.stop(); agent = null; });

async function setup() {
  const { tenantId, slug } = await makeTenant();
  const a = await makeUser("client", tenantId);
  await bindClient(tenantId, a.userId, "CARD-A", "Client A");
  const b = await makeUser("client", tenantId);
  await bindClient(tenantId, b.userId, "CARD-B", "Client B");

  agent = startMockAgent({
    Orders: [
      { DocEntry: 1, DocNum: 901, CardCode: "CARD-A", CardName: "Client A", DocDate: "2026-08-01",
        DocTotal: 100, GrossProfit: 40, SalesPersonCode: 7, DiscountPercent: 5,
        DocumentLines: [{ LineNum: 0, ItemCode: "A1", Quantity: 2, UnitPrice: 5, LineTotal: 10, GrossProfit: 4 }] },
      { DocEntry: 2, DocNum: 902, CardCode: "CARD-B", CardName: "Client B", DocDate: "2026-08-02",
        DocTotal: 200, DocumentLines: [] },
    ],
    Quotations: [], DeliveryNotes: [], Invoices: [],
  });
  agent.metadata.xml = edmx;
  await connectTenant(tenantId, agent);

  return {
    tenantId, slug, agent,
    ctxA: { context: { headers: tenantHeaders(slug, a.cookie) } },
    ctxB: { context: { headers: tenantHeaders(slug, b.cookie) } },
  };
}

describe.skipIf(!process.env.DATABASE_URL)("portal.docs", () => {
  test("every list read is ANDed with the caller's CardCode", async () => {
    const s = await setup();
    await call(router.portal.docs.rows, { entity: "Orders", spec: EMPTY, top: 10 }, s.ctxA);
    const read = s.agent.calls.findLast((c) => c.route === "/entity-set")!;
    expect(String(read.body.query.filter)).toContain("CardCode eq 'CARD-A'");
  });

  test("the client's own filter is kept AND still fenced", async () => {
    const s = await setup();
    await call(router.portal.docs.rows, {
      entity: "Orders", spec: { ...EMPTY, filter: [{ field: "DocNum", op: "eq", value: 901 }] }, top: 10,
    }, s.ctxA);
    const f = String(s.agent.calls.findLast((c) => c.route === "/entity-set")!.body.query.filter);
    expect(f).toContain("DocNum eq 901");
    expect(f).toContain("CardCode eq 'CARD-A'");
  });

  test("a filter naming a field outside the allowlist is refused, not silently dropped", async () => {
    const s = await setup();
    expect(await code(call(router.portal.docs.rows, {
      entity: "Orders", spec: { ...EMPTY, filter: [{ field: "GrossProfit", op: "gt", value: 0 }] }, top: 10,
    }, s.ctxA))).toBe("BAD_REQUEST");
  });

  test("a select naming a field outside the allowlist never reaches $select", async () => {
    const s = await setup();
    await call(router.portal.docs.rows, {
      entity: "Orders", spec: { ...EMPTY, select: ["DocNum", "GrossProfit"] }, top: 10,
    }, s.ctxA);
    const sel = s.agent.calls.findLast((c) => c.route === "/entity-set")!.body.query.select as string[];
    expect(sel).toContain("DocNum");
    expect(sel).not.toContain("GrossProfit");
    expect(sel).not.toContain("CardCode");
  });

  // The field the fence is made of. GrossProfit above is absent from B1's schema too; CardCode is
  // on the entity and removed only by the allowlist, so this is what proves portalSchema fences.
  test("a client cannot name CardCode itself — refused in a filter, dropped from a sort", async () => {
    const s = await setup();
    expect(await code(call(router.portal.docs.rows, {
      entity: "Orders", spec: { ...EMPTY, filter: [{ field: "CardCode", op: "eq", value: "CARD-B" }] }, top: 10,
    }, s.ctxA))).toBe("BAD_REQUEST");

    await call(router.portal.docs.rows, {
      entity: "Orders", spec: { ...EMPTY, orderby: [{ field: "CardCode", dir: "asc" }] }, top: 10,
    }, s.ctxA);
    const q = s.agent.calls.findLast((c) => c.route === "/entity-set")!.body.query;
    expect(q.orderby).toBeUndefined();
    expect(String(q.filter)).toBe("CardCode eq 'CARD-A'");
  });

  test("an entity outside PORTAL_ENTITIES is refused before any read", async () => {
    const s = await setup();
    expect(await code(call(router.portal.docs.rows, { entity: "BusinessPartners", spec: EMPTY, top: 10 }, s.ctxA)))
      .not.toBe("OK");
    expect(s.agent.calls.some((c) => c.route === "/entity-set")).toBe(false);
  });

  test("one() refuses another CardCode's document", async () => {
    const s = await setup();
    expect(await code(call(router.portal.docs.one, { entity: "Orders", key: 1 }, s.ctxB))).toBe("NOT_FOUND");
    expect(await code(call(router.portal.docs.one, { entity: "Orders", key: 1 }, s.ctxA))).toBe("OK");
  });

  test("one() returns nothing outside the allowlist — header or line", async () => {
    const s = await setup();
    const { row } = await call(router.portal.docs.one, { entity: "Orders", key: 1 }, s.ctxA);
    for (const leaked of ["GrossProfit", "SalesPersonCode", "DiscountPercent", "CardCode", "CardName"])
      expect(row).not.toHaveProperty(leaked);
    expect(row).toMatchObject({ DocNum: 901, DocTotal: 100 });
    const lines = row.DocumentLines as Record<string, unknown>[];
    expect(lines[0]).toMatchObject({ ItemCode: "A1", LineTotal: 10 });
    expect(lines[0]).not.toHaveProperty("GrossProfit");
  });

  test("schema() is filtered to the allowlist, lines included", async () => {
    const s = await setup();
    const schema = await call(router.portal.docs.schema, { entity: "Orders" }, s.ctxA);
    const names = schema.fields.map((f) => f.name);
    expect(names).toContain("DocNum");
    expect(names).not.toContain("CardCode");
    const lines = schema.fields.find((f) => f.name === "DocumentLines");
    expect(lines?.fields?.map((f) => f.name) ?? []).not.toContain("GrossProfit");
  });

  test("print refuses another CardCode's document and a non-printable entity", async () => {
    const s = await setup();
    expect(await code(call(router.portal.docs.print, { entity: "Orders", docEntry: 1 }, s.ctxB))).toBe("NOT_FOUND");
    expect(await code(call(router.portal.docs.print, { entity: "BusinessPartners", docEntry: 1 }, s.ctxA)))
      .not.toBe("OK");
    const out = await call(router.portal.docs.print, { entity: "Orders", docEntry: 1 }, s.ctxA);
    expect(out.fileName).toBe("Orders-1.pdf");
  });

  test("an internal member cannot reach the portal document surface", async () => {
    const s = await setup();
    const plain = await makeUser("member", s.tenantId);
    const ctx = { context: { headers: tenantHeaders(s.slug, plain.cookie) } };
    expect(await code(call(router.portal.docs.rows, { entity: "Orders", spec: EMPTY, top: 10 }, ctx))).toBe("FORBIDDEN");
  });

  test("chain is empty until the project is quoted, and never crosses CardCodes", async () => {
    const s = await setup();
    const [model] = await db.insert(configModel)
      .values({ tenantId: s.tenantId, name: TEST_MODEL.name, definition: TEST_MODEL, portal: true })
      .returning({ id: configModel.id });
    const { id } = await call(router.portal.projects.create, { modelId: model!.id, name: "A's bracket" }, s.ctxA);

    // No run, so no b1DocEntry, so nothing to walk — and no B1 read is made at all.
    expect(await call(router.portal.docs.chain, { projectId: id }, s.ctxA)).toEqual([]);
    expect(s.agent.calls.some((c) => c.route === "/cross-join")).toBe(false);

    expect(await code(call(router.portal.docs.chain, { projectId: id }, s.ctxB))).toBe("NOT_FOUND");
  });
});
