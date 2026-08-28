import { afterEach, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { db, configModel, configProject, configRun, sapConnection } from "@hera/db";
import { call, makeTenant, makeUser, tenantHeaders, TEST_MODEL } from "./harness.ts";
import { startMockAgent, connectTenant, type MockAgent } from "./mock-agent.ts";
import { router } from "../src/orpc/router.ts";
import { DEDUP_UDF } from "../src/config-quote.ts";

// The write path end to end: oRPC handler -> RemoteTransport -> the agent's operation endpoints.
// The mock agent keeps a real (tiny) B1 behind it, so the check-then-create actually has
// something to find on the second attempt.

const code = (p: Promise<unknown>) => p.then(() => "OK", (e) => (e as { code?: string }).code ?? "ERR");

let agent: MockAgent | null = null;
afterEach(() => { agent?.stop(); agent = null; });

async function quotableProject() {
  const { tenantId, slug } = await makeTenant();
  const [m] = await db.insert(configModel)
    .values({ tenantId, name: TEST_MODEL.name, definition: TEST_MODEL })
    .returning({ id: configModel.id });
  const member = await makeUser("member", tenantId);
  const ictx = { context: { headers: tenantHeaders(slug, member.cookie) } };

  const { id } = await call(router.configs.create, { modelId: m!.id, name: "wb" }, ictx);
  await call(router.configs.update, {
    id, customer: { cardCode: "C0001", cardName: "Acme" }, entries: { coated: false },
  }, ictx);
  await call(router.configs.run, { projectId: id }, ictx);
  const [run] = await db.select().from(configRun)
    .where(and(eq(configRun.projectId, id), eq(configRun.tenantId, tenantId))).limit(1);
  await call(router.configs.select, { runId: run!.id, selection: [{ candidateIdx: 0, batchQty: 100 }] }, ictx);

  agent = startMockAgent({ Quotations: [] });
  await connectTenant(tenantId, agent);
  return { tenantId, id, runId: run!.id, ictx, agent };
}

describe.skipIf(!process.env.DATABASE_URL)("quotation write-back", () => {
  test("posts one Quotations document carrying the dedup key, and records it", async () => {
    const s = await quotableProject();
    const draft = await call(router.configs.quoteDraft, { projectId: s.id }, s.ictx);
    const res = await call(
      router.configs.createQuote,
      { projectId: s.id, runId: s.runId, commandId: draft.commandId, comments: "hi" },
      s.ictx,
    );

    const posted = s.agent.store.Quotations!;
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({ CardCode: "C0001", Comments: "hi", [DEDUP_UDF]: draft.commandId });
    expect((posted[0]!.DocumentLines as unknown[])).toHaveLength(1);
    expect(res.docEntry).toBe(Number(posted[0]!.DocEntry));
    expect(res.reused).toBe(false);

    // The project is locked and the run remembers the document.
    const [project] = await db.select().from(configProject).where(eq(configProject.id, s.id));
    expect(project!.status).toBe("quoted");
    expect(project!.events.at(-1)?.kind).toBe("quoted");
    const [run] = await db.select().from(configRun).where(eq(configRun.id, s.runId));
    expect(run!.b1DocEntry).toBe(res.docEntry);
    expect(Number(run!.quotedValue)).toBeGreaterThan(0);
  });

  test("the same commandId twice creates exactly one quotation", async () => {
    const s = await quotableProject();
    const draft = await call(router.configs.quoteDraft, { projectId: s.id }, s.ictx);
    const post = () => call(
      router.configs.createQuote,
      { projectId: s.id, runId: s.runId, commandId: draft.commandId },
      s.ictx,
    );

    const first = await post();
    const second = await post();
    expect(second.docEntry).toBe(first.docEntry);
    expect(second.reused).toBe(true);
    expect(s.agent.store.Quotations).toHaveLength(1);
  });

  // The window the database cannot cover: we POSTed, B1 created it, our response never arrived.
  // Only the dedup UDF closes that one.
  test("a lost response does not double-post: the dedup UDF finds the existing document", async () => {
    const s = await quotableProject();
    const draft = await call(router.configs.quoteDraft, { projectId: s.id }, s.ictx);
    const first = await call(
      router.configs.createQuote,
      { projectId: s.id, runId: s.runId, commandId: draft.commandId },
      s.ictx,
    );

    // Rewind HERA's side to just before the write landed, leaving B1's document in place.
    await db.update(configRun).set({ b1DocEntry: null, quotedAt: null }).where(eq(configRun.id, s.runId));
    await db.update(configProject).set({ status: "calculated" }).where(eq(configProject.id, s.id));

    const retry = await call(
      router.configs.createQuote,
      { projectId: s.id, runId: s.runId, commandId: draft.commandId },
      s.ictx,
    );
    expect(retry.reused).toBe(true);
    expect(retry.docEntry).toBe(first.docEntry);
    expect(s.agent.store.Quotations).toHaveLength(1);
  });

  test("a missing dedup UDF is a clear instruction, not a blind double-post risk", async () => {
    const s = await quotableProject();
    s.agent.missingUdf.add("Quotations");
    const draft = await call(router.configs.quoteDraft, { projectId: s.id }, s.ictx);
    const e = await call(
      router.configs.createQuote,
      { projectId: s.id, runId: s.runId, commandId: draft.commandId },
      s.ictx,
    ).catch((x: { code?: string; message?: string }) => x);

    expect((e as { code?: string }).code).toBe("BAD_REQUEST");
    expect((e as { message: string }).message).toContain(DEDUP_UDF);
    expect(s.agent.store.Quotations).toHaveLength(0); // nothing was posted
  });

  test("an unreachable agent is SERVICE_UNAVAILABLE, and nothing is recorded as quoted", async () => {
    const s = await quotableProject();
    const draft = await call(router.configs.quoteDraft, { projectId: s.id }, s.ictx);
    s.agent.stop();
    agent = null;

    expect(
      await code(call(
        router.configs.createQuote,
        { projectId: s.id, runId: s.runId, commandId: draft.commandId },
        s.ictx,
      )),
    ).toBe("SERVICE_UNAVAILABLE");
    const [run] = await db.select().from(configRun).where(eq(configRun.id, s.runId));
    expect(run!.b1DocEntry).toBeNull();
  });

  test("a wrong agent secret never reaches SAP", async () => {
    const s = await quotableProject();
    const draft = await call(router.configs.quoteDraft, { projectId: s.id }, s.ictx);
    await db.update(sapConnection)
      .set({ secret: (await import("../src/crypto.ts")).encryptSecret("wrong") })
      .where(eq(sapConnection.tenantId, s.tenantId));

    expect(
      await code(call(
        router.configs.createQuote,
        { projectId: s.id, runId: s.runId, commandId: draft.commandId },
        s.ictx,
      )),
    ).toBe("BAD_GATEWAY");
    expect(s.agent.store.Quotations).toHaveLength(0);
  });
});
