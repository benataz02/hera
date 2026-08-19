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
} from "../src/config-quote.ts";
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
  const selected = await call(
    router.configs.select,
    { runId: run!.id, selection: sel, expectedSelectionVersion: 0 },
    ictx,
  );

  return {
    tenantId,
    slug,
    id,
    runId: run!.id,
    selectionVersion: selected.selectionVersion as number,
    ictx,
    agentCtx,
    sel,
  };
}

describe("configDocumentCommandId", () => {
  test("is stable for the same selection identity", () => {
    const a = configDocumentCommandId({
      tenantId: "t1",
      projectId: "p1",
      runId: "r1",
      selectionVersion: 3,
    });
    const b = configDocumentCommandId({
      tenantId: "t1",
      projectId: "p1",
      runId: "r1",
      selectionVersion: 3,
    });
    expect(a).toBe(b);
    expect(a.length).toBeGreaterThan(8);
    expect(
      configDocumentCommandId({
        tenantId: "t1",
        projectId: "p1",
        runId: "r1",
        selectionVersion: 4,
      }),
    ).not.toBe(a);
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
  test("rejects unknown and duplicate candidate/batch pairs; requires expectedSelectionVersion", async () => {
    const s = await setupCalculated();
    expect(
      await code(
        call(
          router.configs.select,
          {
            runId: s.runId,
            selection: [{ candidateIdx: 0, batchQty: 999 }],
            expectedSelectionVersion: s.selectionVersion,
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
            expectedSelectionVersion: s.selectionVersion,
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
            selection: [{ candidateIdx: 0, batchQty: 500 }],
            expectedSelectionVersion: s.selectionVersion - 1,
          },
          s.ictx,
        ),
      ),
    ).toBe("CONFLICT");

    const ok = await call(
      router.configs.select,
      {
        runId: s.runId,
        selection: [{ candidateIdx: 0, batchQty: 500 }],
        expectedSelectionVersion: s.selectionVersion,
      },
      s.ictx,
    );
    expect(ok.selectionVersion).toBe(s.selectionVersion + 1);
  });
});

describe("createQuote status + mutation fencing", () => {
  test("draft/rejected/quoted cannot enqueue; calculated and requested can", async () => {
    const s = await setupCalculated();
    const draft = await call(router.configs.quoteDraft, { projectId: s.id }, s.ictx);
    expect(draft.runId).toBe(s.runId);
    expect(draft.selectionVersion).toBe(s.selectionVersion);
    expect(draft.schema?.name).toBe("Quotations");
    expect(draft.profile?.entity).toBe("Quotations");
    expect(draft.commandId).toBe(
      configDocumentCommandId({
        tenantId: s.tenantId,
        projectId: s.id,
        runId: s.runId,
        selectionVersion: s.selectionVersion,
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
            selectionVersion: s.selectionVersion,
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
        selectionVersion: s.selectionVersion,
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
            expectedSelectionVersion: s.selectionVersion,
          },
          s.ictx,
        ),
      ),
    ).toBe("CONFLICT");

    // Second createQuote for same project (even another run) is rejected while write pending
    const [runRow] = await db.select().from(configRun).where(eq(configRun.id, s.runId));
    const [otherRun] = await db
      .insert(configRun)
      .values({
        tenantId: s.tenantId,
        projectId: s.id,
        modelSnapshot: runRow!.modelSnapshot,
        lookupSnapshot: runRow!.lookupSnapshot,
        entries: runRow!.entries,
        candidates: runRow!.candidates,
        selection: [{ candidateIdx: 0, batchQty: 100 }],
        selectionVersion: 1,
      })
      .returning({ id: configRun.id });
    expect(
      await code(
        call(
          router.configs.createQuote,
          {
            projectId: s.id,
            runId: otherRun!.id,
            selectionVersion: 1,
            data: draft.data,
          },
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
            selectionVersion: s.selectionVersion,
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
        selectionVersion: s2.selectionVersion,
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
            selectionVersion: s3.selectionVersion,
            data: data3,
          },
          s3.ictx,
        ),
      ),
    ).toBe("BAD_REQUEST");
  });

  test("createQuote rejects stale selectionVersion under lock", async () => {
    const s = await setupCalculated();
    const draft = await call(router.configs.quoteDraft, { projectId: s.id }, s.ictx);

    expect(
      await code(
        call(
          router.configs.createQuote,
          {
            projectId: s.id,
            runId: s.runId,
            selectionVersion: s.selectionVersion - 1,
            data: draft.data,
          },
          s.ictx,
        ),
      ),
    ).toBe("CONFLICT");

    // Bump version after draft — caller's version is now stale
    await db
      .update(configRun)
      .set({ selectionVersion: s.selectionVersion + 1 })
      .where(eq(configRun.id, s.runId));
    expect(
      await code(
        call(
          router.configs.createQuote,
          {
            projectId: s.id,
            runId: s.runId,
            selectionVersion: s.selectionVersion,
            data: draft.data,
          },
          s.ictx,
        ),
      ),
    ).toBe("CONFLICT");
  });

  // Project-level single-flight: createQuote FOR UPDATEs config_project before assert/enqueue.
  // Overlapping tx on a different run blocks on that row lock, then CONFLICT once pending is visible.
  test("overlapping createQuote on another run waits on config_project lock then CONFLICT", async () => {
    const s = await setupCalculated();
    const draft = await call(router.configs.quoteDraft, { projectId: s.id }, s.ictx);
    const [runRow] = await db.select().from(configRun).where(eq(configRun.id, s.runId));
    const [otherRun] = await db
      .insert(configRun)
      .values({
        tenantId: s.tenantId,
        projectId: s.id,
        modelSnapshot: runRow!.modelSnapshot,
        lookupSnapshot: runRow!.lookupSnapshot,
        entries: runRow!.entries,
        candidates: runRow!.candidates,
        selection: [{ candidateIdx: 0, batchQty: 100 }],
        selectionVersion: 1,
      })
      .returning({ id: configRun.id });

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
          origin: {
            kind: "config-document",
            projectId: s.id,
            runId: s.runId,
            selectionVersion: s.selectionVersion,
          },
        },
      });
      projectLocked.resolve();
      await hold;
    });

    await projectLocked.promise;

    let settled = false;
    const second = call(
      router.configs.createQuote,
      {
        projectId: s.id,
        runId: otherRun!.id,
        selectionVersion: 1,
        data: draft.data,
      },
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
        selectionVersion: s.selectionVersion,
        data: draft.data,
      },
      s.ictx,
    );

    const pull = await call(router.sync.pull, { max: 1 }, s.agentCtx);
    expect(pull.items[0]!.id).toBe(requestId);
    const payload = pull.items[0]!.payload as {
      origin?: { kind: string; projectId: string; runId: string; selectionVersion: number };
      commandId: string;
    };
    expect(payload.origin).toEqual({
      kind: "config-document",
      projectId: s.id,
      runId: s.runId,
      selectionVersion: s.selectionVersion,
    });
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

  test("origin-conflict when run version no longer matches: write done, no wrong mutation", async () => {
    const s = await setupCalculated();
    const draft = await call(router.configs.quoteDraft, { projectId: s.id }, s.ictx);
    const { requestId } = await call(
      router.configs.createQuote,
      {
        projectId: s.id,
        runId: s.runId,
        selectionVersion: s.selectionVersion,
        data: draft.data,
      },
      s.ictx,
    );

    // Simulate impossible-in-normal-use mismatch: bump selectionVersion after enqueue
    await db
      .update(configRun)
      .set({ selectionVersion: s.selectionVersion + 99 })
      .where(eq(configRun.id, s.runId));
    // Clear pending fence so we can mutate for the test setup only — bump is enough for conflict
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
        origin: {
          kind: "config-document",
          projectId: s.id,
          runId: s.runId,
          selectionVersion: s.selectionVersion,
        },
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
  test("reads the specifically acknowledged run, not merely the latest with selection", async () => {
    const s = await setupCalculated();
    const client = await makeUser("client", s.tenantId);
    await bindClient(s.tenantId, client.userId, "C0001", "Acme");
    const cctx = { context: { headers: tenantHeaders(s.slug, client.cookie) } };

    // Portal fence requires source=portal + matching CardCode
    await db
      .update(configProject)
      .set({ source: "portal", customer: { cardCode: "C0001", cardName: "Acme" } })
      .where(eq(configProject.id, s.id));

    const [acknowledged] = await db.select().from(configRun).where(eq(configRun.id, s.runId));
    // Newer run with a selection that must NOT be used by quotedResult
    const [newer] = await db
      .insert(configRun)
      .values({
        tenantId: s.tenantId,
        projectId: s.id,
        modelSnapshot: acknowledged!.modelSnapshot,
        lookupSnapshot: acknowledged!.lookupSnapshot,
        entries: acknowledged!.entries,
        candidates: acknowledged!.candidates,
        selection: [{ candidateIdx: 0, batchQty: 500 }],
        selectionVersion: 1,
      })
      .returning();
    expect(newer!.id).not.toBe(s.runId);

    await db
      .update(configRun)
      .set({ b1DocEntry: 42, quotedAt: new Date() })
      .where(eq(configRun.id, acknowledged!.id));
    await db.update(configProject).set({ status: "quoted" }).where(eq(configProject.id, s.id));

    const res = await call(router.portal.quotedResult, { projectId: s.id }, cctx);
    expect(res.lines).toHaveLength(1);
    expect(Object.keys(res.lines[0]!).sort()).toEqual(["assignment", "batchQty", "total", "unitPrice"]);
    // Acknowledged run selected batch 100, newer selected 500
    expect(res.lines[0]!.batchQty).toBe(100);
  });
});
