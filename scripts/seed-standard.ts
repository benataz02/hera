/**
 * Backfill the shared "Standard" view (list + object) for every tenant's already-enabled
 * entities. Unlike seed:config (acme-only), this covers every organization — Standard is
 * preseeded per-tenant from tenant_integration.enabledEntities.
 *
 * Run (server not required, just a DB connection):  bun run seed:standard
 */
import { and, eq, inArray } from "drizzle-orm";
import { db, pool, organization, tenantIntegration, member } from "@hera/db";
import { ensureStandardVariants } from "../apps/server/src/orpc/routers/variants.ts";

async function main(): Promise<void> {
  const orgs = await db.select({ id: organization.id, name: organization.name }).from(organization);

  let pairs = 0;
  let skippedNoIntegration = 0;
  let skippedNoEntities = 0;
  let skippedNoMember = 0;

  for (const org of orgs) {
    const [ti] = await db
      .select({ enabledEntities: tenantIntegration.enabledEntities })
      .from(tenantIntegration)
      .where(eq(tenantIntegration.tenantId, org.id))
      .limit(1);
    if (!ti) {
      skippedNoIntegration++;
      console.log(`skip '${org.name}' (${org.id}): no tenant_integration row`);
      continue;
    }
    if (ti.enabledEntities.length === 0) {
      skippedNoEntities++;
      console.log(`skip '${org.name}' (${org.id}): no enabled entities`);
      continue;
    }

    const [admin] = await db
      .select({ userId: member.userId })
      .from(member)
      .where(and(eq(member.organizationId, org.id), inArray(member.role, ["owner", "admin"])))
      .limit(1);
    const [any] = admin ? [] : await db.select({ userId: member.userId }).from(member).where(eq(member.organizationId, org.id)).limit(1);
    const userId = admin?.userId ?? any?.userId;
    if (!userId) {
      skippedNoMember++;
      console.log(`skip '${org.name}' (${org.id}): no members`);
      continue;
    }

    for (const e of ti.enabledEntities) {
      await ensureStandardVariants(org.id, userId, e.name);
      pairs++;
    }
    console.log(`seeded '${org.name}' (${org.id}): ${ti.enabledEntities.length} entities`);
  }

  console.log(
    `Done: ${pairs} (org, entity) pairs seeded. Skipped ${skippedNoIntegration} (no integration), ` +
      `${skippedNoEntities} (no enabled entities), ${skippedNoMember} (no members).`,
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
