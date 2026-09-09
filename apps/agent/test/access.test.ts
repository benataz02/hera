import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { AccessVerifier } from "../src/access.ts";

// The Access assertion is the half of the agent's auth that proves *the request came through our
// Access application* — the bearer secret only proves which tenant's cloud is calling. Every case
// below is one way that proof can be forged or stale, and each must be a rejection: an assertion
// signed by someone else's key, minted for another application, issued by another team, or
// presented with `alg: none` in the hope the signature is never checked.

const TEAM = "acme.cloudflareaccess.com";
const AUD = "aud-tag-123";
const KID = "kid-1";
const CERTS = `https://${TEAM}/cdn-cgi/access/certs`;

const rsa = () =>
  crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  );

const b64url = (s: string) => s.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const part = (o: unknown) => b64url(btoa(JSON.stringify(o)));

let pair: CryptoKeyPair;
let stranger: CryptoKeyPair;
let verifier: AccessVerifier;
let fetches = 0;
const realFetch = globalThis.fetch;

beforeAll(async () => {
  pair = await rsa();
  stranger = await rsa();
  const jwk = { ...(await crypto.subtle.exportKey("jwk", pair.publicKey)), kid: KID };
  globalThis.fetch = (async (url: unknown) => {
    fetches++;
    if (String(url) !== CERTS) throw new Error(`unexpected fetch of ${String(url)}`);
    return Response.json({ keys: [jwk] });
  }) as typeof fetch;
  verifier = new AccessVerifier({ teamDomain: TEAM, aud: AUD }, { info: () => {}, warn: () => {} });
});

afterAll(() => {
  globalThis.fetch = realFetch;
});

async function jwt(
  claims: Record<string, unknown> = {},
  header: Record<string, unknown> = {},
  key?: CryptoKey,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const h = part({ alg: "RS256", kid: KID, ...header });
  const p = part({ iss: `https://${TEAM}`, aud: [AUD], nbf: now - 10, exp: now + 600, ...claims });
  const sig = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key ?? pair.privateKey,
    new TextEncoder().encode(`${h}.${p}`),
  );
  return `${h}.${p}.${b64url(btoa(String.fromCharCode(...new Uint8Array(sig))))}`;
}

const req = (token?: string) =>
  new Request("http://agent/b1/entity-set", { headers: token ? { "Cf-Access-Jwt-Assertion": token } : {} });

describe("AccessVerifier", () => {
  test("accepts an assertion from the configured application", async () => {
    expect(await verifier.assert(req(await jwt()))).toBeUndefined();
  });

  test("caches the key set — N requests are not N calls to the edge", async () => {
    const before = fetches;
    await verifier.assert(req(await jwt()));
    await verifier.assert(req(await jwt()));
    expect(fetches).toBe(before);
  });

  test("rejects a request that never went through Access", async () => {
    await expect(verifier.assert(req())).rejects.toThrow(/no Cf-Access-Jwt-Assertion/);
  });

  test("rejects an assertion minted for another Access application", async () => {
    await expect(verifier.assert(req(await jwt({ aud: ["someone-elses-app"] })))).rejects.toThrow(
      /different Access application/,
    );
  });

  test("rejects an assertion from another Cloudflare team", async () => {
    await expect(verifier.assert(req(await jwt({ iss: "https://evil.cloudflareaccess.com" })))).rejects.toThrow(
      /expected https:\/\/acme/,
    );
  });

  test("rejects an expired assertion", async () => {
    await expect(verifier.assert(req(await jwt({ exp: Math.floor(Date.now() / 1000) - 3600 })))).rejects.toThrow(/expired/);
  });

  test("rejects a signature from a key that is not Cloudflare's", async () => {
    await expect(verifier.assert(req(await jwt({}, {}, stranger.privateKey)))).rejects.toThrow(/bad signature/);
  });

  test("rejects alg:none — the signature is checked before any claim is read", async () => {
    const now = Math.floor(Date.now() / 1000);
    const unsigned = `${part({ alg: "none", kid: KID })}.${part({ iss: `https://${TEAM}`, aud: [AUD], exp: now + 600 })}.`;
    await expect(verifier.assert(req(unsigned))).rejects.toThrow(/unexpected alg 'none'/);
  });

  test("rejects a token signed by a key the team does not publish", async () => {
    await expect(verifier.assert(req(await jwt({}, { kid: "rotated-away" })))).rejects.toThrow(/unknown key/);
  });

  test("rejects anything that is not a JWT", async () => {
    await expect(verifier.assert(req("not-a-jwt"))).rejects.toThrow(/malformed/);
  });
});
