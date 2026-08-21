import { describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import {
  db,
  agentRequest,
  configModel,
  configProject,
  configRun,
  tenantIntegration,
} from "@hera/db";
import { call, makeTenant, makeUser, bindClient, tenantHeaders, TEST_MODEL } from "./harness.ts";
import { hashToken } from "../src/crypto.ts";
import { router } from "../src/orpc/router.ts";
import {
  buildQuoteSeed,
  configDocumentCommandId,
  quotedTotals,
  type ConfigRunRow,
} from "../src/config-quote.ts";
import { computeOutputs } from "@hera/config-engine";
import type { EnabledEntity } from "@hera/db";

const code = (p: Promise<unknown>) =>
  p.then(() => "OK", (e) => (e as { code?: string }).code ?? "ERR");

const quotationSchema: EnabledEntity = {
  name: "Quotations",
  typeName: "Document",
  keys: ["DocEntry"],
  editable: true,
  properties: [
    { name: "DocEntry", type: "Edm.Int32", nullable: false },
    { name: "DocNum", type: "Edm.Int32", nullable: true },
    { name: "CardCode", type: "Edm.String", nullable: true },
    { name: "CardName", type: "Edm.String", nullable: true },
    { name: "DocCurrency", type: "Edm.String", nullable: true },
    { name: "Comments", type: "Edm.String", nullable: true },
    { name: "U_HERA_DedupKey", type: "Edm.String", nullable: true },
  ],
  collections: [
    {
      name: "DocumentLines",
      typeName: "DocumentLine",
      many: true,
      properties: [
        { name: "LineNum", type: "Edm.Int32", nullable: true },
        { name: "ItemCode", type: "Edm.String", nullable: true },
        { name: "ItemDescription", type: "Edm.String", nullable: true },
        { name: "Quantity", type: "Edm.Double", nullable: true },
        { name: "UnitPrice", type: "Edm.Double", nullable: true },
      ],
    },
  ],
};

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
  const token = crypto.randomUUID();
  const now = new Date();
  await db.insert(tenantIntegration).values({
    tenantId,
    agentTokenHash: hashToken(token),
    enabledEntities: [quotationSchema],
    writeCapabilities: [{ entity: "Quotations", dedupField: "U_HERA_DedupKey" }],
    writeCapabilitiesCheckedAt: now,
    lastSeenAt: now,
  });
  const ictx = { context: { headers: tenantHeaders(slug, member.cookie) } };
  const agentCtx = {
    context: { headers: new Headers({ authorization: `Bearer ${token}` }) },
  };

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
    agentCtx,
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
    expect(lines[0]!.priceSource).toBe("config");

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

describe("createQuote status + mutation fencing", () => {
  test("draft/rejected/quoted cannot enqueue; calculated and requested can", async () => {
    const s = await setupCalculated();
    const draft = await call(router.configs.quoteDraft, { projectId: s.id }, s.ictx);
    expect(draft.runId).toBe(s.runId);
    expect(draft.schema?.name).toBe("Quotations");
    expect(draft.profile?.entity).toBe("Quotations");
    expect(draft.commandId).toBe(
      configDocumentCommandId({
        tenantId: s.tenantId,
        projectId: s.id,
        runId: s.runId,
        selection: s.sel,
      }),
    );

    // Force draft status
    await db.update(configProject).set({ status: "draft" }).where(eq(configProject.id, s.id));
    expect(
      await code(
        call(
          router.configs.createQuote,
          {
            projectId: s.id,
            runId: s.runId,
            commandId: s.commandId,
            data: draft.data,
          },
          s.ictx,
        ),
      ),
    ).toBe("BAD_REQUEST");

    await db.update(configProject).set({ status: "calculated" }).where(eq(configProject.id, s.id));
    const created = await call(
      router.configs.createQuote,
      {
        projectId: s.id,
        runId: s.runId,
        commandId: s.commandId,
        data: draft.data,
      },
      s.ictx,
    );
    expect(created.requestId).toBeTruthy();

    // Pending write blocks update/run/select (select uses tx-scoped assertConfigMutable)
    expect(
      await code(call(router.configs.update, { id: s.id, name: "blocked" }, s.ictx)),
    ).toBe("CONFLICT");
    expect(await code(call(router.configs.run, { projectId: s.id }, s.ictx))).toBe("CONFLICT");
    expect(
      await code(
        call(
          router.configs.select,
          {
            runId: s.runId,
            selection: [{ candidateIdx: 0, batchQty: 100 }],
          },
          s.ictx,
        ),
      ),
    ).toBe("CONFLICT");

    // A second createQuote for the same project is rejected while the write is pending.
    expect(
      await code(
        call(
          router.configs.createQuote,
          { projectId: s.id, runId: s.runId, commandId: s.commandId, data: draft.data },
          s.ictx,
        ),
      ),
    ).toBe("CONFLICT");

    // Complete the write so we can exercise requested path on a fresh project
    const pull = await call(router.sync.pull, { max: 1 }, s.agentCtx);
    await call(
      router.sync.ack,
      {
        id: pull.items[0]!.id,
        attempt: pull.items[0]!.attempts,
        result: { key: "10", record: { DocEntry: 10 } },
        docEntry: "10",
      },
      s.agentCtx,
    );

    const [quoted] = await db.select().from(configProject).where(eq(configProject.id, s.id));
    expect(quoted!.status).toBe("quoted");
    expect(
      await code(
        call(
          router.configs.createQuote,
          {
            projectId: s.id,
            runId: s.runId,
            commandId: s.commandId,
            data: draft.data,
          },
          s.ictx,
        ),
      ),
    ).toBe("BAD_REQUEST");
    // Quoted also blocks mutations
    expect(
      await code(call(router.configs.update, { id: s.id, name: "nope" }, s.ictx)),
    ).toBe("CONFLICT");

    // requested may enqueue
    const s2 = await setupCalculated();
    await db.update(configProject).set({ status: "requested" }).where(eq(configProject.id, s2.id));
    const draft2 = await call(router.configs.quoteDraft, { projectId: s2.id }, s2.ictx);
    const created2 = await call(
      router.configs.createQuote,
      {
        projectId: s2.id,
        runId: s2.runId,
        commandId: s2.commandId,
        data: draft2.data,
      },
      s2.ictx,
    );
    expect(created2.requestId).toBeTruthy();

    // rejected cannot enqueue
    const s3 = await setupCalculated();
    await db.update(configProject).set({ status: "rejected" }).where(eq(configProject.id, s3.id));
    const [p3] = await db.select().from(configProject).where(eq(configProject.id, s3.id));
    const [r3] = await db.select().from(configRun).where(eq(configRun.id, s3.runId));
    const data3 = buildQuoteSeed(p3!, r3!);
    expect(
      await code(
        call(
          router.configs.createQuote,
          {
            projectId: s3.id,
            runId: s3.runId,
            commandId: s3.commandId,
            data: data3,
          },
          s3.ictx,
        ),
      ),
    ).toBe("BAD_REQUEST");
  });

  test("createQuote rejects a commandId that no longer matches the stored selection", async () => {
    const s = await setupCalculated();
    const draft = await call(router.configs.quoteDraft, { projectId: s.id }, s.ictx);

    // A commandId that was never derived from this run's selection.
    expect(
      await code(
        call(
          router.configs.createQuote,
          { projectId: s.id, runId: s.runId, commandId: "0".repeat(64), data: draft.data },
          s.ictx,
        ),
      ),
    ).toBe("CONFLICT");

    // The picks change after the draft was taken — the client's id is now stale.
    await db
      .update(configRun)
      .set({ selection: [{ candidateIdx: 0, batchQty: 500 }] })
      .where(eq(configRun.id, s.runId));
    expect(
      await code(
        call(
          router.configs.createQuote,
          { projectId: s.id, runId: s.runId, commandId: s.commandId, data: draft.data },
          s.ictx,
        ),
      ),
    ).toBe("CONFLICT");
  });

  // Project-level single-flight: createQuote FOR UPDATEs config_project before assert/enqueue.
  // An overlapping tx blocks on that row lock, then CONFLICTs once pending is visible.
  test("overlapping createQuote waits on config_project lock then CONFLICT", async () => {
    const s = await setupCalculated();
    const draft = await call(router.configs.quoteDraft, { projectId: s.id }, s.ictx);

    let release!: () => void;
    const projectLocked = Promise.withResolvers<void>();
    const hold = new Promise<void>((r) => {
      release = r;
    });

    const holder = db.transaction(async (tx) => {
      await tx
        .select({ id: configProject.id })
        .from(configProject)
        .where(and(eq(configProject.id, s.id), eq(configProject.tenantId, s.tenantId)))
        .for("update");
      await tx
        .select({ id: configRun.id })
        .from(configRun)
        .where(and(eq(configRun.id, s.runId), eq(configRun.tenantId, s.tenantId)))
        .for("update");
      await tx.insert(agentRequest).values({
        tenantId: s.tenantId,
        kind: "write",
        status: "pending",
        dedupKey: `write:Quotations:hold-${s.id}`,
        payload: {
          origin: { kind: "config-document", projectId: s.id, runId: s.runId },
        },
      });
      projectLocked.resolve();
      await hold;
    });

    await projectLocked.promise;

    let settled = false;
    const second = call(
      router.configs.createQuote,
      { projectId: s.id, runId: s.runId, commandId: s.commandId, data: draft.data },
      s.ictx,
    ).finally(() => {
      settled = true;
    });

    await Bun.sleep(250);
    expect(settled).toBe(false);

    release();
    await holder;
    expect(await code(second)).toBe("CONFLICT");
    expect(settled).toBe(true);
  });
});

describe("completeWriteOrigin", () => {
  test("ack sets run b1DocEntry, project quoted, one event; repeat does not duplicate", async () => {
    const s = await setupCalculated();
    const draft = await call(router.configs.quoteDraft, { projectId: s.id }, s.ictx);
    const { requestId } = await call(
      router.configs.createQuote,
      {
        projectId: s.id,
        runId: s.runId,
        commandId: s.commandId,
        data: draft.data,
      },
      s.ictx,
    );

    const pull = await call(router.sync.pull, { max: 1 }, s.agentCtx);
    expect(pull.items[0]!.id).toBe(requestId);
    const payload = pull.items[0]!.payload as {
      origin?: { kind: string; projectId: string; runId: string };
      commandId: string;
    };
    expect(payload.origin).toEqual({ kind: "config-document", projectId: s.id, runId: s.runId });
    expect(payload.commandId).toBe(draft.commandId);

    await call(
      router.sync.ack,
      {
        id: requestId,
        attempt: pull.items[0]!.attempts,
        result: { key: "55", record: { DocEntry: 55 } },
        docEntry: "55",
      },
      s.agentCtx,
    );

    const [run] = await db.select().from(configRun).where(eq(configRun.id, s.runId));
    expect(run!.b1DocEntry).toBe(55);
    expect(run!.quotedAt).toBeTruthy();

    const [project] = await db.select().from(configProject).where(eq(configProject.id, s.id));
    expect(project!.status).toBe("quoted");
    expect(project!.events.filter((e) => e.kind === "quoted")).toHaveLength(1);

    // Stale/repeat ack is a no-op (attempt fence) — no second event
    await call(
      router.sync.ack,
      {
        id: requestId,
        attempt: pull.items[0]!.attempts,
        result: { key: "55", record: { DocEntry: 55 } },
        docEntry: "55",
      },
      s.agentCtx,
    );
    const [again] = await db.select().from(configProject).where(eq(configProject.id, s.id));
    expect(again!.events.filter((e) => e.kind === "quoted")).toHaveLength(1);
  });

  test("origin-conflict when the origin run is gone: write done, no wrong mutation", async () => {
    const s = await setupCalculated();
    const draft = await call(router.configs.quoteDraft, { projectId: s.id }, s.ictx);
    const { requestId } = await call(
      router.configs.createQuote,
      {
        projectId: s.id,
        runId: s.runId,
        commandId: s.commandId,
        data: draft.data,
      },
      s.ictx,
    );

    // Simulate impossible-in-normal-use mismatch: the origin points at a run that no longer
    // exists (a recalculate replaces the project's run row).
    const goneRunId = crypto.randomUUID();
    // Clear pending fence so we can re-insert the request for the test setup only.
    await db.delete(agentRequest).where(
      and(eq(agentRequest.tenantId, s.tenantId), eq(agentRequest.id, requestId)),
    );
    // Re-insert as in_flight with the original origin payload so ack can complete
    const cmd = draft.commandId as string;
    await db.insert(agentRequest).values({
      id: requestId,
      tenantId: s.tenantId,
      kind: "write",
      status: "in_flight",
      attempts: 1,
      leaseUntil: new Date(Date.now() + 60_000),
      dedupKey: `write:Quotations:${cmd}`,
      payload: {
        operation: "create",
        entity: "Quotations",
        commandId: cmd,
        data: { CardCode: "C0001" },
        origin: { kind: "config-document", projectId: s.id, runId: goneRunId },
      },
    });

    await call(
      router.sync.ack,
      {
        id: requestId,
        attempt: 1,
        result: { key: "77", record: { DocEntry: 77 } },
        docEntry: "77",
      },
      s.agentCtx,
    );

    const [req] = await db.select().from(agentRequest).where(eq(agentRequest.id, requestId));
    expect(req!.status).toBe("done");
    expect(req!.lastError).toMatch(/origin-conflict/i);

    const [run] = await db.select().from(configRun).where(eq(configRun.id, s.runId));
    expect(run!.b1DocEntry).toBeNull();
    const [project] = await db.select().from(configProject).where(eq(configProject.id, s.id));
    expect(project!.status).toBe("calculated");
    expect(project!.events.filter((e) => e.kind === "quoted")).toHaveLength(0);
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
