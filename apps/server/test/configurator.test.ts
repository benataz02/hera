import { afterAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { db, configModel, configProject, configRun } from "@hera/db";
import type { ModelDef } from "@hera/config-engine";
import { applySelection, executeRun } from "../src/orpc/routers/configs.ts";
import type { QueryFetcher } from "../src/lookups.ts";

const tenantId = `test-cfg-${crypto.randomUUID()}`;

const model: ModelDef = {
  name: "Test box",
  parameters: [
    {
      key: "size", label: "Size", type: "string", ui: "select",
      domain: { kind: "options", ref: { source: "manual", options: [{ value: "S" }, { value: "L" }] } },
    },
    {
      key: "grade", label: "Grade", type: "string", ui: "select",
      domain: { kind: "options", ref: { source: "query", table: "items", valueCol: "ItemCode" } },
    },
  ],
  structure: { sections: [{ key: "main", title: "Main", groups: [{ key: "g", title: "G", params: ["size", "grade"] }] }] },
  computed: [],
  constraints: [],
  bom: [{ id: "body", itemCode: '"BODY"', qty: 'size == "S" ? 1 : 2', price: "3", scrapPct: 0 }],
  routing: [{ id: "cut", resource: "SAW", setupMin: "10", runMinPerUnit: "1", ratePerHour: "60" }],
  queryTables: [{ name: "items", target: "b1", path: "/Items?$select=ItemCode", columns: ["ItemCode"] }],
  pricing: { priceExpr: "unitCost * 2", quoteItemCode: "BOX" },
  batchDefaults: [10],
};

const fakeFetch: QueryFetcher = async (target, path) => {
  expect(target).toBe("b1");
  expect(path).toBe("/Items?$select=ItemCode");
  return { value: [{ ItemCode: "A" }, { ItemCode: "B" }] };
};

describe.skipIf(!process.env.DATABASE_URL)("configurator run + select (integration)", () => {
  afterAll(async () => {
    await db.delete(configRun).where(eq(configRun.tenantId, tenantId));
    await db.delete(configProject).where(eq(configProject.tenantId, tenantId));
    await db.delete(configModel).where(eq(configModel.tenantId, tenantId));
  });

  test("run snapshots model+lookups+candidates and flips status; select recomputes overrides", async () => {
    const [m] = await db
      .insert(configModel)
      .values({ tenantId, name: model.name, definition: model })
      .returning({ id: configModel.id });
    const [p] = await db
      .insert(configProject)
      .values({ tenantId, modelId: m!.id, name: "proj", batches: [10], entries: {}, createdBy: "tester" })
      .returning({ id: configProject.id });

    const res = await executeRun(tenantId, p!.id, fakeFetch);
    // 2 sizes × 2 grades, nothing constrained away
    expect(res.candidateCount).toBe(4);
    expect(res.capped).toBe(false);

    const [run] = await db
      .select()
      .from(configRun)
      .where(and(eq(configRun.id, res.runId), eq(configRun.tenantId, tenantId)))
      .limit(1);
    expect(run).toBeDefined();
    expect(run!.modelSnapshot.name).toBe("Test box");
    expect(run!.lookupSnapshot.domains.grade).toEqual([
      { value: "A", label: "A" },
      { value: "B", label: "B" },
    ]);
    expect(run!.candidates).toHaveLength(4);

    // Hand-check one candidate (size S, batch 10): material 1×3=3;
    // labor ((10/10+1)/60)×60=2; unitCost 5; priceExpr ×2 → unitPrice 10; batchTotal 100.
    const idx = run!.candidates.findIndex((c) => c.assignment.size === "S");
    const outputs = run!.candidates[idx]!.perBatch[0]!.outputs;
    expect(run!.candidates[idx]!.perBatch[0]!.batchQty).toBe(10);
    expect(outputs.unitCost).toBeCloseTo(5);
    expect(outputs.unitPrice).toBeCloseTo(10);
    expect(outputs.batchTotal).toBeCloseTo(100);

    const [proj] = await db.select().from(configProject).where(eq(configProject.id, p!.id)).limit(1);
    expect(proj!.status).toBe("calculated");

    // select: price override 3 → 4 on the same candidate: unitCost 6, unitPrice 12.
    const selections = applySelection(run!, [
      { candidateIdx: idx, batchQty: 10, overrides: { bom: [{ id: "body", unitPrice: 4 }] } },
    ]);
    expect(selections[0]!.outputs.unitCost).toBeCloseTo(6);
    expect(selections[0]!.outputs.unitPrice).toBeCloseTo(12);

    // out-of-range candidate index is rejected
    expect(() => applySelection(run!, [{ candidateIdx: 99, batchQty: 10 }])).toThrow();
  });

  test("a persisted off-page selection is enriched for derived values and stored in the run snapshot", async () => {
    const offPageModel: ModelDef = {
      name: "Off-page material",
      parameters: [{
        key: "material", label: "Material", type: "string", ui: "select",
        domain: { kind: "options", ref: { source: "query", table: "items", valueCol: "ItemCode", columns: ["Price"] } },
      }],
      structure: { sections: [{ key: "main", title: "Main", groups: [{ key: "g", title: "G", params: ["material"] }] }] },
      computed: [],
      constraints: [],
      bom: [{ id: "body", itemCode: "material", qty: "1", price: "material_Price", scrapPct: 0 }],
      routing: [],
      queryTables: [{ name: "items", target: "b1", path: "/Items?$select=ItemCode,Price", columns: ["ItemCode", "Price"] }],
      pricing: { priceExpr: "unitCost", quoteItemCode: "BOX" },
      batchDefaults: [1],
    };
    const [m] = await db.insert(configModel)
      .values({ tenantId, name: offPageModel.name, definition: offPageModel })
      .returning({ id: configModel.id });
    const [p] = await db.insert(configProject)
      .values({ tenantId, modelId: m!.id, name: "off-page", batches: [1], entries: { material: "B" }, createdBy: "tester" })
      .returning({ id: configProject.id });

    const paths: string[] = [];
    const fetcher: QueryFetcher = async (_target, path, opts) => {
      expect(opts).toEqual({ all: false });
      paths.push(path);
      const encoded = /[?&]\$filter=([^&]*)/.exec(path)?.[1];
      if (!encoded) return { value: [{ ItemCode: "A", Price: 3 }] };
      expect(decodeURIComponent(encoded)).toBe("ItemCode eq 'B'");
      return { value: [{ ItemCode: "B", Price: 11 }] };
    };

    const result = await executeRun(tenantId, p!.id, fetcher);
    const [run] = await db.select().from(configRun)
      .where(and(eq(configRun.id, result.runId), eq(configRun.tenantId, tenantId))).limit(1);

    expect(paths).toHaveLength(2);
    expect(run!.lookupSnapshot.domains.material).toEqual([{ value: "A", label: "3" }]);
    expect(run!.lookupSnapshot.tables.items!.rows).toEqual([["A", 3], ["B", 11]]);
    expect(run!.candidates[0]!.perBatch[0]!.outputs.unitCost).toBe(11);
  });

  // The auto-calculate on the process page fires a run ~1s after every field edit. Each run used to
  // re-GET every query table through the agent; this counts the fetches so that regression is loud.
  test("recalculating does not re-fetch query tables: reuse short-circuits, and the cache absorbs the rest", async () => {
    const [m] = await db
      .insert(configModel)
      .values({ tenantId, name: model.name, definition: model })
      .returning({ id: configModel.id });
    const [p] = await db
      .insert(configProject)
      .values({ tenantId, modelId: m!.id, name: "no-refetch", batches: [10], entries: {}, createdBy: "tester" })
      .returning({ id: configProject.id });

    let fetches = 0;
    const counting: QueryFetcher = async (target, path) => {
      fetches++;
      return fakeFetch(target, path);
    };

    const first = await executeRun(tenantId, p!.id, counting);
    expect(fetches).toBe(1);

    // Nothing changed: the same run comes back, and the reuse check must return before any
    // lookup resolution — so the fetch count cannot move.
    const again = await executeRun(tenantId, p!.id, counting);
    expect(again.runId).toBe(first.runId);
    expect(fetches).toBe(1);

    // A real edit: a genuinely new run, but the model is untouched so its lookups come from cache.
    await db.update(configProject).set({ entries: { size: "S" } }).where(eq(configProject.id, p!.id));
    const edited = await executeRun(tenantId, p!.id, counting);
    expect(edited.runId).not.toBe(first.runId);
    expect(fetches).toBe(1);
  });

  test("one configuration = one run: recalculating replaces the row instead of appending", async () => {
    const [m] = await db
      .insert(configModel)
      .values({ tenantId, name: model.name, definition: model })
      .returning({ id: configModel.id });
    const [p] = await db
      .insert(configProject)
      .values({ tenantId, modelId: m!.id, name: "one-run", batches: [10], entries: {}, createdBy: "tester" })
      .returning({ id: configProject.id });

    const first = await executeRun(tenantId, p!.id, fakeFetch);

    // Different entries → a genuinely different calculation, so the reuse check cannot short-circuit.
    await db.update(configProject).set({ entries: { size: "S" } }).where(eq(configProject.id, p!.id));
    const second = await executeRun(tenantId, p!.id, fakeFetch);
    expect(second.runId).not.toBe(first.runId);

    const rows = await db
      .select({ id: configRun.id })
      .from(configRun)
      .where(and(eq(configRun.projectId, p!.id), eq(configRun.tenantId, tenantId)));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(second.runId);
  });
});
