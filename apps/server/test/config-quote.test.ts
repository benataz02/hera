import { describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import {
  db,
  configModel,
  configProject,
  configRun,
} from "@hera/db";
import { call, makeTenant, makeUser, bindClient, tenantHeaders, TEST_MODEL } from "./harness.ts";
import { router } from "../src/orpc/router.ts";
import {
  buildQuoteSeed,
  configDocumentCommandId,
  quotedTotals,
  type ConfigRunRow,
} from "../src/config-quote.ts";
import { computeOutputs } from "@hera/config-engine";

const code = (p: Promise<unknown>) =>
  p.then(() => "OK", (e) => (e as { code?: string }).code ?? "ERR");

async function setupCalculated(opts?: { currency?: string; customer?: boolean }) {
  const { tenantId, slug } = await makeTenant();
  const definition = {
    ...TEST_MODEL,
    pricing: {
      ...TEST_MODEL.pricing,
      ...(opts?.currency !== undefined ? { currency: opts.currency } : {}),
    },
  };
  const [m] = await db
    .insert(configModel)
    .values({ tenantId, name: definition.name, definition, portal: true })
    .returning({ id: configModel.id });
  const member = await makeUser("member", tenantId);
  const ictx = { context: { headers: tenantHeaders(slug, member.cookie) } };

  const { id } = await call(
    router.configs.create,
    { modelId: m!.id, name: "quote-proj" },
    ictx,
  );
  if (opts?.customer !== false) {
    await call(
      router.configs.update,
      { id, customer: { cardCode: "C0001", cardName: "Acme" }, entries: { coated: false } },
      ictx,
    );
  } else {
    await call(router.configs.update, { id, entries: { coated: false } }, ictx);
  }
  await call(router.configs.run, { projectId: id }, ictx);

  const [run] = await db
    .select()
    .from(configRun)
    .where(and(eq(configRun.projectId, id), eq(configRun.tenantId, tenantId)))
    .limit(1);
  const sel = [{ candidateIdx: 0, batchQty: 100 }];
  await call(router.configs.select, { runId: run!.id, selection: sel }, ictx);

  return {
    tenantId,
    slug,
    id,
    runId: run!.id,
    commandId: configDocumentCommandId({ tenantId, projectId: id, runId: run!.id, selection: sel }),
    ictx,
    sel,
  };
}


describe("configDocumentCommandId", () => {
  const base = { tenantId: "t1", projectId: "p1", runId: "r1" };
  const sel = [
    { candidateIdx: 0, batchQty: 100 },
    { candidateIdx: 2, batchQty: 50 },
  ];

  test("is stable for the same selection, and for a reorder of it", () => {
    const a = configDocumentCommandId({ ...base, selection: sel });
    expect(configDocumentCommandId({ ...base, selection: sel })).toBe(a);
    // A retry must not create a second SAP document just because the picks came back reordered.
    expect(configDocumentCommandId({ ...base, selection: [...sel].reverse() })).toBe(a);
    expect(a.length).toBe(64);
  });

  test("ignores object key order, as Postgres jsonb reorders it on the way back out", () => {
    const a = configDocumentCommandId({ ...base, selection: sel });
    const reordered = sel.map((x) => ({ batchQty: x.batchQty, candidateIdx: x.candidateIdx }));
    expect(configDocumentCommandId({ ...base, selection: reordered })).toBe(a);
    const withOverrides = [{ ...sel[0]!, overrides: { bom: [{ id: "body", unitPrice: 4 }] } }];
    expect(
      configDocumentCommandId({
        ...base,
        selection: [{ overrides: { bom: [{ unitPrice: 4, id: "body" }] }, batchQty: 100, candidateIdx: 0 }],
      }),
    ).toBe(configDocumentCommandId({ ...base, selection: withOverrides }));
  });

  test("changes when the selection changes", () => {
    const a = configDocumentCommandId({ ...base, selection: sel });
    expect(configDocumentCommandId({ ...base, selection: [sel[0]!] })).not.toBe(a);
    expect(
      configDocumentCommandId({ ...base, selection: [{ candidateIdx: 0, batchQty: 200 }, sel[1]!] }),
    ).not.toBe(a);
    expect(configDocumentCommandId({ ...base, runId: "r2", selection: sel })).not.toBe(a);
  });
});

describe("buildQuoteSeed", () => {
  test("maps customer, currency fallback, quoteItemCode, quantity, and recomputed price", async () => {
    const s = await setupCalculated({ currency: "USD" });
    const [project] = await db.select().from(configProject).where(eq(configProject.id, s.id));
    const [run] = await db.select().from(configRun).where(eq(configRun.id, s.runId));
    const seed = buildQuoteSeed(project!, run!);
    expect(seed.CardCode).toBe("C0001");
    expect(seed.CardName).toBe("Acme");
    expect(seed.DocCurrency).toBe("USD");
    const lines = seed.DocumentLines as Record<string, unknown>[];
    expect(lines).toHaveLength(1);
    expect(lines[0]!.ItemCode).toBe("CFG");
    expect(lines[0]!.Quantity).toBe(100);
    expect(typeof lines[0]!.UnitPrice).toBe("number");
    expect((lines[0]!.UnitPrice as number) > 0).toBe(true);
    // Only real B1 DocumentLines fields — an unknown property 400s on POST.
    expect(Object.keys(lines[0]!).sort()).toEqual(["ItemCode", "ItemDescription", "Quantity", "UnitPrice"]);

    // Without model currency, DocCurrency is omitted (fallback = no forced default).
    const s2 = await setupCalculated();
    const [p2] = await db.select().from(configProject).where(eq(configProject.id, s2.id));
    const [r2] = await db.select().from(configRun).where(eq(configRun.id, s2.runId));
    const seed2 = buildQuoteSeed(p2!, r2!);
    expect(seed2).not.toHaveProperty("DocCurrency");
  });
});

describe("configs.select fencing", () => {
  test("rejects unknown and duplicate candidate/batch pairs, and an unknown runId", async () => {
    const s = await setupCalculated();
    expect(
      await code(
        call(
          router.configs.select,
          {
            runId: s.runId,
            selection: [{ candidateIdx: 0, batchQty: 999 }],
          },
          s.ictx,
        ),
      ),
    ).toBe("BAD_REQUEST");

    expect(
      await code(
        call(
          router.configs.select,
          {
            runId: s.runId,
            selection: [
              { candidateIdx: 0, batchQty: 100 },
              { candidateIdx: 0, batchQty: 100 },
            ],
          },
          s.ictx,
        ),
      ),
    ).toBe("BAD_REQUEST");

    // A runId from a superseded run no longer resolves: the row is replaced on every calculate.
    expect(
      await code(
        call(
          router.configs.select,
          { runId: crypto.randomUUID(), selection: [{ candidateIdx: 0, batchQty: 500 }] },
          s.ictx,
        ),
      ),
    ).toBe("NOT_FOUND");

    const ok = await call(
      router.configs.select,
      { runId: s.runId, selection: [{ candidateIdx: 0, batchQty: 500 }] },
      s.ictx,
    );
    expect(ok.selections).toHaveLength(1);
    expect(ok.selections[0]!.batchQty).toBe(500);
  });
});

describe("quoteDraft / createQuote", () => {
  // The draft is pure: it recomputes the payload from the persisted run and never touches SAP,
  // so it works with no agent configured. Posting is what needs one.
  test("quoteDraft echoes the command id for the stored selection", async () => {
    const s = await setupCalculated();
    const draft = await call(router.configs.quoteDraft, { projectId: s.id }, s.ictx);
    expect(draft.commandId).toBe(s.commandId);
    expect(draft.runId).toBe(s.runId);
    expect((draft.data.DocumentLines as unknown[]).length).toBeGreaterThan(0);
    expect(draft.quoted).toBeNull();
  });

  test("a stale command id is a conflict, and a tenant with no agent cannot post", async () => {
    const s = await setupCalculated();
    expect(
      await code(call(
        router.configs.createQuote,
        { projectId: s.id, runId: s.runId, commandId: "0".repeat(64) },
        s.ictx,
      )),
    ).toBe("CONFLICT");
    expect(
      await code(call(
        router.configs.createQuote,
        { projectId: s.id, runId: s.runId, commandId: s.commandId },
        s.ictx,
      )),
    ).toBe("SERVICE_UNAVAILABLE");
  });
});

describe("portal.quotedResult", () => {
  test("reads the project's acknowledged run", async () => {
    const s = await setupCalculated();
    const client = await makeUser("client", s.tenantId);
    await bindClient(s.tenantId, client.userId, "C0001", "Acme");
    const cctx = { context: { headers: tenantHeaders(s.slug, client.cookie) } };

    // Portal fence requires source=portal + matching CardCode
    await db
      .update(configProject)
      .set({ source: "portal", customer: { cardCode: "C0001", cardName: "Acme" } })
      .where(eq(configProject.id, s.id));

    // Not acknowledged yet: nothing to show even once the project says quoted.
    await db.update(configProject).set({ status: "quoted" }).where(eq(configProject.id, s.id));
    expect(await code(call(router.portal.quotedResult, { projectId: s.id }, cctx))).toBe("NOT_FOUND");

    await db
      .update(configRun)
      .set({ b1DocEntry: 42, quotedAt: new Date() })
      .where(eq(configRun.id, s.runId));

    const res = await call(router.portal.quotedResult, { projectId: s.id }, cctx);
    expect(res.lines).toHaveLength(1);
    expect(Object.keys(res.lines[0]!).sort()).toEqual(["assignment", "batchQty", "total", "unitPrice"]);
    expect(res.lines[0]!.batchQty).toBe(100);
  });
});

/** A configRun row with only the fields quotedTotals reads. lookupSnapshot is empty because
 *  TEST_MODEL's price expression does not reference lookup tables. */
function makeRun(over: Partial<ConfigRunRow>): ConfigRunRow {
  return {
    id: "r1", tenantId: "t1", projectId: "p1",
    modelSnapshot: TEST_MODEL,
    lookupSnapshot: { domains: {}, tables: {} },
    entries: {},
    candidates: [{ assignment: { material: "steel", coated: false }, perBatch: [{ batchQty: 10, outputs: {} as never }] }],
    selection: [{ candidateIdx: 0, batchQty: 10 }],
    b1DocEntry: null, quotedAt: null,
    quotedValue: null, quotedCost: null,
    createdAt: new Date(),
    ...over,
  } as ConfigRunRow;
}

describe("quotedTotals", () => {
  test("sums value and cost across every selected candidate and batch", () => {
    const run = makeRun({
      candidates: [
        { assignment: { material: "steel", coated: false }, perBatch: [{ batchQty: 10, outputs: {} as never }] },
        { assignment: { material: "steel", coated: true }, perBatch: [{ batchQty: 5, outputs: {} as never }] },
      ],
      selection: [
        { candidateIdx: 0, batchQty: 10 },
        { candidateIdx: 1, batchQty: 5 },
      ],
    });
    const { value, cost } = quotedTotals(run);
    // computeOutputs is re-run per selection; totals are unitPrice*qty and unitCost*qty summed.
    expect(value).toBeGreaterThan(cost);
    expect(value).toBeCloseTo(
      computeOutputs(run.modelSnapshot, run.lookupSnapshot, { material: "steel", coated: false }, 10).unitPrice * 10 +
        computeOutputs(run.modelSnapshot, run.lookupSnapshot, { material: "steel", coated: true }, 5).unitPrice * 5,
      6,
    );
  });

  test("returns zeros when nothing is selected", () => {
    expect(quotedTotals(makeRun({ selection: [] }))).toEqual({ value: 0, cost: 0 });
    expect(quotedTotals(makeRun({ selection: null }))).toEqual({ value: 0, cost: 0 });
  });
});
