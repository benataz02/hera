/**
 * Bootstrap a dev tenant from an empty database: a user + the org whose slug IS the
 * subdomain. Sign in at http://lvh.me:5173, land on http://<slug>.lvh.me:5173.
 *
 *   bun run seed:dev [slug] [email] [password]
 *
 * Standard views come from auth.ts's afterCreateOrganization hook, so no seed:standard
 * needed after this. Idempotent: re-running skips whatever already exists.
 */
import { eq } from "drizzle-orm";
import { db, pool, organization, user as userTable } from "@hera/db";
import { auth } from "../apps/server/src/auth.ts";

const slug = process.argv[2] ?? process.env.SLUG ?? "alumigraf";
const email = process.argv[3] ?? `dev@${slug}.test`;
const password = process.argv[4] ?? "dev1234";

async function main(): Promise<void> {
  const [existingUser] = await db
    .select({ id: userTable.id })
    .from(userTable)
    .where(eq(userTable.email, email))
    .limit(1);

  const userId =
    existingUser?.id ??
    (await auth.api.signUpEmail({ body: { email, password, name: "Dev User" } })).user.id;
  console.log(`user  ${email} / ${password}`);

  const [existingOrg] = await db
    .select({ id: organization.id })
    .from(organization)
    .where(eq(organization.slug, slug))
    .limit(1);

  if (existingOrg) {
    console.log(`org   ${slug} (already existed)`);
  } else {
    await auth.api.createOrganization({
      body: { name: slug, slug, userId },
    });
    console.log(`org   ${slug} (created, Standard views seeded)`);
  }

  console.log(`\nsign in: http://lvh.me:5173  ->  http://${slug}.lvh.me:5173`);
}

await main();
await pool.end();
