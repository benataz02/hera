/**
 * Provision an on-prem agent for an EXISTING tenant (organization slug): map a bearer
 * token to that org so the agent's pull loop can claim its work. Unlike seed:dev this
 * does no auth/onboarding — the org must already exist. No server needed.
 *
 *   bun run seed:agent <slug> [token]
 *
 * Then set HERA_AGENT_TOKEN=<token> in the agent's .env and (re)start the agent.
 */
import { eq } from "drizzle-orm";
import { db, pool, organization, tenantIntegration } from "@hera/db";
import { hashToken } from "../apps/server/src/crypto.ts";

// NB: don't fall back to env HERA_AGENT_TOKEN — that's the agent's *own* token and would
// reassign it (and steal it from whichever tenant currently owns it).
const slug = process.argv[2] ?? process.env.SLUG;
const token = process.argv[3] ?? `dev-agent-token-${slug}`;
if (!slug) throw new Error("usage: bun run seed:agent <slug> [token]");

async function main(): Promise<void> {
  const [org] = await db
    .select({ id: organization.id })
    .from(organization)
    .where(eq(organization.slug, slug))
    .limit(1);
  if (!org) throw new Error(`No organization with slug '${slug}'. Onboard it first.`);

  // A token hash maps to exactly one tenant: clear any stale owner, then upsert this org's row.
  const hash = hashToken(token);
  await db.delete(tenantIntegration).where(eq(tenantIntegration.agentTokenHash, hash));
  await db
    .insert(tenantIntegration)
    .values({
      tenantId: org.id,
      agentTokenHash: hash,
      b1BaseUrl: process.env.B1_BASE_URL,
      companyDb: process.env.B1_COMPANY_DB,
    })
    .onConflictDoUpdate({ target: tenantIntegration.tenantId, set: { agentTokenHash: hash } });

  console.log(`Agent provisioned for '${slug}' (${org.id}).`);
  console.log(`  set in the agent's .env:  HERA_AGENT_TOKEN=${token}`);
  console.log(`  then restart the agent (bun run dev:agent).`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
