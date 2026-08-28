/**
 * Backfill the shared "Standard" views every list/object page needs, for EXISTING tenants.
 *
 *   bun run seed:standard [slug] [--force]
 *
 * New tenants get these from auth.ts's afterCreateOrganization hook — this is the one-shot
 * catch-up for orgs created before that existed. Idempotent: safe to re-run.
 *
 * Seeds, per org: models / configs Standard (+ the shared "Requested" view on configs), and the
 * Standard list + object views for the curated SAP B1 entities. A Standard view an admin has
 * already shaped is left alone unless --force.
 */
import { eq } from "drizzle-orm";
import { db, pool, organization, member } from "@hera/db";
import { ensureConfiguratorVariants, ensureEntityVariants } from "../apps/server/src/seed-variants.ts";

const args = process.argv.slice(2);
const force = args.includes("--force");
const slug = args.find((a) => !a.startsWith("--")) ?? process.env.SLUG;

async function main(): Promise<void> {
  const orgs = await db
    .select({ id: organization.id, name: organization.name, slug: organization.slug })
    .from(organization);
  const targets = slug ? orgs.filter((o) => o.slug === slug) : orgs;
  if (!targets.length) throw new Error(slug ? `No organization with slug '${slug}'` : "No organizations found");

  for (const org of targets) {
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
    await ensureEntityVariants(org.id, owner.userId, force);
    console.log(`- ${org.slug}: models, configs, B1 entities${force ? " (forced)" : ""}`);
  }
  console.log(`Seeded ${targets.length} organization(s).`);
}

await main();
await pool.end();
