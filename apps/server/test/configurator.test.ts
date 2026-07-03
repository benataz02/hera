import { afterAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { db, configModel, configProject, configRun, pool } from "@hera/db";
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
      domain: { kind: "options", ref: { source: "query", target: "b1", path: "/Items?$select=ItemCode", valueField: "ItemCode" } },
    },
  ],
  structure: { sections: [{ key: "main", title: "Main", groups: [{ key: "g", title: "G", params: ["size", "grade"] }] }] },
  computed: [],
  constraints: [],
  bom: [{ id: "body", itemCode: '"BODY"', qty: 'size == "S" ? 1 : 2', price: "3", scrapPct: 0 }],
  routing: [{ id: "cut", resource: "SAW", setupMin: "10", runMinPerUnit: "1", ratePerHour: "60" }],
  queryTables: [],
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
    await pool.end();
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
});
