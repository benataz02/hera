/**
 * Mint a portal-client invite for an EXISTING tenant (organization slug), same as
 * Settings > Portal clients > Invite client. Also ensures the tenant has at least one
 * published (portal:true) model to configure, so the invite is testable end-to-end.
 * No server needed — writes straight to the dev DB.
 *
 *   bun run seed:portal-client <slug> [email] [cardCode] [cardName]
 *
 * Then open the printed URL in a browser: sign up (or sign in) and it lands in /portal.
 */
import { randomBytes } from "node:crypto";
import { eq, and } from "drizzle-orm";
import { db, organization, configModel, portalClient, pool } from "@hera/db";
import type { ModelDef } from "@hera/config-engine";
import { hashToken } from "../apps/server/src/crypto.ts";

const slug = process.argv[2] ?? process.env.SLUG;
const email = (process.argv[3] ?? `client-${Date.now()}@test.local`).toLowerCase();
const cardCode = process.argv[4] ?? "C0001";
const cardName = process.argv[5] ?? "Test Client Co";
const baseDomain = process.env.APP_BASE_DOMAIN ?? "lvh.me";
if (!slug) throw new Error("usage: bun run seed:portal-client <slug> [email] [cardCode] [cardName]");

// Agent-free demo model (no queryTables) — runs and prices without the on-prem agent.
const DEMO_MODEL: ModelDef = {
  name: "Cable assembly (seed)",
  parameters: [
    {
      key: "material", label: "Material", type: "string", ui: "select",
      domain: { kind: "options", ref: { source: "manual", options: [{ value: "steel" }, { value: "alu" }] } },
    },
    { key: "coated", label: "Coated", type: "boolean", ui: "checkbox", defaultExpr: "false" },
  ],
  structure: {
    sections: [{ key: "main", title: "Main", groups: [{ key: "g", title: "Config", params: ["material", "coated"] }] }],
  },
  computed: [],
  constraints: [],
  bom: [{ id: "conductor", itemCode: '"COND-1"', qty: "2", price: '(material == "steel" ? 1.5 : 2.5)', scrapPct: 0 }],
  routing: [{ id: "cut", resource: "SAW", setupMin: "10", runMinPerUnit: "0.5", ratePerHour: "60" }],
  queryTables: [],
  pricing: { priceExpr: "unitCost * 1.4", quoteItemCode: "CFG" },
  batchDefaults: [100, 500],
};

async function main(): Promise<void> {
  const [org] = await db
    .select({ id: organization.id })
    .from(organization)
    .where(eq(organization.slug, slug!))
    .limit(1);
  if (!org) throw new Error(`No organization with slug '${slug}'. Onboard it first.`);

  const [published] = await db
    .select({ id: configModel.id })
    .from(configModel)
    .where(and(eq(configModel.tenantId, org.id), eq(configModel.portal, true)))
    .limit(1);
  if (!published) {
    const [existing] = await db
      .select({ id: configModel.id })
      .from(configModel)
      .where(eq(configModel.tenantId, org.id))
      .limit(1);
    if (existing) {
      await db.update(configModel).set({ portal: true }).where(eq(configModel.id, existing.id));
      console.log(`Published existing model ${existing.id} to the portal catalog.`);
    } else {
      const [created] = await db
        .insert(configModel)
        .values({
          tenantId: org.id, name: DEMO_MODEL.name, definition: DEMO_MODEL,
          portal: true, portalDescription: "Seeded demo model for portal testing",
        })
        .returning({ id: configModel.id });
      console.log(`Created + published demo model ${created!.id}.`);
    }
  } else {
    console.log(`Tenant already has a published model (${published.id}).`);
  }

  const token = randomBytes(32).toString("hex");
  await db.insert(portalClient).values({
    tenantId: org.id, email, cardCode, cardName, inviteTokenHash: hashToken(token),
  });

  console.log(`\nInvite created for ${email} (${cardName} / ${cardCode}).`);
  console.log(`Open this URL, sign up (or sign in) with any account, and it lands in /portal:\n`);
  console.log(`  http://${slug}.${baseDomain}:5173/accept?token=${token}\n`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
