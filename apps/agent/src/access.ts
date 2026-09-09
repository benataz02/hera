import { B1Error } from "@hera/b1";

/**
 * Cloudflare Access JWT verification for the agent.
 *
 * The tunnel removes the inbound firewall hole; Access is what puts an authenticator back in
 * front of the agent, and the cloud passes a **service token** (`CF-Access-Client-Id` /
 * `CF-Access-Client-Secret`, see `AgentTarget` in @hera/b1). The edge exchanges that pair for a
 * signed JWT in `Cf-Access-Jwt-Assertion` and forwards it.
 *
 * Verifying it here is what makes the Access policy load-bearing rather than advisory: without
 * this check a request that reaches :4000 by any path other than the tunnel — a stray LAN route,
 * a mistyped ingress rule, an Access policy someone loosened — needs only the bearer secret. The
 * bearer secret authenticates *the tenant's cloud*; the Access JWT proves *the request came
 * through our Access application*. Neither replaces the other, so the agent wants both.
 *
 * ponytail: RS256 only. Access has signed with RS256 for the life of the product; if it ever
 * offers another alg the fix is one more branch in `importKey`, not a JOSE dependency.
 */
export type AccessConfig = {
  /** e.g. "acme.cloudflareaccess.com" — with or without scheme. */
  teamDomain: string;
  /** The Access application's Application Audience (AUD) tag. */
  aud: string;
  /** How long a fetched key set is trusted before a scheduled refresh. Default 1 h. */
  jwksTtlMs?: number;
};

type Logger = { info: (m: string) => void; warn: (m: string, x?: unknown) => void };

const HEADER = "cf-access-jwt-assertion";
/** Clock skew allowed on exp/nbf. Access tokens are minutes-long; a minute is plenty. */
const SKEW_S = 60;
/** Floor between two key-set fetches, so an unknown `kid` cannot be used to hammer Cloudflare. */
const MIN_REFETCH_MS = 60_000;

function b64url(part: string): Uint8Array<ArrayBuffer> {
  const b64 = part.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

const json = (part: string): Record<string, unknown> =>
  JSON.parse(new TextDecoder().decode(b64url(part))) as Record<string, unknown>;

const deny = (message: string) => new B1Error(403, "access", `Cloudflare Access: ${message}`);

export class AccessVerifier {
  /** `https://<team>.cloudflareaccess.com` — the issuer the token must claim. */
  readonly issuer: string;
  private readonly certsUrl: string;
  private readonly ttlMs: number;
  private readonly aud: string;
  private keys = new Map<string, CryptoKey>();
  private fetchedAt = 0;
  /** One in-flight fetch, for the same reason ServiceLayer keeps one in-flight login: N cold
   *  requests must not become N calls to the edge. */
  private inflight: Promise<void> | null = null;

  constructor(cfg: AccessConfig, private readonly logger: Logger) {
    if (!cfg.teamDomain) throw new Error('agent.json: access.teamDomain is required (e.g. "acme.cloudflareaccess.com")');
    if (!cfg.aud) throw new Error("agent.json: access.aud is required — the Access application's AUD tag");
    const host = cfg.teamDomain.replace(/^https?:\/\//, "").replace(/\/+$/, "");
    this.issuer = `https://${host}`;
    this.certsUrl = `${this.issuer}/cdn-cgi/access/certs`;
    this.ttlMs = cfg.jwksTtlMs ?? 3_600_000;
    this.aud = cfg.aud;
  }

  private async refresh(): Promise<void> {
    if (this.inflight) return this.inflight;
    this.inflight = (async () => {
      const res = await fetch(this.certsUrl, { signal: AbortSignal.timeout(10_000) });
      // Not a denial: the agent host could not reach Cloudflare. Say so, so an operator does not
      // go looking for a bad token.
      if (!res.ok) throw new B1Error(503, "access", `Cloudflare Access: key set fetch failed (${res.status} from ${this.certsUrl})`);
      const body = (await res.json()) as { keys?: JsonWebKey[] };
      const next = new Map<string, CryptoKey>();
      for (const jwk of body.keys ?? []) {
        const kid = (jwk as { kid?: string }).kid;
        if (!kid || jwk.kty !== "RSA") continue;
        next.set(
          kid,
          await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]),
        );
      }
      if (!next.size) throw deny(`no usable RSA keys at ${this.certsUrl}`);
      this.keys = next;
      this.fetchedAt = Date.now();
      this.logger.info(`Access: ${next.size} signing key(s) from ${this.certsUrl}`);
    })().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private async keyFor(kid: string): Promise<CryptoKey> {
    const stale = Date.now() - this.fetchedAt > this.ttlMs;
    if (!this.keys.size || stale) await this.refresh();
    const hit = this.keys.get(kid);
    if (hit) return hit;
    // Unknown kid = a rotation we have not seen. Refetch, but not more often than MIN_REFETCH_MS.
    if (Date.now() - this.fetchedAt > MIN_REFETCH_MS) await this.refresh();
    const retry = this.keys.get(kid);
    if (!retry) throw deny(`token signed by unknown key '${kid}'`);
    return retry;
  }

  /** Throws a 403 B1Error unless the request carries a valid assertion for this application. */
  async assert(req: Request): Promise<void> {
    const token = req.headers.get(HEADER);
    if (!token) throw deny("no Cf-Access-Jwt-Assertion header — the request did not come through the Access application");

    const parts = token.split(".");
    if (parts.length !== 3) throw deny("malformed assertion");
    const [h, p, s] = parts as [string, string, string];

    let header: Record<string, unknown>;
    let payload: Record<string, unknown>;
    try {
      header = json(h);
      payload = json(p);
    } catch {
      throw deny("assertion is not valid JWT JSON");
    }

    if (header.alg !== "RS256") throw deny(`unexpected alg '${String(header.alg)}'`);
    const kid = typeof header.kid === "string" ? header.kid : "";
    if (!kid) throw deny("assertion has no kid");

    const ok = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      await this.keyFor(kid),
      b64url(s),
      new TextEncoder().encode(`${h}.${p}`),
    );
    if (!ok) throw deny("bad signature");

    // Claims are only meaningful after the signature check, never before.
    if (payload.iss !== this.issuer) throw deny(`issued by '${String(payload.iss)}', expected ${this.issuer}`);
    const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!aud.includes(this.aud)) throw deny("assertion is for a different Access application");

    const now = Math.floor(Date.now() / 1000);
    if (typeof payload.exp === "number" && payload.exp + SKEW_S < now) throw deny("assertion expired");
    if (typeof payload.nbf === "number" && payload.nbf - SKEW_S > now) throw deny("assertion not yet valid");
  }
}
