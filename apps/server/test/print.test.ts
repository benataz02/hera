import { afterEach, describe, expect, test } from "bun:test";
import { call, makeTenant, makeUser, tenantHeaders } from "./harness.ts";
import { startMockAgent, connectTenant, type MockAgent } from "./mock-agent.ts";
import { router } from "../src/orpc/router.ts";

// Printing rides the same cloud -> agent hop as every B1 read, but on a route with no
// B1Transport behind it. What matters here is that the curated PRINTABLE list — not a button —
// decides what can be printed, and that the agent's reply reaches the caller intact.

const code = (p: Promise<unknown>) => p.then(() => "OK", (e) => (e as { code?: string }).code ?? "ERR");

let agent: MockAgent | null = null;
afterEach(() => { agent?.stop(); agent = null; });

async function setup() {
  const { tenantId, slug } = await makeTenant();
  const admin = await makeUser("admin", tenantId);
  agent = startMockAgent({});
  await connectTenant(tenantId, agent);
  return { tenantId, slug, ictx: { context: { headers: tenantHeaders(slug, admin.cookie) } }, agent };
}

describe.skipIf(!process.env.DATABASE_URL)("entities.print", () => {
  test("returns the agent's base64 PDF and file name", async () => {
    const s = await setup();
    const out = await call(router.entities.print, { entity: "Quotations", docEntry: 12045 }, s.ictx);
    expect(out.fileName).toBe("Quotations-12045.pdf");
    expect(Buffer.from(out.pdf, "base64").toString()).toBe("%PDF-1.4\nQuotations:12045");
    expect(s.agent.calls.at(-1)).toMatchObject({ route: "/print", body: { entity: "Quotations", docEntry: 12045 } });
  });

  test("an entity outside PRINTABLE never reaches the agent", async () => {
    const s = await setup();
    expect(await code(call(router.entities.print, { entity: "BusinessPartners", docEntry: 1 }, s.ictx))).toBe("FORBIDDEN");
    expect(s.agent.calls.some((c) => c.route === "/print")).toBe(false);
  });

  test("a member (non-admin) cannot print", async () => {
    const s = await setup();
    const plain = await makeUser("member", s.tenantId);
    const ctx = { context: { headers: tenantHeaders(s.slug, plain.cookie) } };
    expect(await code(call(router.entities.print, { entity: "Quotations", docEntry: 1 }, ctx))).toBe("FORBIDDEN");
  });
});
