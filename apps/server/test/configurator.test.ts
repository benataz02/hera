import { afterAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { db, configModel, configProject, type ConfigCandidate } from "@hera/db";
import type { Entries, ModelDef, ResolvedLookups } from "@hera/config-engine";
import { applySelection, calculateProject } from "../src/orpc/routers/configs.ts";
import { configDocumentCommandId } from "../src/config-quote.ts";
import type { QueryRunner } from "../src/lookups.ts";

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
  queryTables: [{ name: "items", target: "b1", query: { entitySet: "Items" }, columns: ["ItemCode"] }],
  pricing: { priceExpr: "unitCost * 2", quoteItemCode: "BOX" },
  batchDefaults: [10],
};

const fakeFetch: QueryRunner = async (target, query, columns) => {
  expect(target).toBe("b1");
  expect(query).toEqual({ entitySet: "Items" });
  expect(columns).toEqual(["ItemCode"]);
  return { rows: [{ ItemCode: "A" }, { ItemCode: "B" }] };
};

const lookups: ResolvedLookups = {
  domains: { grade: [{ value: "A", label: "A" }, { value: "B", label: "B" }] },
  tables: { items: { columns: ["ItemCode"], rows: [["A"], ["B"]] } },
};

const seed = async (name: string, def: ModelDef, entries: Entries, batches: number[]) => {
  const [m] = await db.insert(configModel).values({ tenantId, name: def.name, definition: def })
    .returning({ id: configModel.id });
  const [p] = await db.insert(configProject)
    .values({ tenantId, modelId: m!.id, name, batches, entries, createdBy: "tester" })
    .returning({ id: configProject.id });
  return p!.id;
};

const load = async (id: string) =>
  (await db.select().from(configProject).where(eq(configProject.id, id)).limit(1))[0]!;

// configDocumentCommandId is pure — this half runs without a database.
describe("configDocumentCommandId", () => {
  const candidates = [
    { assignment: { size: "S" }, perBatch: [{ batchQty: 10, outputs: {} as never }] },
    { assignment: { size: "L" }, perBatch: [{ batchQty: 10, outputs: {} as never }] },
  ] satisfies ConfigCandidate[];
  const id = (sel: { candidateIdx: number; batchQty: number }[], c = candidates) =>
    configDocumentCommandId({ tenantId: "t", projectId: "p", candidates: c, selection: sel });

  test("a reordered retry of the same picks keeps its key", () => {
    const a = id([{ candidateIdx: 0, batchQty: 10 }, { candidateIdx: 1, batchQty: 10 }]);
    expect(a).toHaveLength(64);
    expect(id([{ candidateIdx: 1, batchQty: 10 }, { candidateIdx: 0, batchQty: 10 }])).toBe(a);
  });

  test("dropping a pick or changing a batch quantity changes the key", () => {
    const a = id([{ candidateIdx: 0, batchQty: 10 }, { candidateIdx: 1, batchQty: 10 }]);
    expect(id([{ candidateIdx: 0, batchQty: 10 }])).not.toBe(a);
    expect(id([{ candidateIdx: 0, batchQty: 20 }, { candidateIdx: 1, batchQty: 10 }])).not.toBe(a);
  });

  // The reason the hash covers assignments and not indices: a recalculate replaces the candidate
  // list, so "candidate 0" can silently come to mean a different configuration. If the key did not
  // move with it, the U_HERA_DedupKey pre-check would hand back a quotation for the old one.
  test("the same index against a different calculation is a different key", () => {
    const a = id([{ candidateIdx: 0, batchQty: 10 }]);
    const recalculated = [
      { assignment: { size: "L" }, perBatch: [{ batchQty: 10, outputs: {} as never }] },
    ] satisfies ConfigCandidate[];
    expect(id([{ candidateIdx: 0, batchQty: 10 }], recalculated)).not.toBe(a);
  });
});

describe.skipIf(!process.env.DATABASE_URL)("calculateProject (integration)", () => {
  afterAll(async () => {
    await db.delete(configProject).where(eq(configProject.tenantId, tenantId));
    await db.delete(configModel).where(eq(configModel.tenantId, tenantId));
  });

  test("candidates land on config_project and flip its status; applySelection recomputes overrides", async () => {
    const id = await seed("proj", model, {}, [10]);

    const res = await calculateProject(tenantId, id, fakeFetch);
    // 2 sizes × 2 grades, nothing constrained away
    expect(res.candidateCount).toBe(4);
    expect(res.capped).toBe(false);

    const project = await load(id);
    expect(project.status).toBe("calculated");
    expect(project.calculatedAt).not.toBeNull();
    expect(project.candidates).toHaveLength(4);

    // Hand-check one candidate (size S, batch 10): material 1×3=3;
    // labor ((10/10+1)/60)×60=2; unitCost 5; priceExpr ×2 → unitPrice 10; batchTotal 100.
    const idx = project.candidates.findIndex((c) => c.assignment.size === "S");
    const outputs = project.candidates[idx]!.perBatch[0]!.outputs;
    expect(project.candidates[idx]!.perBatch[0]!.batchQty).toBe(10);
    expect(outputs.unitCost).toBeCloseTo(5);
    expect(outputs.unitPrice).toBeCloseTo(10);
    expect(outputs.batchTotal).toBeCloseTo(100);

    // select: price override 3 → 4 on the same candidate: unitCost 6, unitPrice 12.
    const selections = applySelection(model, lookups, project.candidates, [
      { candidateIdx: idx, batchQty: 10, overrides: { bom: [{ id: "body", unitPrice: 4 }] } },
    ]);
    expect(selections[0]!.outputs.unitCost).toBeCloseTo(6);
    expect(selections[0]!.outputs.unitPrice).toBeCloseTo(12);

    // out-of-range candidate index is rejected
    expect(() => applySelection(model, lookups, project.candidates, [{ candidateIdx: 99, batchQty: 10 }])).toThrow();
  });

  test("a persisted off-page selection is enriched before pricing", async () => {
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
      queryTables: [{ name: "items", target: "b1", query: { entitySet: "Items" }, columns: ["ItemCode", "Price"] }],
      pricing: { priceExpr: "unitCost", quoteItemCode: "BOX" },
      batchDefaults: [1],
    };
    const id = await seed("off-page", offPageModel, { material: "B" }, [1]);

    const reads: (string | undefined)[] = [];
    const fetcher: QueryRunner = async (_target, query) => {
      reads.push(query.filter);
      if (!query.filter) return { rows: [{ ItemCode: "A", Price: 3 }] };
      expect(query.filter).toBe("ItemCode eq 'B'");
      return { rows: [{ ItemCode: "B", Price: 11 }] };
    };

    await calculateProject(tenantId, id, fetcher);
    // Canonical first page, then the exact fetch for the off-page value the project already holds.
    expect(reads).toHaveLength(2);
    const project = await load(id);
    expect(project.candidates[0]!.perBatch[0]!.outputs.unitCost).toBe(11);
  });

  // The auto-calculate on the process page fires ~1s after every field edit. Each calculation used
  // to re-GET every query table through the agent; this counts the fetches so that regression is loud.
  test("recalculating does not re-fetch query tables: reuse short-circuits, and the cache absorbs the rest", async () => {
    const id = await seed("no-refetch", model, {}, [10]);

    let fetches = 0;
    const counting: QueryRunner = async (target, query, columns, opts) => {
      fetches++;
      return fakeFetch(target, query, columns, opts);
    };

    const first = await calculateProject(tenantId, id, counting);
    expect(first.reused).toBe(false);
    expect(fetches).toBe(1);

    // Nothing changed: the reuse check must return before any lookup resolution, so the fetch
    // count cannot move and the stored candidates come straight back.
    const again = await calculateProject(tenantId, id, counting);
    expect(again.reused).toBe(true);
    expect(again.candidateCount).toBe(first.candidateCount);
    expect(fetches).toBe(1);

    // Chati's path asks for entries the project does not have yet — that cannot reuse, and it is
    // the only case the entries/batches comparison decides on its own.
    const proposed = await calculateProject(tenantId, id, counting, { entries: { size: "S" }, batches: [10] });
    expect(proposed.reused).toBe(false);
    expect(proposed.candidateCount).toBe(2); // size pinned to S, two grades left

    // A real edit through the API: configs.update writes entries AND resets the status, which is
    // the invariant that lets `status === "calculated"` stand in for "these entries produced these
    // candidates". Reuse must not fire.
    await db.update(configProject).set({ entries: { size: "L" }, status: "draft" }).where(eq(configProject.id, id));
    const edited = await calculateProject(tenantId, id, counting);
    expect(edited.reused).toBe(false);
    expect(edited.candidateCount).toBe(2); // size pinned to L, two grades left

    // The model was never touched, so none of that resolved a query table again.
    expect(fetches).toBe(1);
  });

  test("editing the model invalidates the stored calculation", async () => {
    const id = await seed("model-edit", model, {}, [10]);
    await calculateProject(tenantId, id, fakeFetch);
    expect((await calculateProject(tenantId, id, fakeFetch)).reused).toBe(true);

    const { modelId } = await load(id);
    await db.update(configModel).set({ updatedAt: new Date(Date.now() + 1000) })
      .where(eq(configModel.id, modelId));
    expect((await calculateProject(tenantId, id, fakeFetch)).reused).toBe(false);
  });
});
