# Connecting the on-prem agent with Cloudflare Tunnel

How a customer's `hera-agent` becomes reachable from the HERA cloud without an inbound firewall
rule, a public IP, or a VPN.

This is the production shape of one sentence in `CLAUDE.md`: *`sapConnection.agentUrl` is
`http://localhost:4000` in dev and a Cloudflare Tunnel hostname in production — that difference is
a database row, not a branch in the code.* Nothing below changes application code; it is all
`agent.json`, `cloudflared`, the Cloudflare dashboard, and one `seed:agent` run.

## Why a tunnel, and why this one

The agent has to be *called into* — the cloud initiates every request (`RemoteTransport` →
`agentPost`). The customer's SAP box sits on a private network behind a firewall a mid-size
manufacturer's IT will not open. The options are:

| Option | Why not |
|---|---|
| Port-forward + public DNS + TLS cert | An inbound hole into an ERP network. Most customers refuse, and rightly. |
| Site-to-site VPN / IPsec per customer | Weeks of IT calendar per onboarding, and it exposes far more than one port. |
| Agent polls the cloud for work | Inverts the request/response model the whole `B1Transport` seam is built on, and adds latency to every value-help keystroke. |
| Reverse tunnel (Cloudflare Tunnel, ngrok, Tailscale Funnel) | **This.** Outbound-only, one process, no inbound rule. |

Cloudflare Tunnel specifically:

- **Outbound only.** `cloudflared` dials out over HTTPS/QUIC (TCP/443, or UDP/7844 for QUIC). No
  inbound rule, no public IP, no NAT change.
- **Cloudflare Access in front of it**, which is what turns "a public hostname" back into "a private
  service". The cloud authenticates with a **service token** — a machine credential, no browser,
  no SSO redirect. That is exactly the shape `AgentTarget.accessClientId` /
  `accessClientSecret` already carry.
- **Runs as a Windows service**, alongside `hera-agent`, installed by the same script.
- **Free** at the volume HERA generates, and no per-tenant cloud infrastructure.
- **The customer's IT can audit it**: one signed vendor binary making outbound connections to a
  named hostname, with Access logs of every request that reached it.

The costs, stated plainly:

- A dependency on Cloudflare's edge for the SAP path. If Cloudflare is down, live pricing degrades
  to `SERVICE_UNAVAILABLE` — the same failure the code already models for an unreachable agent.
- Traffic is decrypted at the edge (this is a reverse proxy, not an end-to-end tunnel). Cloudflare
  sees B1 payloads. It never sees SAP credentials — those stay in `agent.json` — but a customer
  with a data-residency clause needs to be told, and Regional Services or a per-region Cloudflare
  account is the answer if they push back.
- Another vendor's agent on the customer's box. In practice easier to get signed off than ours,
  because it is a known quantity.

Alternatives worth naming: **Tailscale/WireGuard** gives an end-to-end encrypted mesh (Cloudflare
never sees plaintext) at the cost of running a coordination plane and putting the HERA server on
the mesh — better privacy story, more moving parts. **Workers VPC** was analysed separately in
`docs/superpowers/specs/2026-09-09-cloudflare-workers-vpc-agent-design.md`; the conclusion there
was that it replaces the transport only, and needs a Durable Object to get the single B1 session
back. **The tunnel is the right pick, and it is already what the schema and the code assume.**

## What is already in place

| Piece | Where |
|---|---|
| `agentUrl` as a per-tenant row | `packages/db/src/schema/sap.ts` |
| Service-token headers on every cloud → agent call | `packages/b1/src/remote.ts` (`agentPost`) |
| Access-token columns, encrypted bearer secret | `sap_connection` |
| Access JWT verification at the agent | `apps/agent/src/access.ts` |
| Loopback bind by default | `apps/agent/src/index.ts` (`bindHost`) |
| `cloudflared service install` in the installer | `apps/agent/deploy/install-service.ps1` |
| Setting the row | `bun run seed:agent` |

## Setup, once per customer

### 1. Create the tunnel (Cloudflare dashboard)

Zero Trust → Networks → Tunnels → **Create a tunnel** → *Cloudflared*.

Name it after the tenant (`hera-acme`). Copy the **install token** — the long string in the
`cloudflared service install <token>` command Cloudflare shows. That token is the tunnel's
credential; treat it like a password.

Add a **public hostname** on the tunnel:

| Field | Value |
|---|---|
| Subdomain | `agent-acme` |
| Domain | a zone you control, e.g. `hera-agents.example` |
| Type | `HTTP` |
| URL | `localhost:4000` |

`HTTP` to `localhost:4000`, not HTTPS: the hop from `cloudflared` to the agent is loopback on the
same host, so there is no plaintext on any wire. This is also why `bindHost` defaults to
`127.0.0.1` — with a tunnel, nothing on the customer's LAN should be able to reach :4000 at all.

### 2. Put Cloudflare Access in front of it

Zero Trust → Access → Applications → **Add an application** → *Self-hosted*.

- Application domain: `agent-acme.hera-agents.example` (the hostname from step 1).
- Session duration: whatever; service tokens ignore it.
- Policy: **Action `Service Auth`**, include → **Service Token** → the token created below.
  `Service Auth` is the part people miss — an `Allow` policy expects a human identity and will
  bounce the machine call into a login redirect.

Then Access → **Service Auth** → *Create Service Token*, named for the tenant. Cloudflare shows
the **Client ID** and **Client Secret** exactly once.

Note the application's **Application Audience (AUD) tag** from the application's overview — the
agent needs it to verify assertions.

### 3. Install on the customer's box

From the folder holding `hera-agent.exe` and `agent.json`, elevated:

```powershell
.\deploy\install-service.ps1 -TunnelToken <the install token from step 1>
```

That registers `hera-agent` and `cloudflared` as auto-start Windows services and health-checks the
agent on loopback.

`agent.json` (see `agent.example.json`) gains the `access` block:

```jsonc
{
  "port": 4000,
  "bindHost": "127.0.0.1",
  "secret": "<32+ random chars, per tenant>",
  "access": {
    "teamDomain": "acme.cloudflareaccess.com",
    "aud": "<Application Audience tag from step 2>"
  },
  "b1": { "url": "https://sapb1:50000/b1s/v2", "companyDb": "...", "user": "...", "pass": "..." }
}
```

Omit `access` and the agent starts fine with the bearer secret alone — that is the dev and LAN
shape. With it present, every request must carry a valid `Cf-Access-Jwt-Assertion` **and** the
bearer secret. Neither replaces the other: the secret says *which tenant's cloud is calling*, the
assertion says *this request came through our Access application*. `/health` stays exempt so the
installer's local `curl` and `e2e`'s first step still work; it reveals nothing but "up", and Access
still gates it from the internet.

### 4. Point the tenant at it

From the cloud host:

```bash
bun run seed:agent acme https://agent-acme.hera-agents.example <the agent.json secret> \
  --access-id=<Client ID> --access-secret=<Client Secret>
```

The secret is stored encrypted (`apps/server/src/crypto.ts`); the Access pair is stored as-is —
it is a credential for Cloudflare's edge, not for SAP, and it is scoped to this one application.

### 5. Verify

```bash
bun run e2e acme
```

Every step goes cloud → edge → tunnel → agent → Service Layer. If it passes, the tunnel is done.

## Operational notes

**Timeouts.** Cloudflare's edge gives an origin 100 seconds before a 524. The cloud → agent bound
is 70 s (`AgentTarget.timeoutMs`, `remote.ts`), which sits under it deliberately: our own
`AbortSignal.timeout` fires first and surfaces as a clean `SERVICE_UNAVAILABLE` rather than a
Cloudflare error page. Do not raise it past ~90 s without also raising the edge's — and if a read
is taking that long, bound the read instead (`readPages`' required `maxPages` exists for this).

**Response size.** Cloudflare's free plan caps *request* bodies at 100 MB. Agent requests are small
JSON; the large payloads travel the other way (`$metadata`, `/print` base64) and are not capped
that way.

**QUIC.** `cloudflared` prefers QUIC over UDP/7844. Firewalls that block outbound UDP make it fall
back to HTTP/2 over TCP/443 — slower to reconnect but functional. If IT will not open UDP/7844,
set `protocol: http2` in the tunnel config rather than fighting it.

**Diagnosing a failure, in order:**

| Symptom | Where it broke |
|---|---|
| `Agent unreachable at https://…` | Tunnel down or hostname wrong. Check `cloudflared` service on the box; `/health` from a browser (you will get the Access login page — that alone proves the edge sees the hostname). |
| An HTML login page instead of JSON | The Access policy is not `Service Auth`, or the service token was not sent. |
| `Cloudflare Access: assertion is for a different Access application` | `access.aud` in `agent.json` does not match the application. |
| `Cloudflare Access: no Cf-Access-Jwt-Assertion header` | The request reached :4000 *without* going through Access — a direct LAN hit. Check `bindHost`. |
| `The on-prem agent rejected the shared secret` | Tunnel and Access are fine; `agent.json`'s `secret` and the `sap_connection` row disagree. |
| `SAP rejected the request: …` | The whole path works. This is B1. |

The order of that table is the order of the hops, which is the point: each error names exactly one
of them.

**Rotation.** The bearer secret and the Access service token rotate independently — new value in
`agent.json` plus `seed:agent` for the first, a new token in Cloudflare plus `seed:agent` for the
second. Rotating the tunnel token means re-running `cloudflared service install`.
