import { describe, expect, test } from "bun:test";
import { db, configModel } from "@hera/db";
import { call, makeTenant, makeUser, bindClient, tenantHeaders, TEST_MODEL } from "./harness.ts";
import { router } from "../src/orpc/router.ts";

const code = (p: Promise<unknown>) => p.then(() => "OK", (e) => (e as { code?: string }).code ?? "ERR");

async function setup() {
  const { tenantId, slug } = await makeTenant();
  const admin = await makeUser("admin", tenantId);
  const [m] = await db.insert(configModel)
    .values({ tenantId, name: TEST_MODEL.name, definition: TEST_MODEL, portal: true })
    .returning({ id: configModel.id });
  const a = await makeUser("client", tenantId);
  await bindClient(tenantId, a.userId, "CARD-A", "Client A");
  const b = await makeUser("client", tenantId);
  await bindClient(tenantId, b.userId, "CARD-B", "Client B");
  const ctxA = { context: { headers: tenantHeaders(slug, a.cookie) } };
  const ctxB = { context: { headers: tenantHeaders(slug, b.cookie) } };
  return { tenantId, slug, admin, modelId: m!.id, ctxA, ctxB };
}

describe("spec test 5 — CardCode scoping", () => {
  test("create forces the binding's customer; other CardCode can't see/update/remove it", async () => {
    const s = await setup();
    const { id } = await call(router.portal.projects.create, { modelId: s.modelId, name: "A's bracket" }, s.ctxA);

    expect(await code(call(router.portal.projects.update, { id, name: "stolen" }, s.ctxB))).toBe("NOT_FOUND");
    expect(await code(call(router.portal.projects.remove, { id }, s.ctxB))).toBe("NOT_FOUND");
    const listB = await call(router.portal.projects.list, undefined, s.ctxB);
    expect(listB.find((p) => p.id === id)).toBeUndefined();
    const listA = await call(router.portal.projects.list, undefined, s.ctxA);
    expect(listA.find((p) => p.id === id)?.name).toBe("A's bracket");
  });

  test("portal list never returns internal projects", async () => {
    const s = await setup();
    const internal = await makeUser("member", s.tenantId);
    const ictx = { context: { headers: tenantHeaders(s.slug, internal.cookie) } };
    await call(router.configs.create, { modelId: s.modelId, name: "internal-only" }, ictx);
    const listA = await call(router.portal.projects.list, undefined, s.ctxA);
    expect(listA.find((p) => p.name === "internal-only")).toBeUndefined();
  });

  test("create rejects an unpublished model", async () => {
    const s = await setup();
    await db.insert(configModel).values({ tenantId: s.tenantId, name: "hidden", definition: TEST_MODEL, portal: false });
    const rows = await db.select({ id: configModel.id }).from(configModel);
    const hidden = rows[rows.length - 1]!.id;
    expect(await code(call(router.portal.projects.create, { modelId: hidden, name: "x" }, s.ctxA))).toBe("NOT_FOUND");
  });
});
