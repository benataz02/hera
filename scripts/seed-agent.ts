/**
 * Point a tenant at an on-prem agent. This row IS the difference between dev and production:
 * `agentUrl` is http://localhost:4000 on a dev box and the Cloudflare Tunnel hostname in a
 * customer install, and the Access service token is null in the first case.
 *
 *   bun --env-file=.env scripts/seed-agent.ts <slug> [agentUrl] [secret]
 *   bun --env-file=.env scripts/seed-agent.ts alumigraf https://agent-acme.example S3CRET \
 *       --access-id=<id> --access-secret=<secret> --beas
 *
 * The secret must match `secret` in the agent's agent.json (and agent.example.json in
 * local dev). It is stored encrypted.
 */
import { eq } from "drizzle-orm";
import { db, pool, organization, sapConnection } from "@hera/db";
import { encryptSecret } from "../apps/server/src/crypto.ts";

const [slug, agentUrl = "http://localhost:4000", secret = "dev-secret-change-me-min-32-chars-long"] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const flag = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=").slice(1).join("=") ?? null;

if (!slug) {
  console.error("usage: bun scripts/seed-agent.ts <slug> [agentUrl] [secret] [--access-id=] [--access-secret=] [--beas]");
  process.exit(1);
}

const [org] = await db.select({ id: organization.id }).from(organization).where(eq(organization.slug, slug)).limit(1);
if (!org) {
  console.error(`no organization with slug '${slug}' — run seed:dev first`);
  process.exit(1);
}

const row = {
  tenantId: org.id,
  agentUrl,
  secret: encryptSecret(secret),
  accessClientId: flag("access-id"),
  accessClientSecret: flag("access-secret"),
  beasEnabled: process.argv.includes("--beas"),
  status: "ok" as const,
};

await db.insert(sapConnection).values(row).onConflictDoUpdate({ target: sapConnection.tenantId, set: row });

console.log(`${slug} -> ${agentUrl}${row.accessClientId ? " (behind Cloudflare Access)" : ""}${row.beasEnabled ? " + beas" : ""}`);
await pool.end();
