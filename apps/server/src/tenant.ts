// Tenant slug lives in the request host: `<slug>.<baseDomain>`. The apex (and a few
// reserved labels) carry no tenant. This is the only place the host is parsed server-side.
import assert from "node:assert/strict";

const RESERVED = new Set(["app", "www", "api", "auth", "admin", "static", "assets"]);

/** `acme.hera.local` + base `hera.local` -> "acme"; apex/reserved/deeper -> null. */
export function tenantSlugFromHost(
  host: string | null | undefined,
  baseDomain: string,
): string | null {
  if (!host) return null;
  const name = host.split(":")[0]!.toLowerCase(); // drop port
  const base = baseDomain.toLowerCase();
  if (name === base) return null; // apex
  const suffix = `.${base}`;
  if (!name.endsWith(suffix)) return null;
  const label = name.slice(0, -suffix.length);
  if (!/^[a-z0-9-]+$/.test(label)) return null; // single label only (no deeper subdomains)
  return RESERVED.has(label) ? null : label;
}

// ponytail: assert-based self-check — `bun apps/server/src/tenant.ts`.
if (import.meta.main) {
  const t = (h: string | null, b: string) => tenantSlugFromHost(h, b);
  assert.equal(t("acme.hera.local", "hera.local"), "acme");
  assert.equal(t("acme.localhost:5173", "localhost"), "acme");
  assert.equal(t("ACME.Hera.Local", "hera.local"), "acme");
  assert.equal(t("hera.local", "hera.local"), null); // apex
  assert.equal(t("localhost:3000", "localhost"), null); // apex
  assert.equal(t("app.hera.local", "hera.local"), null); // reserved
  assert.equal(t("a.b.hera.local", "hera.local"), null); // deeper subdomain
  assert.equal(t("acme.evil.com", "hera.local"), null); // wrong base
  assert.equal(t(null, "hera.local"), null);
  console.log("tenant.ts ok");
}
