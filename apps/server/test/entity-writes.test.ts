import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { db, agentRequest, tenantIntegration, type EnabledEntity } from "@hera/db";
import { call, makeTenant, makeUser, tenantHeaders } from "./harness.ts";
import { hashToken } from "../src/crypto.ts";
import { router } from "../src/orpc/router.ts";
import { normalizeWriteInput } from "../src/writes.ts";
import { getEntityProfile } from "../src/entity-profiles.ts";

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
    { name: "Comments", type: "Edm.String", nullable: true },
    { name: "DocTotal", type: "Edm.Double", nullable: true },
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
        { name: "Quantity", type: "Edm.Double", nullable: true },
        { name: "UnitPrice", type: "Edm.Double", nullable: true },
        { name: "LineTotal", type: "Edm.Double", nullable: true },
      ],
    },
  ],
};

async function setup(opts?: { canCreate?: boolean; editable?: boolean }) {
  const canCreate = opts?.canCreate ?? true;
  const editable = opts?.editable ?? true;
  const { tenantId, slug } = await makeTenant();
  const member = await makeUser("member", tenantId);
  const token = crypto.randomUUID();
  const now = new Date();
  await db.insert(tenantIntegration).values({
    tenantId,
    agentTokenHash: hashToken(token),
    enabledEntities: [{ ...quotationSchema, editable }],
    writeCapabilities: canCreate
      ? [{ entity: "Quotations", dedupField: "U_HERA_DedupKey" }]
      : [],
    writeCapabilitiesCheckedAt: canCreate ? now : null,
    lastSeenAt: now,
  });
  const userCtx = { context: { headers: tenantHeaders(slug, member.cookie) } };
  const agentCtx = {
    context: { headers: new Headers({ authorization: `Bearer ${token}` }) },
  };
  return { tenantId, slug, userCtx, agentCtx };
}

const errCode = (p: Promise<unknown>) =>
  p.then(
    () => "OK",
    (e) => (e as { code?: string }).code ?? "ERR",
  );

describe("normalizeWriteInput", () => {
  const profile = getEntityProfile("Quotations")!;

  test("strips UI-only keys and read-only/computed fields; injects create dedup UDF", () => {
    const payload = normalizeWriteInput({
      operation: "create",
      entity: "Quotations",
      commandId: "cmd-1",
      data: {
        CardCode: "C1",
        Comments: "hi",
        DocTotal: 99,
        priceSource: "manual",
        DocumentLines: [
          {
            ItemCode: "A1",
            Quantity: 2,
            UnitPrice: 10,
            LineTotal: 20,
            priceSource: "config",
            __draftKey: "d1",
          },
        ],
      },
      schema: quotationSchema,
      profile,
      canCreate: true,
    });
    expect(payload.operation).toBe("create");
    expect(payload.data.CardCode).toBe("C1");
    expect(payload.data.Comments).toBe("hi");
    expect(payload.data).not.toHaveProperty("DocTotal");
    expect(payload.data).not.toHaveProperty("priceSource");
    expect(payload.idempotency).toEqual({ field: "U_HERA_DedupKey", value: "cmd-1" });
    expect(payload.data.U_HERA_DedupKey).toBe("cmd-1");
    const lines = payload.data.DocumentLines as Record<string, unknown>[];
    expect(lines[0]).toEqual({ ItemCode: "A1", Quantity: 2, UnitPrice: 10 });
  });

  test("strips OData annotations that ride along on the fetched record", () => {
    const payload = normalizeWriteInput({
      operation: "update",
      entity: "Quotations",
      key: "3884",
      commandId: "cmd-etag",
      data: {
        "@odata.etag": 'W/"..."',
        "@odata.context": "https://sl/$metadata#Quotations/$entity",
        CardCode: "C1",
        "DocDate@odata.type": "#DateTimeOffset",
        DocumentLines: [{ ItemCode: "A1", Quantity: 1, "@odata.etag": 'W/"x"' }],
      },
      schema: quotationSchema,
      profile,
      canCreate: false,
    });
    expect(payload.data).not.toHaveProperty("@odata.etag");
    expect(payload.data).not.toHaveProperty("@odata.context");
    expect(payload.data).not.toHaveProperty("DocDate@odata.type");
    expect(payload.data.CardCode).toBe("C1");
    expect(payload.data.DocumentLines).toEqual([{ ItemCode: "A1", Quantity: 1 }]);
  });

  test("rejects unknown and write-protected fields", () => {
    expect(() =>
      normalizeWriteInput({
        operation: "update",
        entity: "Quotations",
        key: "1",
        commandId: "cmd-2",
        data: { CardCode: "C1", InventedField: "x" },
        schema: quotationSchema,
        profile,
        canCreate: false,
      }),
    ).toThrow(/unknown|InventedField/i);

    // Schema property that is neither profile-editable nor profile-readOnly.
    const schemaWithLocked: EnabledEntity = {
      ...quotationSchema,
      properties: [
        ...quotationSchema.properties,
        { name: "LockedNote", type: "Edm.String", nullable: true },
      ],
    };
    expect(() =>
      normalizeWriteInput({
        operation: "update",
        entity: "Quotations",
        key: "1",
        commandId: "cmd-3",
        data: { LockedNote: "nope" },
        schema: schemaWithLocked,
        profile,
        canCreate: false,
      }),
    ).toThrow(/write-protected|LockedNote/i);
  });

  test("create disabled without fresh matching capability", () => {
    expect(() =>
      normalizeWriteInput({
        operation: "create",
        entity: "Quotations",
        commandId: "cmd-4",
        data: { CardCode: "C1" },
        schema: quotationSchema,
        profile,
        canCreate: false,
      }),
    ).toThrow(/create|capability/i);
  });

  test("omits collections absent from input (does not invent them)", () => {
    const payload = normalizeWriteInput({
      operation: "update",
      entity: "Quotations",
      key: "1",
      commandId: "cmd-header",
      data: {
        Comments: "header only",
        DocumentStatus: "bost_Open",
        Cancelled: "tNO",
      },
      schema: quotationSchema,
      profile,
      canCreate: false,
    });
    expect(payload.data.Comments).toBe("header only");
    expect(payload.data).not.toHaveProperty("DocumentLines");
  });

  test("keeps DocumentLines when present in input", () => {
    const payload = normalizeWriteInput({
      operation: "update",
      entity: "Quotations",
      key: "1",
      commandId: "cmd-lines",
      data: {
        Comments: "x",
        DocumentLines: [{ LineNum: 0, ItemCode: "A1", Quantity: 2, LineTotal: 99 }],
      },
      schema: quotationSchema,
      profile,
      canCreate: false,
    });
    expect(payload.data.DocumentLines).toEqual([
      { LineNum: 0, ItemCode: "A1", Quantity: 2 },
    ]);
  });
});

describe("entities.write enqueue + dedup", () => {
  test("same tenant/entity/commandId returns the same request", async () => {
    const s = await setup();
    const body = {
      operation: "create" as const,
      entity: "Quotations",
      commandId: "same-cmd",
      data: { CardCode: "C1", Comments: "a" },
    };
    const a = await call(router.entities.write, body, s.userCtx);
    const b = await call(router.entities.write, { ...body, data: { CardCode: "C2" } }, s.userCtx);
    expect(a.requestId).toBe(b.requestId);

    const rows = await db
      .select({ id: agentRequest.id, dedupKey: agentRequest.dedupKey, kind: agentRequest.kind })
      .from(agentRequest)
      .where(eq(agentRequest.tenantId, s.tenantId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.dedupKey).toBe("write:Quotations:same-cmd");
    expect(rows[0]!.kind).toBe("write");
  });

  test("rejects unknown fields at the procedure boundary", async () => {
    const s = await setup();
    expect(
      await errCode(
        call(
          router.entities.write,
          {
            operation: "update",
            entity: "Quotations",
            key: "1",
            commandId: "bad-fields",
            data: {
              CardCode: "C1",
              DocumentStatus: "bost_Open",
              Cancelled: "tNO",
              NotARealField: true,
            },
          },
          s.userCtx,
        ),
      ),
    ).toBe("BAD_REQUEST");
  });

  test("create disabled without a fresh matching capability", async () => {
    const s = await setup({ canCreate: false });
    expect(
      await errCode(
        call(
          router.entities.write,
          {
            operation: "create",
            entity: "Quotations",
            commandId: "no-cap",
            data: { CardCode: "C1" },
          },
          s.userCtx,
        ),
      ),
    ).toMatch(/FORBIDDEN|BAD_REQUEST/);
  });

  test("update rejected when editWhen fails (closed document)", async () => {
    const s = await setup();
    expect(
      await errCode(
        call(
          router.entities.write,
          {
            operation: "update",
            entity: "Quotations",
            key: "1",
            commandId: "closed-doc",
            data: {
              Comments: "nope",
              DocumentStatus: "bost_Close",
              Cancelled: "tNO",
            },
          },
          s.userCtx,
        ),
      ),
    ).toBe("FORBIDDEN");
  });

  test("update allowed when editWhen passes (open document)", async () => {
    const s = await setup();
    const { requestId } = await call(
      router.entities.write,
      {
        operation: "update",
        entity: "Quotations",
        key: "1",
        commandId: "open-doc",
        data: {
          Comments: "ok",
          DocumentStatus: "bost_Open",
          Cancelled: "tNO",
        },
      },
      s.userCtx,
    );
    expect(requestId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });
});

describe("entities.create / entities.update sealed", () => {
  test("create and update throw FORBIDDEN pointing at entities.write", async () => {
    const s = await setup();
    expect(
      await errCode(call(router.entities.create, { entity: "Quotations", data: { CardCode: "C1" } }, s.userCtx)),
    ).toBe("FORBIDDEN");
    expect(
      await errCode(
        call(router.entities.update, { entity: "Quotations", key: "1", data: { Comments: "x" } }, s.userCtx),
      ),
    ).toBe("FORBIDDEN");
  });
});

describe("attempt-fenced ack/nack", () => {
  test("stale attempt cannot ack/nack a newer lease", async () => {
    const s = await setup();
    const { requestId } = await call(
      router.entities.write,
      {
        operation: "create",
        entity: "Quotations",
        commandId: "fence-1",
        data: { CardCode: "C1" },
      },
      s.userCtx,
    );

    const pull1 = await call(router.sync.pull, { max: 1 }, s.agentCtx);
    expect(pull1.items).toHaveLength(1);
    expect(pull1.items[0]!.id).toBe(requestId);
    expect(pull1.items[0]!.attempts).toBe(1);

    // Expire lease so a redelivery can claim attempt 2.
    await db
      .update(agentRequest)
      .set({ leaseUntil: new Date(Date.now() - 1000) })
      .where(eq(agentRequest.id, requestId));

    const pull2 = await call(router.sync.pull, { max: 1 }, s.agentCtx);
    expect(pull2.items[0]!.attempts).toBe(2);

    // Stale attempt-1 callbacks must be no-ops.
    await call(
      router.sync.ack,
      { id: requestId, attempt: 1, result: { key: "stale" }, docEntry: "stale" },
      s.agentCtx,
    );
    await call(
      router.sync.nack,
      { id: requestId, attempt: 1, kind: "permanent", error: "stale" },
      s.agentCtx,
    );

    const [mid] = await db
      .select({
        status: agentRequest.status,
        attempts: agentRequest.attempts,
        docEntry: agentRequest.docEntry,
        lastError: agentRequest.lastError,
      })
      .from(agentRequest)
      .where(eq(agentRequest.id, requestId));
    expect(mid!.status).toBe("in_flight");
    expect(mid!.attempts).toBe(2);
    expect(mid!.docEntry).toBeNull();
    expect(mid!.lastError).toBeNull();

    // Current attempt wins.
    await call(
      router.sync.ack,
      {
        id: requestId,
        attempt: 2,
        result: { key: "42", record: { DocEntry: 42 } },
        docEntry: "42",
      },
      s.agentCtx,
    );
    const [done] = await db
      .select({ status: agentRequest.status, docEntry: agentRequest.docEntry })
      .from(agentRequest)
      .where(eq(agentRequest.id, requestId));
    expect(done!.status).toBe("done");
    expect(done!.docEntry).toBe("42");
  });

  test("fulfill/fail do not complete write kinds", async () => {
    const s = await setup();
    const { requestId } = await call(
      router.entities.write,
      {
        operation: "update",
        entity: "Quotations",
        key: "9",
        commandId: "read-path-blocked",
        data: {
          Comments: "x",
          DocumentStatus: "bost_Open",
          Cancelled: "tNO",
        },
      },
      s.userCtx,
    );
    await call(router.sync.pull, { max: 1 }, s.agentCtx);
    await call(router.sync.fulfill, { id: requestId, result: { hacked: true } }, s.agentCtx);
    await call(router.sync.fail, { id: requestId, error: "nope" }, s.agentCtx);
    const [row] = await db
      .select({ status: agentRequest.status, result: agentRequest.result })
      .from(agentRequest)
      .where(eq(agentRequest.id, requestId));
    expect(row!.status).toBe("in_flight");
    expect(row!.result).toBeNull();
  });
});

describe("entities.watchWrite", () => {
  test("watcher emits current state immediately and after notification", async () => {
    const s = await setup();
    const { requestId } = await call(
      router.entities.write,
      {
        operation: "create",
        entity: "Quotations",
        commandId: "watch-1",
        data: { CardCode: "C1" },
      },
      s.userCtx,
    );

    const stream = (await call(
      router.entities.watchWrite,
      { requestId },
      s.userCtx,
    )) as AsyncIterable<{
      requestId: string;
      status: string;
      docEntry?: string | null;
    }>;

    const iter = stream[Symbol.asyncIterator]();
    const first = await iter.next();
    expect(first.done).toBe(false);
    expect(first.value!.requestId).toBe(requestId);
    expect(first.value!.status).toBe("pending");

    const pulled = await call(router.sync.pull, { max: 1 }, s.agentCtx);
    await call(
      router.sync.ack,
      {
        id: requestId,
        attempt: pulled.items[0]!.attempts,
        result: { key: "7", record: { DocEntry: 7 } },
        docEntry: "7",
      },
      s.agentCtx,
    );

    const second = await iter.next();
    expect(second.done).toBe(false);
    expect(second.value!.status).toBe("done");
    expect(second.value!.docEntry).toBe("7");

    const third = await iter.next();
    expect(third.done).toBe(true);
  }, 15_000);
});
