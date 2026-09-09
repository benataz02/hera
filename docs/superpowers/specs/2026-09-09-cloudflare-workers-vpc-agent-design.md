# Cloudflare Workers VPC as a replacement for `hera-agent` — Design Analysis (2026-09-09)

Status: **analysis, not a decision**. Nothing in this document is implemented.

Question asked: can Cloudflare Workers VPC replace `apps/agent` as the way the cloud reaches a
customer's on-prem SAP B1 Service Layer?

Short answer: it can replace the *transport*, and only the transport. It cannot replace the three
things the agent actually exists for — on-prem credentials, one B1 session per tenant, and an
allowlisted operation surface — without those moving into the cloud or being rebuilt on Durable
Objects. There is also a multi-tenancy problem that is not obvious from the docs: **VPC bindings
are static Wrangler config, resolved at deploy time**, and HERA adds a private network per
customer.

## What Workers VPC is (verified against the docs, 2026-09-09)

Three pieces:

1. `cloudflared` runs on the customer's network and dials out to Cloudflare. Requires **2025.7.0 or
   later**, **QUIC** transport (`auto` or `quic`), and outbound **UDP/7844**. No inbound firewall
   rule, no public IP, no public hostname. Ingress configuration is irrelevant here — routing is
   the VPC Service's job.
2. A **VPC Service** (host + port, `http` or `tcp`) or a **VPC Network** (a whole tunnel, or
   `cf1:network` = account-wide Cloudflare Mesh) is registered against that tunnel.
3. A **Worker** binds it in `wrangler.jsonc` and calls `env.BINDING.fetch(absoluteUrl)`.

```jsonc
// VPC Service: one binding per host+port
{ "vpc_services": [{ "binding": "SAP_SL", "service_id": "<uuid>", "remote": true }] }
// VPC Network: one binding per tunnel (or cf1:network for the whole account)
{ "vpc_networks":  [{ "binding": "TENANT_NET", "tunnel_id": "<uuid>", "remote": true }] }
```

Load-bearing details for us:

- **The VPC Service config always wins over the URL.** The host in `fetch()` only sets `Host` and
  the SNI value; **the port is ignored entirely**. So `:50000` (Service Layer) and `:60020` (API
  Gateway Reporting Service) are *two different VPC Services*, not one service and two URLs.
- **TLS.** With the `https` scheme the tunnel verifies the origin cert, and only publicly trusted
  CAs and Cloudflare Origin CA are trusted. A stock B1 Service Layer ships a self-signed cert, so
  this needs `cert_verification_mode: "disabled"` (or `verify_ca`), or a Cloudflare Origin CA cert
  installed on the SL host. Note this replaces the agent's Bun `tls: { rejectUnauthorized: false }`
  — that option does not exist in `workerd`, so the self-signed decision moves from code to
  service config.
- **Limits.** 1000 VPC Services per account; otherwise standard Workers limits. Subrequests are
  **10,000/request on paid but 50/request on free** — the free tier would break
  `fetchPersonalFieldsSetups()` and any multi-page history sync. HTTP-triggered Workers have no
  wall-clock duration limit, so the existing 70 s `AbortSignal.timeout` is fine.
- **Beta**, free on all Workers plans, APIs may change before GA.

## The structural blocker: bindings only exist inside a Worker

`RemoteTransport` runs inside the HERA server, which is Bun + Hono in a container behind Caddy
(`docker-compose.yml`, `Caddyfile`). There is no way to call a VPC binding from there. Adopting
Workers VPC therefore means putting a Worker somewhere in the path. Three shapes:

| | Shape | Verdict |
|---|---|---|
| **A** | Port `apps/server` to Workers | Disproportionate. Postgres pool → Hyperdrive, `node:crypto` in `crypto.ts`, better-auth, SPA serving, and the assistant's durable turn engine (leases, `lastEventId` resume) would want Durable Objects. Months, for no product gain. |
| **B** | A thin Worker **replaces** the agent: it holds the VPC binding and runs `ServiceLayer` itself | Smallest diff in HERA, biggest change in the security story — SAP credentials move to the cloud. |
| **C** | A thin Worker **relays to** the agent over the VPC Service; agent stays | Keeps every property the agent has. Gain is limited to deleting the public tunnel hostname and the Access token pair. |

Under **B** and **C** alike, `packages/b1`'s seam pays off: `RemoteTransport`, `toOrpcError`,
`runnerFor`, `readPages` and every call site are untouched. `sapConnection.agentUrl` stops being a
tunnel hostname and becomes the Worker's URL — still a database row, still not a branch in the code.

## The multi-tenancy problem

`vpc_services` and `vpc_networks` are static Wrangler config. HERA onboards one private network per
customer. So:

1. **One binding per tenant, one Worker.** Every customer onboarding is a Worker redeploy. Rejected.
2. **`network_id: "cf1:network"`** — one binding, account-wide, runtime URL picks the destination.
   This is the only shape that scales without a redeploy, and it is the wrong one for a multi-tenant
   SaaS: every customer uses RFC1918 space, so tenant A's `10.0.0.5` and tenant B's `10.0.0.5` are
   ambiguous (the docs offer no virtual-network scoping for VPC Networks), and a single bad
   `sap_connection` row turns one Worker into an SSRF pivot across *every* customer network. It
   deletes the isolation the per-tenant bearer secret and Access token give us today.
3. **One Worker per tenant, deployed programmatically** (Workers for Platforms dispatch, or plain
   `wrangler deploy` from onboarding). Correct isolation — Cloudflare pins host and port per binding,
   which is a network-layer version of the `readNext` origin check. Costs a deploy step per tenant
   and, for WfP, a plan upgrade.

**If this is done at all, it must be (3) with per-tenant VPC Services — never `cf1:network`.**

Capacity: per tenant you need a VPC Service for the Service Layer (`:50000`), one for the API
Gateway Reporting Service (`:60020`, used by `/print`), and one for Beas if enabled. 2–3 services
per tenant against a 1000/account cap ≈ **330–500 tenants** before asking Cloudflare for a raise.

## What the agent does that a VPC Service does not

Reading `apps/agent/src/index.ts`, `packages/b1/src/service-layer.ts` and `client.ts`:

1. **Credentials never leave the customer's network.** `agent.json` holds the B1 user, password and
   company DB. Under shape B these move into HERA's database (encrypted with `crypto.ts`, like the
   agent secret already is) or into Worker secrets. That is the single biggest thing being traded,
   and it is stated as a product property in `CLAUDE.md` and `AGENTS.md`. Under shape C it is
   preserved.
2. **One B1 login, one licence slot.** `ServiceLayer` holds `cookieHeader` and a single in-flight
   login promise *in a long-lived process*. A Worker is an ephemeral isolate, replicated worldwide:
   every cold isolate would log in, and **every login burns a B1 licence slot**. B1 licences are
   finite and per-session; this is the sharpest operational risk in the whole proposal. Fixing it
   means a **Durable Object per tenant** that owns the session cookie and serialises login — which
   is, functionally, rebuilding the agent as a DO. The `// ponytail: reactive re-login` note in
   `service-layer.ts` is written for a process that stays up; it does not survive the port unchanged.
3. **An operation-shaped, on-prem-authorized surface.** The agent's route table
   (`/entity-set`, `/entity`, `/next`, `/cross-join`, `/create`, `/update`, `/delete`, `/metadata`)
   plus the `readNext` origin check mean a leaked cloud token cannot issue arbitrary Service Layer
   calls, and cannot be pointed at another host. A per-tenant **VPC Service** replaces the host/port
   half of that at the network layer (better than we do it now — Cloudflare enforces it). It does
   **not** replace the operation allowlist: an attacker with the Worker's credentials could still
   `DELETE` any entity set. Keep the route table wherever `ServiceLayer` ends up running.
4. **`/print`.** Not a `B1Transport` operation — a different service on a different port returning
   base64. Needs its own VPC Service (see the port rule above) and its own route on the Worker.

## What is actually gained

- No HERA-authored binary on the customer's network — but `cloudflared` still installs as a Windows
  service. It is a swap of one service for another, and the honest gain is that Cloudflare maintains
  and updates theirs while we maintain ours.
- No public hostname for the agent; `sapConnection.accessClientId` / `accessClientSecret` become
  dead columns (the Access service-token pair is no longer needed).
- Onboarding does not obviously get simpler: `agent.json` + a tunnel becomes a tunnel + a VPC
  Service created over the REST API + a per-tenant Worker deploy.

## Recommendation

**Do not replace the agent.** The agent's value is not the HTTP hop; it is credentials on-prem, one
B1 session, and an allowlisted surface. Workers VPC replaces the hop only, and it costs a Durable
Object to get the session back.

Two proportionate options, in order:

1. **Nothing.** If the complaint is "customers dislike installing our binary", the cheaper fix is
   packaging and signing, not architecture. The tunnel already exists.
2. **Shape C, if the public agent hostname is the specific objection.** Register the agent's own
   `:4000` as a per-tenant VPC Service, put a thin Worker in front, point `sapConnection.agentUrl`
   at it. The agent, `agent.json`, the licence-slot handling and the route table all stay exactly as
   they are; the public hostname and the Access token pair go away. Cost: one Worker per tenant,
   deployed at onboarding.

Shape B (agent deleted, `ServiceLayer` in a Worker) is only worth it if "no HERA software on-prem"
becomes a hard product requirement. Then the work is: `apps/vpc-worker` mounting the existing route
table against a `VpcTransport`, a Durable Object per tenant for the B1 session, SAP credentials
moved into `sap_connection` under `crypto.ts`, 2–3 VPC Services per tenant, and per-tenant Worker
deploys — with the `tls: { rejectUnauthorized: false }` decision migrating to
`cert_verification_mode`. Note that this reverses a documented product promise, so it is a business
decision before it is an engineering one.

## Schema sketch (if shape B or C is ever taken)

`sap_connection` keeps `tenantId`, `secret`, `beasEnabled`, `status`, and gains:

```
vpcTunnelId       text     -- the customer's cloudflared tunnel
vpcServiceIdB1    text     -- Service Layer, :50000
vpcServiceIdPrint text     -- API Gateway Reporting Service, :60020 (nullable)
vpcServiceIdBeas  text     -- nullable
workerUrl         text     -- replaces agentUrl
```

`accessClientId` / `accessClientSecret` are dropped. Everything above the `B1Transport` seam is
unchanged.

## Sources

- https://developers.cloudflare.com/workers-vpc/
- https://developers.cloudflare.com/workers-vpc/get-started/
- https://developers.cloudflare.com/workers-vpc/configuration/vpc-services/
- https://developers.cloudflare.com/workers-vpc/configuration/vpc-networks/
- https://developers.cloudflare.com/workers-vpc/configuration/tunnel/
- https://developers.cloudflare.com/workers-vpc/api/
- https://developers.cloudflare.com/workers-vpc/reference/limits/
- https://developers.cloudflare.com/workers/platform/limits/
