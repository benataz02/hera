import { afterAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { db, configMasterdata, configModel, configProject, type ConfigCandidate } from "@hera/db";
import type { Entries, ModelDef, ResolvedLookups } from "@hera/config-engine";
import { applySelection, calculateProject } from "../src/orpc/routers/configs.ts";
import { buildQuoteLines, configDocumentCommandId } from "../src/config-quote.ts";
import { router } from "../src/orpc/router.ts";
import { call, makeTenant, makeUser, tenantHeaders } from "./harness.ts";
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
  pricing: { priceExpr: "unitCost * 2", quoteItemCode: "BOX" },
  batchDefaults: [10],
};

/** This model names no query masterdata, so resolving its lookups must not touch the agent. */
const noFetch: QueryRunner = () => Promise.reject(new Error("no live queries expected"));

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

// A query table is tenant masterdata now, not part of any model: one row, referenced by name.
const seedQueryTable = async (name: string, columns: string[]) => {
  await db.insert(configMasterdata).values({
    tenantId, name, kind: "query",
    query: { target: "b1", query: { entitySet: "Items" }, columns },
  }).onConflictDoNothing();
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
  const id = (sel: { candidateIdx: number; batchQty: number }[], c = candidates, tables = {}) =>
    configDocumentCommandId({ tenantId: "t", projectId: "p", candidates: c, selection: sel, tables });

  test("a reordered retry of the same picks keeps its key", () => {
    const a = id([{ candidateIdx: 0, batchQty: 10 }, { candidateIdx: 1, batchQty: 10 }]);
    expect(a).toHaveLength(64);
    expect(id([{ candidateIdx: 1, batchQty: 10 }, { candidateIdx: 0, batchQty: 10 }])).toBe(a);
  });

  test("editing the item matrix changes the key, so a re-post creates a second document", () => {
    const sel = [{ candidateIdx: 0, batchQty: 10 }];
    const a = id(sel, candidates, { parts: [{ code: "A", pieces: 1 }] });
    expect(id(sel, candidates, { parts: [{ code: "A", pieces: 2 }] })).not.toBe(a);
    // and jsonb key reordering must not: Postgres does not preserve object key order
    expect(id(sel, candidates, { parts: [{ pieces: 1, code: "A" }] })).toBe(a);
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
    await db.delete(configMasterdata).where(eq(configMasterdata.tenantId, tenantId));
  });

  test("candidates land on config_project and flip its status; applySelection recomputes overrides", async () => {
    await seedQueryTable("items", ["ItemCode"]);
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
        domain: { kind: "options", ref: { source: "query", table: "priced", valueCol: "ItemCode", columns: ["Price"] } },
      }],
      structure: { sections: [{ key: "main", title: "Main", groups: [{ key: "g", title: "G", params: ["material"] }] }] },
      computed: [],
      constraints: [],
      bom: [{ id: "body", itemCode: "material", qty: "1", price: "material_Price", scrapPct: 0 }],
      routing: [],
      pricing: { priceExpr: "unitCost", quoteItemCode: "BOX" },
      batchDefaults: [1],
    };
    await seedQueryTable("priced", ["ItemCode", "Price"]);
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
    await seedQueryTable("items", ["ItemCode"]);
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

// The merge-production path end to end: rows persist, feed the model's formulas, and become n
// reconciling quotation lines. This is where the money invariant lives.
describe("config tables (integration)", () => {
  const tableModel: ModelDef = {
    name: "Merged sheet",
    parameters: [
      {
        key: "thickness", label: "Thickness", type: "number", ui: "select",
        domain: { kind: "options", ref: { source: "manual", options: [{ value: 2 }, { value: 3 }] } },
      },
    ],
    structure: { sections: [{ key: "main", title: "Main", groups: [{ key: "g", title: "G", params: ["thickness"] }], tables: ["holes"] }] },
    computed: [],
    tables: [
      {
        role: "calc", key: "holes", title: "Holes",
        columns: [
          { key: "size", label: "Size", type: "number", cell: { kind: "input" } },
          { key: "minutes", label: "Minutes", type: "number", cell: { kind: "formula", expr: "size * thickness / 10" } },
        ],
      },
      {
        role: "items", key: "parts", title: "Parts", qtyCol: "pieces", basisCol: "area",
        map: { code: "U_HERA_ItemCode" },
        columns: [
          { key: "code", label: "Code", type: "string", cell: { kind: "input" } },
          { key: "pieces", label: "Pieces", type: "number", cell: { kind: "input" } },
          { key: "area", label: "Area", type: "number", cell: { kind: "input" } },
        ],
      },
    ],
    constraints: [],
    bom: [{ id: "sheet", itemCode: '"SHEET"', qty: "1", price: "10", scrapPct: 0 }],
    // the table's sum is the whole point: drilling time comes from the rows, not from a parameter
    routing: [{ id: "drill", resource: "CNC", setupMin: "5", runMinPerUnit: "holes_minutes", ratePerHour: "60" }],
    pricing: { priceExpr: "unitCost * 2", quoteItemCode: "SHEET-CFG" },
    batchDefaults: [3],
  };

  const rows = {
    holes: [{ size: 10 }, { size: 20 }],
    parts: [
      { code: "PART-A", pieces: 1, area: 2 },
      { code: "PART-B", pieces: 1, area: 1 },
    ],
  };

  test("rows reach the routing, and the split lines sum to the quoted total", async () => {
    const projectId = await seed("merged", tableModel, { thickness: 3 }, [3]);
    await db.update(configProject).set({ tables: rows }).where(eq(configProject.id, projectId));

    const r = await calculateProject(tenantId, projectId, noFetch);
    expect(r.candidates).toHaveLength(1);
    const out = r.candidates[0]!.perBatch[0]!.outputs;
    // holes_minutes = (10*3 + 20*3)/10 = 9 -> total 5 + 9*3 = 32 min at 60/h = 32 EUR labour
    expect(out.ops[0]!.totalMin).toBe(32);

    const [project] = await db.select().from(configProject).where(eq(configProject.id, projectId));
    const withPick = {
      ...project!,
      customer: { cardCode: "C1", cardName: "Acme" },
      selection: [{ candidateIdx: 0, batchQty: 3 }],
    };
    const { lines, value } = buildQuoteLines(withPick, tableModel, { domains: {}, tables: {} });

    expect(lines).toHaveLength(2);
    expect(lines.map((l) => l.U_HERA_ItemCode)).toEqual(["PART-A", "PART-B"]);
    // Quantity is row pieces x batch qty, and the generic configurator item stays the B1 ItemCode
    expect(lines.map((l) => l.Quantity)).toEqual([3, 3]);
    expect(new Set(lines.map((l) => l.ItemCode))).toEqual(new Set(["SHEET-CFG"]));

    // The invariant: what SAP will total has to equal what the dashboard stores. Work in cents —
    // that is the unit the split reconciles in, and the unit B1 rounds each line to.
    const cents = (l: Record<string, unknown>) => Math.round(Number(l.Quantity) * Number(l.UnitPrice) * 100);
    const total = Math.round(out.unitPrice * 3 * 100);
    expect(Math.round(value * 100)).toBe(total);
    expect(lines.reduce((a, l) => a + cents(l), 0)).toBe(total);
    // 2:1 by cost basis — exact up to the one cent largest-remainder has to move to make it add up
    expect(Math.abs(cents(lines[0]!) - (total * 2) / 3)).toBeLessThanOrEqual(1);
    expect(Math.abs(cents(lines[1]!) - total / 3)).toBeLessThanOrEqual(1);
  });

  test("no rows in the item matrix is the pre-feature single line", async () => {
    const projectId = await seed("unmerged", tableModel, { thickness: 3 }, [3]);
    await db.update(configProject).set({ tables: { holes: rows.holes } }).where(eq(configProject.id, projectId));
    await calculateProject(tenantId, projectId, noFetch);
    const [project] = await db.select().from(configProject).where(eq(configProject.id, projectId));
    const { lines } = buildQuoteLines(
      { ...project!, customer: { cardCode: "C1", cardName: "Acme" }, selection: [{ candidateIdx: 0, batchQty: 3 }] },
      tableModel, { domains: {}, tables: {} },
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]!.ItemCode).toBe("SHEET-CFG");
    expect(lines[0]!.Quantity).toBe(3);
  });

  // The third writer the schema's ponytail note warns about: every writer of the calculation's
  // inputs must reset the status, or `status === "calculated"` stops meaning what it claims.
  test("editing rows through configs.update makes the stored calculation stale", async () => {
    const { tenantId: tid, slug } = await makeTenant();
    const admin = await makeUser("admin", tid);
    const ctx = { context: { headers: tenantHeaders(slug, admin.cookie) } };

    const [m] = await db.insert(configModel).values({ tenantId: tid, name: tableModel.name, definition: tableModel })
      .returning({ id: configModel.id });
    const [p] = await db.insert(configProject)
      .values({ tenantId: tid, modelId: m!.id, name: "stale", batches: [3], entries: { thickness: 3 }, tables: rows, createdBy: admin.userId })
      .returning({ id: configProject.id });
    const projectId = p!.id;

    await calculateProject(tid, projectId, noFetch);
    const statusOf = async () =>
      (await db.select().from(configProject).where(eq(configProject.id, projectId)))[0]!.status;
    expect(await statusOf()).toBe("calculated");

    await call(router.configs.update, { id: projectId, tables: { ...rows, holes: [{ size: 99 }] } }, ctx);
    expect(await statusOf()).toBe("draft");

    await db.delete(configProject).where(eq(configProject.tenantId, tid));
    await db.delete(configModel).where(eq(configModel.tenantId, tid));
  });
});
