/**
 * Backfill the shared "Standard" views every list page needs, for EXISTING tenants.
 *
 *   bun run seed:standard [slug]
 *   bun run seed:standard [slug] --force   # rewrite Standard object defs from current schema
 *
 * New tenants get these from auth.ts's afterCreateOrganization hook — this is the one-shot
 * catch-up for orgs created before that existed. Idempotent: safe to re-run.
 * `--force` is for after rediscovery when Standard already has General but is missing
 * DocumentLines (empty-only upgrade won't touch it).
 *
 * Seeds, per org:
 *   - models / configs  -> Standard (+ the shared "Requested" view on configs)
 *   - every enabled B1 entity -> Standard, for entities enabled before seeding was wired up
 */
import { and, eq } from "drizzle-orm";
import { db, pool, organization, member, tenantIntegration, uiVariant } from "@hera/db";
import { getEntityProfile } from "../apps/server/src/entity-profiles.ts";
import { seedObjectDef } from "../apps/server/src/objectSeed.ts";
import { ensureConfiguratorVariants, ensureStandardVariants } from "../apps/server/src/seed-variants.ts";

const args = process.argv.slice(2).filter((a) => a !== "--force");
const force = process.argv.includes("--force");
const slug = args[0] ?? process.env.SLUG;

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
    for (const e of entities) {
      // Legacy enabledEntities rows omit collections; seedObjectDef treats missing as [].
      const schema = { ...e, collections: e.collections ?? [] };
      const profile = getEntityProfile(e.name);
      if (force) {
        // Re-seed Standard object def from current schema (e.g. after rediscovery added DocumentLines).
        const [hit] = await db
          .select({ id: uiVariant.id })
          .from(uiVariant)
          .where(
            and(
              eq(uiVariant.tenantId, org.id),
              eq(uiVariant.page, "object"),
              eq(uiVariant.entity, e.name),
              eq(uiVariant.isStandard, true),
            ),
          )
          .limit(1);
        if (hit) {
          await db
            .update(uiVariant)
            .set({ definition: seedObjectDef(schema, profile), updatedAt: new Date() })
            .where(eq(uiVariant.id, hit.id));
        }
      }
      await ensureStandardVariants(org.id, owner.userId, e.name, schema, profile);
    }

    console.log(
      `- ${org.slug}: models, configs${entities.length ? `, ${entities.map((e) => e.name).join(", ")}` : ""}${force ? " (forced object reseed)" : ""}`,
    );
  }
  console.log(`Seeded ${targets.length} organization(s).`);
}

await main();
await pool.end();
