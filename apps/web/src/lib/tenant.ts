// Client-side mirror of apps/server/src/tenant.ts. The subdomain label is the org slug;
// the apex (and a few reserved labels) carry no tenant. The server re-validates against
// membership — this is only for UX/redirects.

const RESERVED = new Set(["app", "www", "api", "auth", "admin", "static", "assets"]);

export const BASE_DOMAIN = (import.meta.env.VITE_APP_BASE_DOMAIN ?? "localhost").toLowerCase();

/** Tenant slug from window.location.hostname, or null on the apex/reserved hosts. */
export function currentSlug(): string | null {
  const name = window.location.hostname.toLowerCase();
  if (name === BASE_DOMAIN) return null;
  const suffix = `.${BASE_DOMAIN}`;
  if (!name.endsWith(suffix)) return null;
  const label = name.slice(0, -suffix.length);
  if (!/^[a-z0-9-]+$/.test(label) || RESERVED.has(label)) return null;
  return label;
}

export const isApex = () => currentSlug() === null;

const portPart = () => (window.location.port ? `:${window.location.port}` : "");

export const apexUrl = (path = "/") =>
  `${window.location.protocol}//${BASE_DOMAIN}${portPart()}${path}`;

export const tenantUrl = (slug: string, path = "/") =>
  `${window.location.protocol}//${slug}.${BASE_DOMAIN}${portPart()}${path}`;

/**
 * Cross-origin hop (apex <-> subdomain). Returns a never-resolving promise so a router
 * beforeLoad halts instead of rendering before the browser navigates.
 */
export function hardRedirect(url: string): Promise<never> {
  window.location.assign(url);
  return new Promise<never>(() => {});
}

/**
 * Guard against open redirects: only ever hand back a URL whose hostname is the apex
 * (`BASE_DOMAIN`) or one of its tenant subdomains (`*.BASE_DOMAIN`). Anything else —
 * unparsable, a relative path, a foreign host, `javascript:`, protocol-relative to
 * elsewhere — comes back `null` so callers fall through to a safe default instead of
 * following it. Deliberately requires an absolute URL (no base arg): `redirect=` is only
 * ever produced by this app as a full `window.location.href` (see routes/accept.tsx).
 */
export function safeRedirect(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    if (host === BASE_DOMAIN || host.endsWith(`.${BASE_DOMAIN}`)) return url; // never an open redirect
  } catch {
    /* ignore — not a valid URL */
  }
  return null;
}

/** Clean a company name into a subdomain candidate (no random suffix — it's the permanent URL). */
export const toSlug = (name: string) =>
  name.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "").slice(0, 30);

export const SLUG_RE = /^[a-z][a-z0-9-]{1,30}$/;
export const isReserved = (slug: string) => RESERVED.has(slug);
