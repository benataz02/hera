import { afterEach, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { db, portalClient } from "@hera/db";
import { call, makeTenant, makeUser, tenantHeaders } from "./harness.ts";
import { startMockAgent, connectTenant, type MockAgent } from "./mock-agent.ts";
import { router } from "../src/orpc/router.ts";

const code = (p: Promise<unknown>) => p.then(() => "OK", (e) => (e as { code?: string }).code ?? "ERR");

// Inviting a portal client now binds it to a real SAP business partner, so every test that
// invites needs an agent to validate against.
let agent: MockAgent | null = null;
afterEach(() => { agent?.stop(); agent = null; });

async function connect(tenantId: string) {
  agent = startMockAgent({
    BusinessPartners: [
      { CardCode: "C0001", CardName: "Acme Client SL", CardType: "cCustomer" },
      { CardCode: "V0001", CardName: "Acme Supplier SL", CardType: "cSupplier" },
    ],
  });
  await connectTenant(tenantId, agent);
  return agent;
}

async function invite(slug: string, adminCookie: string, email: string, cardCode = "C0001") {
  return call(router.portalClients.invite,
    { email, cardCode },
    { context: { headers: tenantHeaders(slug, adminCookie) } });
}

describe("spec test 4 — invites", () => {
  test("happy path: invite → accept → clientProcedure works", async () => {
    const { tenantId, slug } = await makeTenant();
    await connect(tenantId);
    const admin = await makeUser("admin", tenantId);
    const visitor = await makeUser(); // session, no membership
    const { token } = await invite(slug, admin.cookie, visitor.email);

    const vctx = { context: { headers: tenantHeaders(slug, visitor.cookie) } };
    await call(router.portal.acceptInvite, { token }, vctx);
    // clientProcedure now resolves: published-models list answers (empty is fine)
    expect(await call(router.portal.models.list, undefined, vctx)).toEqual([]);
  });

  test("reused token is rejected", async () => {
    const { tenantId, slug } = await makeTenant();
    await connect(tenantId);
    const admin = await makeUser("admin", tenantId);
    const a = await makeUser();
    const b = await makeUser();
    const { token } = await invite(slug, admin.cookie, a.email);
    await call(router.portal.acceptInvite, { token }, { context: { headers: tenantHeaders(slug, a.cookie) } });
    expect(await code(call(router.portal.acceptInvite, { token },
      { context: { headers: tenantHeaders(slug, b.cookie) } }))).toBe("BAD_REQUEST");
  });

  test("expired token is rejected", async () => {
    const { tenantId, slug } = await makeTenant();
    await connect(tenantId);
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
    await connect(t1.tenantId);
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
    await connect(tenantId);
    const admin = await makeUser("admin", tenantId);
    const insider = await makeUser("member", tenantId);
    expect(await code(invite(slug, admin.cookie, insider.email))).toBe("BAD_REQUEST");
  });

  test("concurrent accept of the same token: exactly one wins, the other is rejected cleanly", async () => {
    const { tenantId, slug } = await makeTenant();
    await connect(tenantId);
    const admin = await makeUser("admin", tenantId);
    const a = await makeUser();
    const { token } = await invite(slug, admin.cookie, a.email);
    const ctx = { context: { headers: tenantHeaders(slug, a.cookie) } };

    const [ra, rb] = await Promise.allSettled([
      call(router.portal.acceptInvite, { token }, ctx),
      call(router.portal.acceptInvite, { token }, ctx),
    ]);
    const outcomes = [ra, rb].map((r) => r.status);
    expect(outcomes.filter((s) => s === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((s) => s === "rejected")).toHaveLength(1);
  });

  test("revoke of an active client removes portal access", async () => {
    const { tenantId, slug } = await makeTenant();
    await connect(tenantId);
    const admin = await makeUser("admin", tenantId);
    const v = await makeUser();
    const { token } = await invite(slug, admin.cookie, v.email);
    const vctx = { context: { headers: tenantHeaders(slug, v.cookie) } };
    await call(router.portal.acceptInvite, { token }, vctx);
    const actx = { context: { headers: tenantHeaders(slug, admin.cookie) } };
    const rows = await call(router.portalClients.list, undefined, actx);
    await call(router.portalClients.revoke, { id: rows[0]!.id }, actx);
    expect(await code(call(router.portal.models.list, undefined, vctx))).toBe("FORBIDDEN");
  });

  test("an unknown CardCode is rejected, and nothing is written", async () => {
    const { tenantId, slug } = await makeTenant();
    await connect(tenantId);
    const admin = await makeUser("admin", tenantId);
    expect(await code(invite(slug, admin.cookie, "nobody@acme.test", "ZZZZ"))).toBe("BAD_REQUEST");
    expect(await db.select().from(portalClient).where(eq(portalClient.tenantId, tenantId))).toHaveLength(0);
  });

  test("a supplier is refused, and the stored cardName is B1's, not the browser's", async () => {
    const { tenantId, slug } = await makeTenant();
    await connect(tenantId);
    const admin = await makeUser("admin", tenantId);
    expect(await code(invite(slug, admin.cookie, "vendor@acme.test", "V0001"))).toBe("BAD_REQUEST");

    await invite(slug, admin.cookie, "real@acme.test");
    const [row] = await db.select().from(portalClient).where(eq(portalClient.email, "real@acme.test"));
    expect(row!.cardName).toBe("Acme Client SL");
  });

  test("peekInvite reports the invite email, not the caller's session email", async () => {
    const { tenantId, slug } = await makeTenant();
    await connect(tenantId);
    const admin = await makeUser("admin", tenantId);
    const { token } = await invite(slug, admin.cookie, "client@acme.test");

    // Cookie is the admin who minted the link — the invitee has no session yet.
    const peek = await call(router.portal.peekInvite, { token }, {
      context: { headers: tenantHeaders(slug, admin.cookie) },
    });
    expect(peek).toEqual({ email: "client@acme.test", userExists: false });
  });

  test("peekInvite.userExists is keyed on the invite email, not the session user", async () => {
    const { tenantId, slug } = await makeTenant();
    await connect(tenantId);
    const admin = await makeUser("admin", tenantId);
    const invitee = await makeUser();
    const { token } = await invite(slug, admin.cookie, invitee.email);

    const peek = await call(router.portal.peekInvite, { token }, {
      context: { headers: tenantHeaders(slug, admin.cookie) },
    });
    expect(peek).toEqual({ email: invitee.email, userExists: true });
  });

  test("acceptInvite refuses a session whose email is not the invite's", async () => {
    const { tenantId, slug } = await makeTenant();
    await connect(tenantId);
    const admin = await makeUser("admin", tenantId);
    const stranger = await makeUser();
    const { token } = await invite(slug, admin.cookie, "client@acme.test");
    expect(await code(call(router.portal.acceptInvite, { token },
      { context: { headers: tenantHeaders(slug, stranger.cookie) } }))).toBe("BAD_REQUEST");
    expect(await code(call(router.portal.acceptInvite, { token },
      { context: { headers: tenantHeaders(slug, admin.cookie) } }))).toBe("BAD_REQUEST");
  });
});
