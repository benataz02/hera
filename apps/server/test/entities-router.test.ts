import { afterEach, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { db, entityMeta } from "@hera/db";
import { call, makeTenant, makeUser, tenantHeaders } from "./harness.ts";
import { startMockAgent, connectTenant, type MockAgent } from "./mock-agent.ts";
import { router } from "../src/orpc/router.ts";

// The generic entity surface against a mock agent: what B1 exposes, what a saved view compiles
// to, and — the part that matters — where writing stops.

const code = (p: Promise<unknown>) => p.then(() => "OK", (e) => (e as { code?: string }).code ?? "ERR");
const EMPTY = { select: [], filter: [], orderby: [], filterBar: [] };

const edmx = await Bun.file(
  new URL("../../../packages/b1/test/fixtures/entity-metadata.edmx", import.meta.url),
).text();

let agent: MockAgent | null = null;
afterEach(() => { agent?.stop(); agent = null; });

async function setup() {
  const { tenantId, slug } = await makeTenant();
  const admin = await makeUser("admin", tenantId);
  const ictx = { context: { headers: tenantHeaders(slug, admin.cookie) } };
  agent = startMockAgent({
    Orders: [
      { DocEntry: 1, DocNum: 901, CardCode: "C0001", DocDate: "2026-08-01", "@odata.etag": 'W/"1"',
        DocumentLines: [{ LineNum: 0, ItemCode: "A1", Quantity: 2, UnitPrice: 5, LineTotal: 10 }] },
    ],
    DeliveryNotes: [],
  });
  agent.metadata.xml = edmx;
  await connectTenant(tenantId, agent);
  return { tenantId, slug, ictx, agent };
}

describe.skipIf(!process.env.DATABASE_URL)("entities router", () => {
  test("lists what B1 exposes, with business categories", async () => {
    const s = await setup();
    const out = await call(router.entities.list, {}, s.ictx);
    const orders = out.entities.find((e) => e.name === "Orders");
    expect(orders).toMatchObject({ label: "Sales Order", table: "ORDR", entityClass: "standard" });
    expect(orders!.categories).toContain("sales");
    // A UDT B1 declares but the static mapping has never heard of still shows up.
    expect(out.entities.find((e) => e.name === "U_ProjectData")!.categories).toContain("user-defined-table");
  });

  test("schema is parsed once and cached per tenant", async () => {
    const s = await setup();
    const schema = await call(router.entities.schema, { entity: "Orders" }, s.ictx);
    expect(schema.keys).toEqual(["DocEntry"]);
    expect(schema.fields.find((f) => f.name === "CardCode")!.lookup)
      .toEqual({ entitySet: "BusinessPartners", keyField: "CardCode" });

    const [cached] = await db.select().from(entityMeta)
      .where(and(eq(entityMeta.tenantId, s.tenantId), eq(entityMeta.entityName, "Orders"))).limit(1);
    expect(cached!.json.table).toBe("ORDR");

    const before = s.agent.calls.filter((c) => c.route === "/metadata").length;
    await call(router.entities.schema, { entity: "Orders" }, s.ictx);
    expect(s.agent.calls.filter((c) => c.route === "/metadata").length).toBe(before);
  });

  test("an entity B1 does not expose never reaches a URL", async () => {
    const s = await setup();
    expect(await code(call(router.entities.schema, { entity: "MadeUp" }, s.ictx))).toBe("BAD_REQUEST");
    expect(s.agent.calls.some((c) => c.route === "/entity-set")).toBe(false);
  });

  test("a saved view compiles to OData server-side; the browser sends no filter string", async () => {
    const s = await setup();
    const out = await call(router.entities.rows, {
      entity: "Orders",
      spec: { ...EMPTY, select: ["CardCode"], filter: [{ field: "CardCode", op: "eq", value: "C0001" }] },
      top: 10,
    }, s.ictx);
    expect(out.rows).toHaveLength(1);
    const read = s.agent.calls.findLast((c) => c.route === "/entity-set")!;
    expect(read.body.query).toMatchObject({ filter: "CardCode eq 'C0001'", select: ["DocEntry", "CardCode"], top: 10 });
  });

  test("one row comes back with the ETag that makes an edit safe", async () => {
    const s = await setup();
    const out = await call(router.entities.one, { entity: "Orders", key: 1 }, s.ictx);
    expect(out.etag).toBe('W/"1"');
    expect(out.row.CardCode).toBe("C0001");
  });

  test("key quoting follows $metadata, not whether the value looks numeric", async () => {
    const s = await setup();
    await call(router.entities.one, { entity: "Orders", key: "1" }, s.ictx);
    expect(s.agent.calls.findLast((c) => c.route === "/entity")!.body.key).toBe(1);

    await code(call(router.entities.one, { entity: "Items", key: "0000377" }, s.ictx));
    expect(s.agent.calls.findLast((c) => c.route === "/entity")!.body.key).toBe("0000377");
  });

  describe("writes", () => {
    test("a non-curated entity is read-only, and the rule is the router's, not the UI's", async () => {
      const s = await setup();
      expect(await code(call(router.entities.update, {
        entity: "U_ProjectData", key: 1, etag: 'W/"1"', data: { Name: "x" },
      }, s.ictx))).toBe("FORBIDDEN");
      expect(s.agent.calls.some((c) => c.route === "/update")).toBe(false);
    });

    test("a curated entity accepts only the fields its profile names", async () => {
      const s = await setup();
      expect(await code(call(router.entities.update, {
        entity: "Orders", key: 1, etag: 'W/"1"', data: { DocTotal: 99999 },
      }, s.ictx))).toBe("BAD_REQUEST");
      expect(s.agent.calls.some((c) => c.route === "/update")).toBe(false);
    });

    test("an allowed edit goes through with If-Match and returns the new ETag", async () => {
      const s = await setup();
      const out = await call(router.entities.update, {
        entity: "Orders", key: 1, etag: 'W/"1"', data: { Comments: "changed", U_Mine: "kept" },
      }, s.ictx);
      expect(s.agent.store.Orders![0]).toMatchObject({ Comments: "changed", U_Mine: "kept" });
      expect(out.etag).not.toBe('W/"1"');
    });

    // The concurrent-edit data-loss path, and the single clearest reason MCP is not in this path.
    test("a stale ETag is a conflict, never a silent overwrite", async () => {
      const s = await setup();
      await call(router.entities.update, { entity: "Orders", key: 1, etag: 'W/"1"', data: { Comments: "first" } }, s.ictx);
      expect(await code(call(router.entities.update, {
        entity: "Orders", key: 1, etag: 'W/"1"', data: { Comments: "second" },
      }, s.ictx))).toBe("CONFLICT");
      expect(s.agent.store.Orders![0]!.Comments).toBe("first");
    });

    test("create refuses a payload missing a required field", async () => {
      const s = await setup();
      expect(await code(call(router.entities.create, { entity: "Orders", data: { Comments: "x" } }, s.ictx)))
        .toBe("BAD_REQUEST");
    });
  });

  describe("document copy", () => {
    test("Order -> Delivery links every line back to its source", async () => {
      const s = await setup();
      const out = await call(router.entities.copy, {
        sourceEntity: "Orders", targetEntity: "DeliveryNotes", docEntry: 1,
      }, s.ictx);
      expect(out.entity).toBe("DeliveryNotes");
      const created = s.agent.store.DeliveryNotes![0]!;
      expect(created.CardCode).toBe("C0001");
      const [line] = created.DocumentLines as Record<string, unknown>[];
      expect(line).toMatchObject({ BaseType: 17, BaseEntry: 1, BaseLine: 0, ItemCode: "A1", Quantity: 2 });
      expect(line!.LineTotal).toBeUndefined(); // recalculated by B1, never copied
    });

    test("an unsupported conversion is refused before anything is posted", async () => {
      const s = await setup();
      expect(await code(call(router.entities.copy, {
        sourceEntity: "Orders", targetEntity: "Quotations", docEntry: 1,
      }, s.ictx))).toBe("BAD_REQUEST");
      expect(s.agent.calls.some((c) => c.route === "/create")).toBe(false);
    });
  });

  describe("nav pins", () => {
    test("empty until the first pin; pin and unpin persist per admin", async () => {
      const s = await setup();
      expect(await call(router.entities.navPins, undefined, s.ictx)).toEqual({ entities: [] });
      expect(await call(router.entities.setNavPin, { name: "Orders", label: "Sales Order", pinned: true }, s.ictx))
        .toEqual({ entities: [{ name: "Orders", label: "Sales Order" }] });
      expect(await call(router.entities.navPins, undefined, s.ictx))
        .toEqual({ entities: [{ name: "Orders", label: "Sales Order" }] });
      expect(await call(router.entities.setNavPin, { name: "Orders", label: "Sales Order", pinned: false }, s.ictx))
        .toEqual({ entities: [] });
    });

    test("pins are per user and per tenant", async () => {
      const s = await setup();
      await call(router.entities.setNavPin, { name: "Orders", label: "Sales Order", pinned: true }, s.ictx);

      const other = await makeUser("admin", s.tenantId);
      const otherCtx = { context: { headers: tenantHeaders(s.slug, other.cookie) } };
      expect(await call(router.entities.navPins, undefined, otherCtx)).toEqual({ entities: [] });

      const b = await makeTenant();
      const bAdmin = await makeUser("admin", b.tenantId);
      const bCtx = { context: { headers: tenantHeaders(b.slug, bAdmin.cookie) } };
      expect(await call(router.entities.navPins, undefined, bCtx)).toEqual({ entities: [] });
    });

    test("a 21st pin is refused", async () => {
      const s = await setup();
      for (let i = 0; i < 20; i++) {
        await call(router.entities.setNavPin, { name: `E${i}`, label: `E${i}`, pinned: true }, s.ictx);
      }
      expect(await code(call(router.entities.setNavPin, { name: "E20", label: "E20", pinned: true }, s.ictx)))
        .toBe("BAD_REQUEST");
    });

    test("member and client cannot discover entities", async () => {
      const s = await setup();
      const member = await makeUser("member", s.tenantId);
      const mctx = { context: { headers: tenantHeaders(s.slug, member.cookie) } };
      expect(await code(call(router.entities.list, {}, mctx))).toBe("FORBIDDEN");
      expect(await code(call(router.entities.navPins, undefined, mctx))).toBe("FORBIDDEN");

      const client = await makeUser("client", s.tenantId);
      const cctx = { context: { headers: tenantHeaders(s.slug, client.cookie) } };
      expect(await code(call(router.entities.list, {}, cctx))).toBe("FORBIDDEN");
    });
  });
});
