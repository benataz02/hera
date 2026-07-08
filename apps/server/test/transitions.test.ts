import { describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { db, configModel, configProject } from "@hera/db";
import { call, makeTenant, makeUser, bindClient, tenantHeaders, TEST_MODEL } from "./harness.ts";
import { router } from "../src/orpc/router.ts";

const code = (p: Promise<unknown>) => p.then(() => "OK", (e) => (e as { code?: string }).code ?? "ERR");

async function calculatedProject() {
  const { tenantId, slug } = await makeTenant();
  const [m] = await db.insert(configModel)
    .values({ tenantId, name: TEST_MODEL.name, definition: TEST_MODEL, portal: true })
    .returning({ id: configModel.id });
  const c = await makeUser("client", tenantId);
  await bindClient(tenantId, c.userId);
  const ctx = { context: { headers: tenantHeaders(slug, c.cookie) } };
  const { id } = await call(router.portal.projects.create, { modelId: m!.id, name: "req" }, ctx);
  await call(router.portal.projects.update, { id, entries: { coated: false } }, ctx);
  await call(router.portal.run, { projectId: id }, ctx);
  const internal = await makeUser("member", tenantId);
  const ictx = { context: { headers: tenantHeaders(slug, internal.cookie) } };
  return { tenantId, id, ctx, ictx };
}
const sel = [{ candidateIdx: 0, batchQty: 100 }];

describe("spec test 3 — status transitions", () => {
  test("submit → withdraw → resubmit → reject → reopen, with events", async () => {
    const { id, ctx, ictx } = await calculatedProject();

    await call(router.portal.submit, { projectId: id, selection: sel }, ctx);
    let got = await call(router.portal.projects.get, { id }, ctx);
    expect(got.project.status).toBe("requested");
    expect(await code(call(router.portal.projects.update, { id, name: "locked?" }, ctx))).toBe("BAD_REQUEST");

    await call(router.portal.withdraw, { projectId: id }, ctx);
    got = await call(router.portal.projects.get, { id }, ctx);
    expect(got.project.status).toBe("draft");

    await call(router.portal.run, { projectId: id }, ctx); // re-calculate, then resubmit
    await call(router.portal.submit, { projectId: id, selection: sel }, ctx);
    await call(router.configs.reject, { id, note: "wrong material" }, ictx);
    got = await call(router.portal.projects.get, { id }, ctx);
    expect(got.project.status).toBe("rejected");
    expect(got.project.rejectionNote).toBe("wrong material");

    await call(router.portal.reopen, { projectId: id }, ctx);
    got = await call(router.portal.projects.get, { id }, ctx);
    expect(got.project.status).toBe("draft");
    expect(got.project.events.map((e) => e.kind)).toEqual(["created", "submitted", "withdrawn", "submitted", "rejected"]);
  });

  test("guards: submit needs calculated + valid selection; withdraw/reject/reopen need their source status", async () => {
    const { id, ctx, ictx } = await calculatedProject();
    expect(await code(call(router.portal.submit, { projectId: id, selection: [{ candidateIdx: 99, batchQty: 100 }] }, ctx))).toBe("BAD_REQUEST");
    expect(await code(call(router.portal.withdraw, { projectId: id }, ctx))).toBe("BAD_REQUEST"); // not requested
    expect(await code(call(router.portal.reopen, { projectId: id }, ctx))).toBe("BAD_REQUEST");   // not rejected
    expect(await code(call(router.configs.reject, { id, note: "n" }, ictx))).toBe("BAD_REQUEST"); // not requested
  });

  test("withdraw-vs-quote race: the status guard lets exactly one win", async () => {
    const { tenantId, id, ctx } = await calculatedProject();
    await call(router.portal.submit, { projectId: id, selection: sel }, ctx);
    // simulate the future internal createQuote: guarded flip requested → quoted
    const quoted = await db.update(configProject)
      .set({ status: "quoted" })
      .where(and(eq(configProject.id, id), eq(configProject.status, "requested")))
      .returning({ id: configProject.id });
    expect(quoted.length).toBe(1);
    expect(await code(call(router.portal.withdraw, { projectId: id }, ctx))).toBe("BAD_REQUEST");
    // quotedResult now answers with the selected line, sanitized
    const res = await call(router.portal.quotedResult, { projectId: id }, ctx);
    expect(res.lines).toHaveLength(1);
    expect(Object.keys(res.lines[0]!).sort()).toEqual(["assignment", "batchQty", "total", "unitPrice"]);
  });
});
