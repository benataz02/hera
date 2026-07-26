/**
 * Backfill the shared "Standard" views every list page needs, for EXISTING tenants.
 *
 *   bun run seed:standard [slug]
 *
 * New tenants get these from auth.ts's afterCreateOrganization hook — this is the one-shot
 * catch-up for orgs created before that existed. Idempotent: safe to re-run.
 *
 * Seeds, per org:
 *   - models / configs  -> Standard (+ the shared "Requested" view on configs)
 *   - every enabled B1 entity -> Standard, for entities enabled before seeding was wired up
 */
import { eq } from "drizzle-orm";
import { db, pool, organization, member, tenantIntegration } from "@hera/db";
import { ensureConfiguratorVariants, ensureStandardVariants } from "../apps/server/src/seed-variants.ts";

const slug = process.argv[2] ?? process.env.SLUG;

async function main(): Promise<void> {
  const orgs = await db
    .select({ id: organization.id, name: organization.name, slug: organization.slug })
    .from(organization);
  const targets = slug ? orgs.filter((o) => o.slug === slug) : orgs;
  if (!targets.length) throw new Error(slug ? `No organization with slug '${slug}'` : "No organizations found");

  for (const org of targets) {
    // Views need an owner (ui_variant.user_id is NOT NULL). The org's owner is the stable choice —
    // these are all `shared`, so ownership only decides who can edit them outside admin.
    const members = await db
      .select({ userId: member.userId, role: member.role })
      .from(member)
      .where(eq(member.organizationId, org.id));
    const owner = members.find((m) => m.role === "owner") ?? members[0];
    if (!owner) {
      console.warn(`- ${org.slug}: no members, skipped`);
      continue;
    }

    await ensureConfiguratorVariants(org.id, owner.userId);

    const [integration] = await db
      .select({ enabledEntities: tenantIntegration.enabledEntities })
      .from(tenantIntegration)
      .where(eq(tenantIntegration.tenantId, org.id))
      .limit(1);
    const entities = integration?.enabledEntities ?? [];
    for (const e of entities) await ensureStandardVariants(org.id, owner.userId, e.name);

    console.log(`- ${org.slug}: models, configs${entities.length ? `, ${entities.map((e) => e.name).join(", ")}` : ""}`);
  }
  console.log(`Seeded ${targets.length} organization(s).`);
}

await main();
await pool.end();
