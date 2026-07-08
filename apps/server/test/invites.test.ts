import { describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { db, portalClient } from "@hera/db";
import { call, makeTenant, makeUser, tenantHeaders } from "./harness.ts";
import { router } from "../src/orpc/router.ts";

const code = (p: Promise<unknown>) => p.then(() => "OK", (e) => (e as { code?: string }).code ?? "ERR");

async function invite(slug: string, adminCookie: string, email: string) {
  return call(router.portalClients.invite,
    { email, cardCode: "C0001", cardName: "Acme Client" },
    { context: { headers: tenantHeaders(slug, adminCookie) } });
}

describe("spec test 4 — invites", () => {
  test("happy path: invite → accept → clientProcedure works", async () => {
    const { tenantId, slug } = await makeTenant();
    const admin = await makeUser("admin", tenantId);
    const visitor = await makeUser(); // session, no membership
    const { token } = await invite(slug, admin.cookie, "client@acme.test");

    const vctx = { context: { headers: tenantHeaders(slug, visitor.cookie) } };
    await call(router.portal.acceptInvite, { token }, vctx);
    // clientProcedure now resolves: published-models list answers (empty is fine)
    expect(await call(router.portal.models.list, undefined, vctx)).toEqual([]);
  });

  test("reused token is rejected", async () => {
    const { tenantId, slug } = await makeTenant();
    const admin = await makeUser("admin", tenantId);
    const a = await makeUser();
    const b = await makeUser();
    const { token } = await invite(slug, admin.cookie, "one@acme.test");
    await call(router.portal.acceptInvite, { token }, { context: { headers: tenantHeaders(slug, a.cookie) } });
    expect(await code(call(router.portal.acceptInvite, { token },
      { context: { headers: tenantHeaders(slug, b.cookie) } }))).toBe("BAD_REQUEST");
  });

  test("expired token is rejected", async () => {
    const { tenantId, slug } = await makeTenant();
    const admin = await makeUser("admin", tenantId);
    const v = await makeUser();
    const { token } = await invite(slug, admin.cookie, "old@acme.test");
    await db.update(portalClient)
      .set({ invitedAt: new Date(Date.now() - 8 * 24 * 3600 * 1000) })
      .where(eq(portalClient.tenantId, tenantId));
    expect(await code(call(router.portal.acceptInvite, { token },
      { context: { headers: tenantHeaders(slug, v.cookie) } }))).toBe("BAD_REQUEST");
  });

  test("wrong-tenant and unknown tokens are NOT_FOUND", async () => {
    const t1 = await makeTenant();
    const t2 = await makeTenant();
    const admin = await makeUser("admin", t1.tenantId);
    const v = await makeUser();
    const { token } = await invite(t1.slug, admin.cookie, "cross@acme.test");
    expect(await code(call(router.portal.acceptInvite, { token },
      { context: { headers: tenantHeaders(t2.slug, v.cookie) } }))).toBe("NOT_FOUND");
    expect(await code(call(router.portal.acceptInvite, { token: randomBytes(32).toString("hex") },
      { context: { headers: tenantHeaders(t1.slug, v.cookie) } }))).toBe("NOT_FOUND");
  });

  test("inviting an existing internal member's email is rejected", async () => {
    const { tenantId, slug } = await makeTenant();
    const admin = await makeUser("admin", tenantId);
    const insider = await makeUser("member", tenantId);
    expect(await code(invite(slug, admin.cookie, insider.email))).toBe("BAD_REQUEST");
  });

  test("concurrent accept of the same token: exactly one wins, the other is rejected cleanly", async () => {
    const { tenantId, slug } = await makeTenant();
    const admin = await makeUser("admin", tenantId);
    const a = await makeUser();
    const b = await makeUser();
    const { token } = await invite(slug, admin.cookie, "race@acme.test");

    const [ra, rb] = await Promise.allSettled([
      call(router.portal.acceptInvite, { token }, { context: { headers: tenantHeaders(slug, a.cookie) } }),
      call(router.portal.acceptInvite, { token }, { context: { headers: tenantHeaders(slug, b.cookie) } }),
    ]);
    const outcomes = [ra, rb].map((r) => r.status);
    expect(outcomes.filter((s) => s === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((s) => s === "rejected")).toHaveLength(1);

    // The loser must not be left as an orphaned member with no clientProcedure access.
    const loserCookie = ra.status === "rejected" ? a.cookie : b.cookie;
    expect(await code(call(router.portal.models.list, undefined,
      { context: { headers: tenantHeaders(slug, loserCookie) } }))).toBe("FORBIDDEN");
  });

  test("revoke of an active client removes portal access", async () => {
    const { tenantId, slug } = await makeTenant();
    const admin = await makeUser("admin", tenantId);
    const v = await makeUser();
    const { token } = await invite(slug, admin.cookie, "gone@acme.test");
    const vctx = { context: { headers: tenantHeaders(slug, v.cookie) } };
    await call(router.portal.acceptInvite, { token }, vctx);
    const actx = { context: { headers: tenantHeaders(slug, admin.cookie) } };
    const rows = await call(router.portalClients.list, undefined, actx);
    await call(router.portalClients.revoke, { id: rows[0]!.id }, actx);
    expect(await code(call(router.portal.models.list, undefined, vctx))).toBe("FORBIDDEN");
  });
});
