import { db, member, organization, portalClient } from "@hera/db";
import type { ModelDef } from "@hera/config-engine";
import { auth } from "../src/auth.ts";

export { call } from "@orpc/server";

const BASE = process.env.APP_BASE_DOMAIN ?? "lvh.me";
const uid = () => crypto.randomUUID().slice(0, 8);

export async function makeTenant(): Promise<{ tenantId: string; slug: string }> {
  const slug = `t${uid()}`;
  const tenantId = crypto.randomUUID();
  await db.insert(organization).values({ id: tenantId, name: slug, slug, createdAt: new Date() });
  return { tenantId, slug };
}

export async function makeUser(
  role?: "member" | "admin" | "owner" | "client",
  tenantId?: string,
): Promise<{ userId: string; email: string; cookie: string }> {
  const email = `u${uid()}@test.local`;
  const res = await auth.api.signUpEmail({
    body: { email, password: "test1234", name: email },
    returnHeaders: true,
  });
  const cookie = res.headers.get("set-cookie")!.split(";")[0]!;
  const userId = res.response.user.id;
  if (role && tenantId) {
    await db.insert(member).values({
      id: crypto.randomUUID(), organizationId: tenantId, userId, role, createdAt: new Date(),
    });
  }
  return { userId, email, cookie };
}

/** Bind a client-role user to a CardCode (skips the invite flow for tests that don't test it). */
export async function bindClient(tenantId: string, userId: string, cardCode = "C0001", cardName = "Acme Client") {
  await db.insert(portalClient).values({
    tenantId, email: `bound-${uid()}@test.local`, cardCode, cardName,
    userId, inviteTokenHash: `test-${crypto.randomUUID()}`, acceptedAt: new Date(),
  });
  return { cardCode, cardName };
}

export const tenantHeaders = (slug: string, cookie?: string): Headers =>
  new Headers({ "x-forwarded-host": `${slug}.${BASE}`, ...(cookie ? { cookie } : {}) });

// Agent-free model (no queryTables, no query domains): runs entirely from manual options.
export const TEST_MODEL: ModelDef = {
  name: "Cable (portal test)",
  parameters: [
    {
      key: "material", label: "Material", type: "string", ui: "select",
      domain: { kind: "options", ref: { source: "manual", options: [{ value: "steel" }, { value: "alu" }] } },
    },
    { key: "coated", label: "Coated", type: "boolean", ui: "checkbox", defaultExpr: "false" },
  ],
  structure: {
    sections: [{ key: "main", title: "Main", groups: [{ key: "g", title: "G", params: ["material", "coated"] }] }],
  },
  computed: [],
  constraints: [],
  bom: [{ id: "conductor", itemCode: '"COND-1"', qty: "2", price: '(material == "steel" ? 1.5 : 2.5)', scrapPct: 0 }],
  routing: [{ id: "cut", resource: "SAW", setupMin: "10", runMinPerUnit: "0.5", ratePerHour: "60" }],
  queryTables: [],
  pricing: { priceExpr: "unitCost * 1.4", quoteItemCode: "CFG" },
  batchDefaults: [100, 500],
};
