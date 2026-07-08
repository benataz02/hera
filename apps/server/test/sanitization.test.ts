import { describe, expect, test } from "bun:test";
import { db, configModel } from "@hera/db";
import { call, makeTenant, makeUser, bindClient, tenantHeaders, TEST_MODEL } from "./harness.ts";
import { router } from "../src/orpc/router.ts";

describe("spec test 2 — portal responses carry no cost data", () => {
  test("run + get expose only batchQty/unitPrice/total per batch", async () => {
    const { tenantId, slug } = await makeTenant();
    const [m] = await db.insert(configModel)
      .values({ tenantId, name: TEST_MODEL.name, definition: TEST_MODEL, portal: true })
      .returning({ id: configModel.id });
    const c = await makeUser("client", tenantId);
    await bindClient(tenantId, c.userId);
    const ctx = { context: { headers: tenantHeaders(slug, c.cookie) } };

    const { id } = await call(router.portal.projects.create, { modelId: m!.id, name: "req" }, ctx);
    await call(router.portal.projects.update, { id, entries: { coated: false } }, ctx);
    const run = await call(router.portal.run, { projectId: id }, ctx);
    expect(run.candidateCount).toBe(2); // material open: steel | alu

    const got = await call(router.portal.projects.get, { id }, ctx);
    // Scoped to latestRun: that's where a leaked RunCandidate.perBatch[].outputs would surface.
    // model.definition.bom legitimately stays present-but-empty for shape compatibility (see the
    // dedicated assertions below), so checking the whole `got` blob for the bare substring "bom"
    // would false-positive on that harmless empty array — same for "priceExpr" (dummy "0" placeholder).
    const json = JSON.stringify(got.latestRun);
    for (const k of ['"outputs"', '"bom"', '"ops"', '"materialPerUnit"', '"laborPerUnit"', '"unitCost"', '"batchTotal"', '"priceExpr"']) {
      expect(json).not.toContain(k);
    }
    const cand = got.latestRun!.candidates[0]!;
    expect(Object.keys(cand.perBatch[0]!).sort()).toEqual(["batchQty", "total", "unitPrice"]);
    expect(cand.perBatch.map((b) => b.batchQty)).toEqual([100, 500]);
    expect(cand.perBatch[0]!.unitPrice).toBeGreaterThan(0);
    // stripped model def: parameters stay (form needs them), cost sections are empty
    expect(got.model.definition.parameters.length).toBe(2);
    expect(got.model.definition.bom).toEqual([]);
    expect(got.model.definition.routing).toEqual([]);
  });

  test("run on an unpublished model fails with the portal message", async () => {
    const { tenantId, slug } = await makeTenant();
    const [m] = await db.insert(configModel)
      .values({ tenantId, name: TEST_MODEL.name, definition: TEST_MODEL, portal: true })
      .returning({ id: configModel.id });
    const c = await makeUser("client", tenantId);
    await bindClient(tenantId, c.userId);
    const ctx = { context: { headers: tenantHeaders(slug, c.cookie) } };
    const { id } = await call(router.portal.projects.create, { modelId: m!.id, name: "req" }, ctx);
    await db.update(configModel).set({ portal: false });
    const err = await call(router.portal.run, { projectId: id }, ctx).catch((e) => e as Error);
    expect((err as Error).message).toContain("no longer available");
  });
});
