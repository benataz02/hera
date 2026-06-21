# HERA - B2B SAP CPQ and Integration Platform

## Objective
I want to create a cpq that is able to solve the most common problems of SME manufacturing companies which use SAP B1 by exploiting their historical production and sales data to provide more accurate and faster product configurations and automated sales-to-production process.

## Product functionalities
ERP/MES integration + n8n
The product will integrate with SAP B1 using Service Layer to retrieve all the master data from the ERP or other MES system (Beas Manufacturing, etc.) so main integration point will be SAP and then open to integrate also with other system / datasources.
Deep integration with sap b1 service layer. Use metadata endpoint to autodiscover entities and autodefine all the schemas (get/put/post). User will decide which schemas to include in the app and if they will be read only or also edit/create.
Connect with MES/Other API/datasources to read/create/edit BOM / Routings
It will integrate with n8n to create any kind of automatizations in the sales-to-production process.

### Historical Data
The app will be able to read and extract relevant historical data from sales and production to provide support or even automate the configuration process by finding similar past productions/sales item data. To achieve this, the app will be able to perform deep technical analysis from the historical data to find the most relevant parameters from sales/production for a set of defined product families by the users. I want to explore the analysis options, given that the historical dataset for sme will usually be less than 50000 workorders.
The parameters extracted from the technical analysis will be saved by family and will be exploited by the product configurator. The analysis can be performed as many times as wanted using different methods to obtain the most accurate insight possible and rank the most important parameters by importance, to then use them to find similar products.

### Product Configurator
The main strong point must be the product configurator. It will have a configurator builder to create configurations for different products/families. These builds will be the base framework for the configuration flow, they will:
Set the rules / constraints
Build the framework of the configuration state and how it will be changed
There will be two kinds of product configurator. Both will work with the same base framework. So user will be able to switch from automated to manual mode and viceversa depending on its needs.
Both configurator modes will extract similar product information to assist the user or even automate the configuration process.

### Manual Product Configurator
The manual configurator will be use the selected product configuration as base to build the UI for the user to configure the product, using elements such as:
Tables
Images
Formullas
Any kind of input fields (dropdown, input, multicombobox, etc.)
Sections, subsections
It will find similar item data as the user is entering the configuration parameters and show it to the user as suggestion or to copy directly the suggestion.

### The automated configurator
The automated configurator will use the same built configuration frameworks with the rules and constraints and will strictly follow it. The functionalitites will be:
User will provide images, emails, technical drowings, etc. the configurator will use claude or other AI Provider to extract the information and build the configuration always following the stablished framework.
It will extract similar product information and show the user the most relevant past productions, sales prices or even configurations.
In case of doubt, the AI configuator agent will ask questions to the user, give options, and other kinds of functionalities to ease and automate the configuration
The agent will be able to call other subagents such as UI subagent to generate UI dinamically to show suggestions, prices, and other elements

I want to create a detailed executable step by step by step plan. Before that I want to go through the details of the project backbone (auth. multi tenancy, deployment, integration layer (sap b1 service layer, beas service layer, others, sessions, etc) q&a to decide architecture, technologies, each section design and key decisions, etc.


## Current decided stack
- react vite spa
- monorepo
- subdomain multi tenancy
- sap ui5 webcomponents for react
- postgredb (shared db, tables between tenants)
- drizzle
- zod v4
- orpc


## Auth + Service Integration details already decided

### Two separate session layers

The whole design rests on keeping these apart:

| | Layer 1 — User → App | Layer 2 — App → SAP/BEAS/Others |
|---|---|---|
| **Who authenticates** | each human user | one service account per tenant |
| **Handled by** | Better Auth | your own `ServiceLayerClient` |
| **Method** | email/pw, Google, Microsoft | Service Layer cookie login |
| **Tenant boundary** | `organization` plugin | `tenant_integration` row |
| **Session lifetime** | normal web session | ~30 min idle, auto-refreshed |

Better Auth never sees SAP. SAP never sees your users. The only bridge between
them is `session.activeOrganizationId`.

### Layer 1 — Identity (Better Auth)

- **User** — a person, signed in via email/password, Google, or Microsoft.
  All three are plain login; **no enterprise SSO / SAML**.
- **Organization = Tenant** — one org per customer company. Provided by the
  `organization` plugin (members, roles, invitations all built in).
- **Active organization** — the tenant a user is currently acting as, stored on
  the session as `activeOrganizationId`. This is the key that selects which
  SAP config to use.
- **Membership** — users join a tenant via invitation; a user can belong to
  more than one.



### Layer 2: CPQ Cloud ↔ On-Prem ERP Sync

#### Core principle
At-least-once delivery is **our** job; "no duplicates" is the **ERP's** job.
Exactly-once doesn't exist → aim for *effectively once* = at-least-once delivery + idempotent consumer.
No new infrastructure needed: Postgres + Drizzle + oRPC is enough.

#### Connectivity model
- **Pull, not push.** On-prem agent makes outbound HTTPS to the cloud, pulls work, executes against the local B1 Service Layer, acks back.
- No inbound ports, no VPN, no exposed Service Layer.

#### Agent identity — the cloud never knows any IP
- The cloud is a **passive HTTP server**; the agent is the client that dials out → there is **no IP to discover, no registry, no inbound rule**.
- Tenant is resolved from the **credential the agent presents** (per-tenant bearer token, or mTLS client cert), not its address.
  - `Authorization: Bearer <token>` → resolve → `tenant_id` → scope all queries.
- Agent can be behind NAT, on a dynamic IP, restarted, or moved — irrelevant, since it always initiates.
- Two agents for one tenant → per-tenant advisory lock makes the second a harmless no-op.

#### Three breaking points

##### 1. Cloud app — SOLVED by transactional outbox
- Write business change + `outbox` row in the **same Postgres transaction**.
- Both commit or neither → intent to sync can never be lost.
- Agent claims rows with a **lease / visibility timeout** + `FOR UPDATE SKIP LOCKED`.
- oRPC procedures (tenant-scoped): `sync.pull`, `sync.ack`, `sync.nack`.
- Exhausted attempts → `failed` = dead-letter, surfaced in UI.

##### 2. The agent — guards
- **Singleton per tenant** via Postgres advisory lock (FIFO for free; double-deploy harmless).
- **Stateless** — every durable fact lives in the cloud outbox or B1, never agent memory/disk.
- **Per-item isolation** — wrap each row; poison rows dead-letter instead of crash-looping.
- **Unknown POST outcome = in-doubt = transient.** Never blindly re-POST; let redelivery + GET-check resolve it.
- **Only `ack` on confirmed result; only `permanent` on confirmed business rejection.** Everything else is transient.
- **Heartbeat** (`last_seen_at`) → show "agent offline" in UI; make cloud-side ack/nack idempotent.

##### 3. B1 Service Layer — guards
- **Session manager** with single-flight re-login on 401; carry `ROUTEID` if load-balanced.
- **Atomic writes** — document + lines inline in one POST; use `$batch` changeset (single transaction) for multi-object units.
- **Idempotency as a hard constraint** — external-key UDF (`U_CpqExtId`) with a **unique index** in HANA.
  - GET-before-POST (fast path) → if exists, ack.
  - On unique-violation race → GET + ack. Duplicate becomes physically impossible.
- **When to GET-before-POST is driven by the `attempts` counter** (incremented at *claim* time, before the agent acts):
  - `attempts == 1` → first-ever delivery → duplicate impossible → **POST directly, skip the GET** (happy path, no wasted round trip).
  - `attempts > 1` → a prior attempt didn't cleanly ack → duplicate possible → **GET first; if found ack, else POST.**
  - Counter is *conservative* ("dup possible," not certain) → at worst one wasted GET, never a blind re-POST.
  - Counter = optimization (*whether* to check); `dedupKey` = *what* to check; unique index = the actual guarantee underneath.
- **Error classification drives everything:**
  - 401 → re-auth, retry (don't count attempt).
  - 5xx / network / timeout → transient → backoff + redeliver.
  - 400-class business rejection → permanent → dead-letter for a human.
  - Object-lock → transient, short backoff.
- **Gate batch on health** — back off the whole tenant when B1/HANA is down so attempt counters stay meaningful.

##### Latency — push-like speed over an outbound-only connection
- **Long polling + Postgres `LISTEN`/`NOTIFY`.** Agent's `pull` is held open by the cloud (~30s) instead of sleeping; cloud answers the instant work appears.
- Posting a quote fires `pg_notify('outbox_t<tenant>', '')` **in the same transaction** as the outbox insert → parked pull wakes in ms.
- **Doorbell only** — NOTIFY carries an empty payload; agent does its own scoped `SELECT` after waking.
- **Latency ≠ delivery.** NOTIFY is purely an optimization; a missed notification just means the 30s timeout/reconnect (plus a slow full-sweep backstop) picks the row up. Worst case = slower, never lost.
- **Return leg to the browser** (don't forget, or it *feels* slow): optimistic UI shows `syncing`; SPA holds its own long-poll/SSE on the quote's status; agent's ack flips it to `synced` + `DocEntry` via the same `LISTEN`/`NOTIFY`.
- In oRPC: express both as **event-iterator (SSE) procedures** — `sync.subscribe` (agent) and `quote.watch` (browser).
- **Caveats:**
  - **PgBouncer transaction mode silently breaks `LISTEN`** → give the listener a dedicated direct/session connection (Drizzle still uses the pool for everything else).
  - **One listener connection, fanned out in-process** (`Map<tenantId, Set<resolver>>`) — never one `LISTEN` connection per parked request.

##### The linchpin
- Agent: **never `ack` without confirmation, never re-POST without a GET.**
- B1: **carry a unique-indexed external key** so the write itself is idempotent.
- These two facts collapse every failure (crash, timeout, double-start, network split) into a safe retry.

##### End-to-end happy path
user posts quote → commit + `pg_notify` → parked agent pull wakes (ms) → agent POSTs to B1 → acks with `DocEntry` → that ack `pg_notify`s the browser stream → UI flips `syncing` → real result.
The cloud never contacts the agent's IP; the agent always holds the connection open and the cloud answers it.

##### Explicitly out of scope
Kafka / RabbitMQ / Redis / BullMQ — overkill for <50 users.
Optional lightweight fallback only if hand-rolling the queue gets old: **pg-boss** (lives in existing Postgres, no Redis).


Understand the high level scope, and create a detailed plan to implement the backbone of the project. In case of doubt ask everything before asuming any detail.