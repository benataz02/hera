/**
 * Seed a known dev login mapped to the tenant the agent serves, so quotes created
 * in the SPA flow to the running agent -> B1 -> back.
 *
 * Run (server up):  bun run seed:dev
 */
import { eq } from "drizzle-orm";
import { db, pool, tenantIntegration } from "@hera/db";
import { hashToken } from "../apps/server/src/crypto.ts";

const BASE = process.env.BETTER_AUTH_URL ?? "http://localhost:3000";
const AUTH = `${BASE}/api/auth`;
const TOKEN = process.env.HERA_AGENT_TOKEN ?? "dev-agent-token-acme";
const EMAIL = "dev@hera.test";
const PASSWORD = "hera-dev-1234";
const SLUG = "acme";

const cookies = (res: Response) =>
  res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
const post = (cookie: string | undefined, body: unknown) => ({
  method: "POST",
  headers: { "content-type": "application/json", origin: BASE, ...(cookie ? { cookie } : {}) },
  body: JSON.stringify(body),
});

async function main(): Promise<void> {
  // Sign up the dev user, or sign in if it already exists.
  let res = await fetch(`${AUTH}/sign-up/email`, post(undefined, { email: EMAIL, password: PASSWORD, name: "Dev" }));
  if (!res.ok) {
    res = await fetch(`${AUTH}/sign-in/email`, post(undefined, { email: EMAIL, password: PASSWORD }));
    if (!res.ok) throw new Error(`sign-in failed ${res.status}: ${await res.text()}`);
  }
  const cookie = cookies(res);

  // Find or create the acme org.
  const listRes = await fetch(`${AUTH}/organization/list`, { headers: { cookie, origin: BASE } });
  const orgs = (await listRes.json()) as Array<{ id: string; slug: string }>;
  let org = orgs.find((o) => o.slug === SLUG);
  if (!org) {
    const createRes = await fetch(`${AUTH}/organization/create`, post(cookie, { name: "ACME", slug: SLUG }));
    if (!createRes.ok) throw new Error(`org create failed ${createRes.status}: ${await createRes.text()}`);
    org = (await createRes.json()) as { id: string; slug: string };
  }
  await fetch(`${AUTH}/organization/set-active`, post(cookie, { organizationId: org.id }));

  // Map the agent token to THIS org, uniquely (clear any stale rows sharing the hash).
  const hash = hashToken(TOKEN);
  await db.delete(tenantIntegration).where(eq(tenantIntegration.agentTokenHash, hash));
  await db.insert(tenantIntegration).values({
    tenantId: org.id,
    agentTokenHash: hash,
    b1BaseUrl: process.env.B1_BASE_URL,
    companyDb: process.env.B1_COMPANY_DB,
  });

  console.log("Seeded dev tenant:");
  console.log(`  org   : ${org.id} (slug ${SLUG})`);
  console.log(`  login : ${EMAIL} / ${PASSWORD}`);
  console.log(`  agent : token maps to this org`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
