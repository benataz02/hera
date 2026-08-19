import { expect, test } from "bun:test";
import { SlError } from "../src/service-layer-client.ts";
import {
  processWrite,
  type WriteCloudPort,
  type WriteServiceLayerPort,
} from "../src/write-sync.ts";

type Call = { op: string; args: unknown[] };

function createPayload(overrides: Record<string, unknown> = {}) {
  return {
    operation: "create" as const,
    entity: "Quotations",
    data: {
      CardCode: "C0001",
      U_HERA_DedupKey: "cmd-1",
      ...(overrides.data as Record<string, unknown> | undefined),
    },
    commandId: "cmd-1",
    idempotency: { field: "U_HERA_DedupKey", value: "cmd-1" },
    ...overrides,
  };
}

function updatePayload(overrides: Record<string, unknown> = {}) {
  return {
    operation: "update" as const,
    entity: "Quotations",
    key: "42",
    data: { Comments: "hello", ...(overrides.data as Record<string, unknown> | undefined) },
    commandId: "cmd-u1",
    ...overrides,
  };
}

function fakes(slImpl: Partial<WriteServiceLayerPort> = {}) {
  const calls: Call[] = [];
  const acked: unknown[] = [];
  const nacked: unknown[] = [];

  const sl: WriteServiceLayerPort = {
    createEntity: async (...args) => {
      calls.push({ op: "createEntity", args });
      return slImpl.createEntity ? slImpl.createEntity(...args) : { DocEntry: 42 };
    },
    updateEntity: async (...args) => {
      calls.push({ op: "updateEntity", args });
      return slImpl.updateEntity ? slImpl.updateEntity(...args) : { ok: true };
    },
    getEntity: async (...args) => {
      calls.push({ op: "getEntity", args });
      return slImpl.getEntity ? slImpl.getEntity(...args) : { DocEntry: 42, CardCode: "C0001" };
    },
    findByDedup: async (...args) => {
      calls.push({ op: "findByDedup", args });
      return slImpl.findByDedup
        ? slImpl.findByDedup(...args)
        : { status: "absent" as const };
    },
  };

  const cloud: WriteCloudPort = {
    ack: async (i) => void acked.push(i),
    nack: async (i) => void nacked.push(i),
  };

  return { sl, cloud, calls, acked, nacked };
}

function writeReq(
  payload: Record<string, unknown>,
  attempts: number,
  id = "w1",
) {
  return {
    id,
    kind: "write",
    payload,
    attempts,
    dedupKey: `write:Quotations:${String(payload.commandId ?? "x")}`,
  };
}

test("1. first create: POST, confirm GET, ack", async () => {
  const f = fakes({
    createEntity: async () => ({ DocEntry: 42, CardCode: "C0001" }),
    getEntity: async () => ({ DocEntry: 42, CardCode: "C0001" }),
  });

  await processWrite(writeReq(createPayload(), 1), f.sl, f.cloud);

  expect(f.calls.map((c) => c.op)).toEqual(["createEntity", "getEntity"]);
  expect(f.calls[0]!.args[0]).toBe("Quotations");
  expect(f.calls[1]!.args).toEqual(["Quotations", "42", false]);
  expect(f.nacked).toEqual([]);
  expect(f.acked).toEqual([
    {
      id: "w1",
      attempt: 1,
      result: { key: "42", record: { DocEntry: 42, CardCode: "C0001" } },
      docEntry: "42",
    },
  ]);
});

test("2. retry found: GET, no POST, ack", async () => {
  const f = fakes({
    findByDedup: async () => ({ status: "found", record: { DocEntry: 99 } }),
  });

  await processWrite(writeReq(createPayload(), 2), f.sl, f.cloud);

  expect(f.calls.map((c) => c.op)).toEqual(["findByDedup"]);
  expect(f.calls[0]!.args).toEqual([
    "Quotations",
    "U_HERA_DedupKey",
    "cmd-1",
    "DocEntry",
  ]);
  expect(f.nacked).toEqual([]);
  expect(f.acked).toEqual([
    {
      id: "w1",
      attempt: 2,
      result: { key: "99", record: { DocEntry: 99 } },
      docEntry: "99",
    },
  ]);
});

test("3. retry absent: GET, one POST, confirm, ack", async () => {
  const f = fakes({
    findByDedup: async () => ({ status: "absent" }),
    createEntity: async () => ({ DocEntry: 7 }),
    getEntity: async () => ({ DocEntry: 7, CardCode: "C0001" }),
  });

  await processWrite(writeReq(createPayload(), 3), f.sl, f.cloud);

  expect(f.calls.map((c) => c.op)).toEqual(["findByDedup", "createEntity", "getEntity"]);
  expect(f.acked).toHaveLength(1);
  expect(f.acked[0]).toMatchObject({ attempt: 3, docEntry: "7" });
  expect(f.nacked).toEqual([]);
});

test("4. unique conflict: GET exactly one, ack", async () => {
  const f = fakes({
    createEntity: async () => {
      throw new SlError(409, "UNIQUE", "duplicate key");
    },
    findByDedup: async () => ({ status: "found", record: { DocEntry: 55 } }),
  });

  await processWrite(writeReq(createPayload(), 1), f.sl, f.cloud);

  expect(f.calls.map((c) => c.op)).toEqual(["createEntity", "findByDedup"]);
  expect(f.acked).toEqual([
    {
      id: "w1",
      attempt: 1,
      result: { key: "55", record: { DocEntry: 55 } },
      docEntry: "55",
    },
  ]);
  expect(f.nacked).toEqual([]);
});

test("5. unique conflict with zero/multiple matches: permanent nack", async () => {
  const zero = fakes({
    createEntity: async () => {
      throw new SlError(409, "UNIQUE", "duplicate key");
    },
    findByDedup: async () => ({ status: "absent" }),
  });
  await processWrite(writeReq(createPayload(), 1, "z"), zero.sl, zero.cloud);
  expect(zero.acked).toEqual([]);
  expect(zero.nacked).toEqual([
    expect.objectContaining({ id: "z", attempt: 1, kind: "permanent" }),
  ]);

  const multi = fakes({
    createEntity: async () => {
      throw new SlError(409, "UNIQUE", "duplicate key");
    },
    findByDedup: async () => {
      throw new SlError(500, "DEDUP_AMBIGUOUS", "multiple matches");
    },
  });
  await processWrite(writeReq(createPayload(), 1, "m"), multi.sl, multi.cloud);
  expect(multi.acked).toEqual([]);
  expect(multi.nacked).toEqual([
    expect.objectContaining({ id: "m", attempt: 1, kind: "permanent" }),
  ]);
});

test("6. update without collection changes: PATCH, GET, ack", async () => {
  const f = fakes({
    getEntity: async () => ({ DocEntry: 42, Comments: "hello" }),
  });

  await processWrite(writeReq(updatePayload(), 1), f.sl, f.cloud);

  expect(f.calls.map((c) => c.op)).toEqual(["updateEntity", "getEntity"]);
  expect(f.calls[0]!.args).toEqual([
    "Quotations",
    "42",
    false,
    { Comments: "hello" },
    { replaceCollections: false },
  ]);
  expect(f.acked).toEqual([
    {
      id: "w1",
      attempt: 1,
      result: { key: "42", record: { DocEntry: 42, Comments: "hello" } },
      docEntry: "42",
    },
  ]);
  expect(f.nacked).toEqual([]);
});

test("7. update with collection changes: PATCH with ReplaceCollections header, GET, ack", async () => {
  const data = {
    Comments: "x",
    DocumentLines: [{ ItemCode: "A1", Quantity: 1 }],
  };
  const f = fakes({
    getEntity: async () => ({ DocEntry: 42, ...data }),
  });

  await processWrite(writeReq(updatePayload({ data }), 1), f.sl, f.cloud);

  expect(f.calls[0]!.op).toBe("updateEntity");
  expect(f.calls[0]!.args[4]).toEqual({ replaceCollections: true });
  expect(f.calls.map((c) => c.op)).toEqual(["updateEntity", "getEntity"]);
  expect(f.acked).toHaveLength(1);
  expect(f.nacked).toEqual([]);
});

test("8. ambiguous timeout/5xx: transient nack", async () => {
  const timeout = fakes({
    createEntity: async () => {
      throw new Error("TimeoutError: The operation was aborted due to timeout");
    },
  });
  await processWrite(writeReq(createPayload(), 1, "t"), timeout.sl, timeout.cloud);
  expect(timeout.acked).toEqual([]);
  expect(timeout.nacked).toEqual([
    expect.objectContaining({ id: "t", attempt: 1, kind: "transient" }),
  ]);

  const five = fakes({
    createEntity: async () => {
      throw new SlError(503, "BUSY", "Service unavailable");
    },
  });
  await processWrite(writeReq(createPayload(), 1, "5"), five.sl, five.cloud);
  expect(five.acked).toEqual([]);
  expect(five.nacked).toEqual([
    expect.objectContaining({ id: "5", attempt: 1, kind: "transient" }),
  ]);
});

test("9. confirmed validation 4xx: permanent nack", async () => {
  const f = fakes({
    createEntity: async () => {
      throw new SlError(400, "-5002", "Invalid field: Foo");
    },
  });

  await processWrite(writeReq(createPayload(), 1), f.sl, f.cloud);

  expect(f.acked).toEqual([]);
  expect(f.nacked).toEqual([
    expect.objectContaining({
      id: "w1",
      attempt: 1,
      kind: "permanent",
      error: expect.stringContaining("Invalid field"),
    }),
  ]);
});

test("10. confirm GET failure: no ack", async () => {
  const f = fakes({
    createEntity: async () => ({ DocEntry: 42 }),
    getEntity: async () => {
      throw new SlError(500, "DOWN", "confirm failed");
    },
  });

  await processWrite(writeReq(createPayload(), 1), f.sl, f.cloud);

  expect(f.calls.map((c) => c.op)).toEqual(["createEntity", "getEntity"]);
  expect(f.acked).toEqual([]);
  expect(f.nacked).toEqual([
    expect.objectContaining({ id: "w1", attempt: 1, kind: "transient" }),
  ]);
});
