/**
 * Seed the aluminium demo model into the acme tenant, published, so /configure has something to run.
 *
 * Run (after seed:dev):  bun run seed:config
 */
import { and, eq } from "drizzle-orm";
import { db, pool, organization, configModel } from "@hera/db";
import { aluminiumModel } from "@hera/config-engine";

const SLUG = "acme";

async function main(): Promise<void> {
  const [org] = await db.select({ id: organization.id }).from(organization).where(eq(organization.slug, SLUG)).limit(1);
  if (!org) throw new Error(`org '${SLUG}' not found — run 'bun run seed:dev' first`);

  // Replace any prior copy so re-running is idempotent (no unique key on name).
  await db.delete(configModel).where(and(eq(configModel.tenantId, org.id), eq(configModel.name, aluminiumModel.name)));
  const [row] = await db
    .insert(configModel)
    .values({
      tenantId: org.id,
      name: aluminiumModel.name,
      family: aluminiumModel.family,
      definition: aluminiumModel as unknown as Record<string, unknown>,
      published: true,
    })
    .returning({ id: configModel.id });

  console.log(`Seeded model '${aluminiumModel.name}' (${row!.id}) for ${SLUG} — published.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
