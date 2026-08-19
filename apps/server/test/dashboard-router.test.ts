import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { db, tenantIntegration } from "@hera/db";
import { call, makeTenant, makeUser, tenantHeaders } from "./harness.ts";
import { router } from "../src/orpc/router.ts";

const code = (p: Promise<unknown>) => p.then(() => "OK", (e) => (e as { code?: string }).code ?? "ERR");

async function tenantWithAgent() {
  const { tenantId, slug } = await makeTenant();
  await db.insert(tenantIntegration).values({ tenantId, agentTokenHash: `h-${tenantId}`, lastSeenAt: new Date() });
  return { tenantId, slug };
}

describe("dashboard.overview", () => {
  test("returns a zeroed overview for a tenant with no data", async () => {
    const { tenantId, slug } = await tenantWithAgent();
    const u = await makeUser("member", tenantId);
    const out = await call(router.dashboard.overview, { window: "month", scope: "tenant" },
      { context: { headers: tenantHeaders(slug, u.cookie) } });
    expect(out.orderValue.total).toBe(0);
    expect(out.funnel).toHaveLength(4);
    expect(out.computedAt).toBeNull();
  });

  test("falls back to tenant scope when the caller has no sales-employee mapping", async () => {
    const { tenantId, slug } = await tenantWithAgent();
    const u = await makeUser("member", tenantId);
    const out = await call(router.dashboard.overview, { window: "month", scope: "mine" },
      { context: { headers: tenantHeaders(slug, u.cookie) } });
    expect(out.scope).toBe("tenant");
  });

  test("honours mine scope once the user is mapped", async () => {
    const { tenantId, slug } = await tenantWithAgent();
    const u = await makeUser("member", tenantId);
    await db.update(tenantIntegration).set({ salesReps: { [u.userId]: 3 } })
      .where(eq(tenantIntegration.tenantId, tenantId));
    const out = await call(router.dashboard.overview, { window: "month", scope: "mine" },
      { context: { headers: tenantHeaders(slug, u.cookie) } });
    expect(out.scope).toBe("mine");
  });
});

describe("dashboard.salesReps", () => {
  test("a member cannot write the mapping", async () => {
    const { tenantId, slug } = await tenantWithAgent();
    const u = await makeUser("member", tenantId);
    expect(await code(call(router.dashboard.salesReps.set, { userId: u.userId, salesPersonCode: 1 },
      { context: { headers: tenantHeaders(slug, u.cookie) } }))).toBe("FORBIDDEN");
  });

  test("an admin sets and clears a mapping", async () => {
    const { tenantId, slug } = await tenantWithAgent();
    const a = await makeUser("admin", tenantId);
    const ctx = { context: { headers: tenantHeaders(slug, a.cookie) } };
    await call(router.dashboard.salesReps.set, { userId: a.userId, salesPersonCode: 7 }, ctx);
    expect((await call(router.dashboard.salesReps.get, undefined, ctx)).reps[a.userId]).toBe(7);
    await call(router.dashboard.salesReps.set, { userId: a.userId, salesPersonCode: null }, ctx);
    expect((await call(router.dashboard.salesReps.get, undefined, ctx)).reps[a.userId]).toBeUndefined();
  });
});
