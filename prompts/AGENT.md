# Layer 2: CPQ Cloud ↔ On-Prem ERP Sync
An agent will enable cloud - onprem comms for read/write operations

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

