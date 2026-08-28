# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

HERA is a multi-tenant SaaS quoting platform for SME manufacturers running on-prem SAP Business One.
`AGENTS.md` describes what the product does in plain language; this file is the technical picture.

## Commands

Everything runs on **Bun** (no npm — see `package.json` workspaces).

```bash
docker compose up -d db                 # Postgres 17 on :5432 (dev runs server/web with bun)
bun install
bun run db:push                         # drizzle-kit push — the ONLY schema migration path
bun run seed:dev [slug]                 # a user + org; sign in at http://lvh.me:5173
bun run dev                             # server (:3000) + web (:5173) in parallel
bun run dev:agent                       # the on-prem agent, from apps/agent/agent.json
bun run kill                            # scripts/kill-dev.ps1 — frees the dev ports on Windows
```

Tests are `bun:test`. A bare `bun test` also picks up the vendored `b1-mcp-server/`, whose own
suite fails (its deps are not installed) — always scope:

```bash
bun test apps packages                  # the whole suite
bun test apps/server/test/lookups.test.ts
bun test packages/b1 -t "login"         # filter by test name
```

There is no lint step. Type-checking is the gate, and it is **per project** — there is no root
tsconfig that covers everything, so a change can typecheck in one package and break another:

```bash
bunx tsc -p apps/server/tsconfig.json --noEmit
# projects: packages/{b1,config-engine,db,assistant}, apps/{agent,server,web}
bun --cwd apps/web build                # also regenerates routeTree.gen.ts (gitignored)
```

Note `apps/server/tsconfig.json` also includes `../../scripts`, so the seed/migration/e2e scripts
are checked there rather than in a project of their own.

Live-SAP work:

```bash
bun run seed:agent <slug> http://localhost:4000 <secret>   # secret must match agent.json
bun run e2e <slug>                      # cloud -> agent -> Service Layer smoke test
bun run migrate:queries [--write]       # one-way queryTables path -> structured query migration
```

Server tests hit a **real Postgres** through `apps/server/test/harness.ts` and skip when
`DATABASE_URL` is unset. Web tests are **pure logic only** — never DOM — because `apps/web/src/orpc.ts`
touches `window` at module scope, so anything importing it cannot be unit-tested under Bun.

## The three processes

```
Browser (React + UI5 Web Components)
   │ oRPC over /rpc, same-origin (dev: Vite proxy; prod: server serves the built SPA)
   ▼
HERA server (Bun + Hono)  ── Postgres
   │ HTTPS to the tenant's agentUrl, one named operation per endpoint
   ▼
hera-agent (Bun, on the customer's network) ── SAP B1 Service Layer /b1s/v2
```

The agent is a Windows service the customer installs. SAP credentials live in its `agent.json`
and never reach the cloud. `sapConnection.agentUrl` is `http://localhost:4000` in dev and a
Cloudflare Tunnel hostname in production — **that difference is a database row, not a branch in
the code**, which is why nothing here is conditional on "dev vs prod".

## Tenancy is the request host

`<slug>.<APP_BASE_DOMAIN>`. `tenant.ts` parses the slug (the only place the host is parsed);
`orpc/base.ts` joins it against `member` — **the membership join is the tenant boundary**, so a
forged Host can only ever select an org the user already belongs to. Four procedure builders
compose that check:

| Builder | Who |
|---|---|
| `sessionProcedure` | signed in, not yet a member (invite acceptance) |
| `userProcedure` | internal member; **one line fences the `client` role out of every internal endpoint** |
| `adminProcedure` | admin/owner — model builder, settings |
| `clientProcedure` | portal accounts only, plus their `portalClient` CardCode binding |

Dev uses `lvh.me` (not `localhost`): a `.lvh.me` cookie is shared across subdomains, a
`localhost` one is not. Prod uses Caddy wildcard subdomains → one server.

## `packages/config-engine` — the calculation core

Pure, dependency-free (zod only), and the same code runs in the browser for live preview and on
the server for the numbers that get stored. **Never trust the browser's figures**: handlers
recompute.

A `ModelDef` (one jsonb document) → `propagate` (iterate defaults/computed/visibility to a fixed
point, eliminate impossible options) → `enumerate` (DFS over open parameters, capped at 200
candidates) → `computeOutputs` (BOM, routing, cost, price). `dsl.ts` is a small hand-written
expression language; `check.ts` validates a whole model and is the gate on save, so a model that
saves cannot produce a parse/unknown-ref error at runtime.

`ResolvedLookups` is the seam: the engine never sees where options came from — manual lists,
tenant `config_table` rows and live B1 reads are all resolved to the same shape by
`apps/server/src/lookups.ts` before the engine runs.

**Every run is frozen**: `config_run` stores `modelSnapshot` + `lookupSnapshot` + `entries` +
`candidates`, so an old quote can always be re-explained. One configuration = one run (unique
index); a quoted project is locked by `assertConfigMutable`.

## `packages/b1` — the SAP connector

Ported from the vendored `b1-mcp-server/` (MIT, SAP's sample). The MCP *protocol* is deliberately
not in the data path — its write layer is elicitation-gated, has no ETag handling anywhere, and
never parses `NavigationProperty`. The *services underneath* it are what got ported.

- `query.ts` is the **only** module that builds a Service Layer URL. Everything else passes data.
- `B1Transport` is the seam: `DirectTransport` (agent → Service Layer) and `RemoteTransport`
  (cloud → agent) implement the same named methods. **Cloud call sites never see a URL.**
- There is deliberately **no `readAll`**. `readPages(t, set, q, { maxPages })` takes a *required*
  cap so an unbounded fetch can never hide behind an innocent-looking line.
- `readNext` is the one method taking a B1-supplied URL; the agent origin-checks it.
- `metadata.ts` parses EDMX with `fast-xml-parser` into plain JSON (SAP's parser builds `Map`s,
  which neither cache in jsonb nor cross the wire) and adds `ReferentialConstraint` parsing —
  that is what yields `CardCode → BusinessPartners` and makes the entity UI possible.

Deliberate fixes on port, all load-bearing: `getSetCookie()` (splitting on `,` shreds
`Expires=Wed, 09 Jun …` and loses `ROUTEID`, which a load-balanced Service Layer requires); one
in-flight login promise (N cold requests otherwise burn N B1 licence slots); `buildKeyValue`
(escapes quotes, handles composite keys); `B1Error{status, code}` instead of `Error(string)`;
Bun's `tls: { rejectUnauthorized: false }` — **Bun's `fetch` ignores undici's `dispatcher`**, so
the sample's self-signed handling is a silent no-op here.

Beas is not a second package: it is the same `ServiceLayer` with a different `basePath`/`auth`
and a different agent route prefix.

## Live queries are data, not paths

`ModelDef.queryTables[].query` is `{ entitySet, filter?, orderby?, top? }`. `$select` is **derived
from `columns`** and never stored, so the two cannot disagree. Value-help paging uses a `$skip`
offset — a cursor that can express nothing but paging, which is what the old "parse both URLs and
compare their searchParams" check was trying to guarantee.

`apps/server/src/b1.ts` is where a tenant becomes transports: `tenantConnector` → `runnerFor`
(the `QueryRunner` seam every pure module is written against and every test fakes) and
`toOrpcError` (B1 status/code → `ORPCError`, a lookup rather than a regex over a message).

`doc-history.ts` uses `$crossjoin`, not `$expand`: B1's `$filter` has no lambda operators, and the
file records the three verified 400s that prove it. The `DocEntry` equality **is** the join.

## Writing to SAP

- **ETag always.** Updates carry `If-Match`; a 412 surfaces as `CONFLICT`. There is no force path.
- **Curated-only.** `entity-profiles.ts` names ~8 entities and the exact fields on each; the rule
  is enforced in `orpc/routers/entities.ts`, not by which buttons a page draws. Everything else B1
  exposes is read-only.
- **Idempotent quote write-back.** `configDocumentCommandId()` (SHA-256 over
  `tenant|project|run|canonicalJson(selection)`, keys sorted because Postgres reorders jsonb) is
  written to `U_HERA_DedupKey` and checked before create. `config_run.b1DocEntry` covers a double
  click; the UDF covers the case where B1 created the document and the response never arrived.
  A missing UDF **refuses to run** rather than risk a double-post — see `docs/sap-b1-durable-writes.md`.
- **Document copy** (`doc-copy.ts`): target lines carry `BaseType`/`BaseEntry`/`BaseLine` — that is
  what makes B1 close the source lines instead of creating an unlinked document. The line field
  list is an allowlist; `BaseLine` is the source `LineNum`, not the array index.

## Chati — the configurator assistant

`apps/server/src/assistant/` is a durable turn engine, not a chat wrapper. Every write in
`turns.ts` is fenced on `leaseToken` matching the turn's *current* lease, so a stale owner can
never overwrite a newer one; a turn survives a disconnect and resumes by `lastEventId`
(`${turnId}:${seq}`). Streaming is an oRPC `eventIterator`; `signal` aborts on client disconnect.
`packages/assistant` holds only the genuinely shared surface — tables, wire events, the eight tool
declarations (strict zod in *and* out) — so the executors in `apps/server` stay adapter-free.
Providers (Gemini/Anthropic/OpenAI) go through `provider.ts` + `adapter.ts`.

Drawing extraction is separate and stateless: the drawing is never stored, and `extraction.ts`
re-validates every LLM suggestion against the parameter's type/domain/range server-side. Invalid
suggestions are flagged with a reason, never dropped and never auto-applied.

## Saved views (variants)

`ListVariantDef` (select/filter/orderby/search) **is** the query. `apps/web/src/listSpec.ts`
executes it locally over an array (models, configs); `apps/server/src/entity-list.ts` compiles the
identical spec to OData for B1 entities — same spec, same behaviour, two executors. `ListReport`
does no client-side processing (`manualSortBy`/`manualFilters`) so both sources match.

One rule worth knowing before editing `compileList`: a **filter** naming a missing field is an
error (dropping it would show *more* rows than asked for), a **select** or **orderby** naming one
is silently dropped (a saved view outliving a UDF should still open).

## Conventions

- **`// ponytail:` comments mark deliberate simplifications** and name the ceiling plus the upgrade
  path (`// ponytail: jsonb blob; real tables only if the dashboard needs drill-down`). Respect
  them — they are decisions, not oversights. Add one when you take a shortcut with a known limit.
- Comments explain *why*, especially when the obvious approach was tried and failed. Several
  carry verified error strings from a live B1 — do not "clean those up".
- Big configuration objects are one jsonb document loaded and saved whole (`config_model.definition`,
  `ui_variant.definition`), not modelled tables.
- Imports use explicit `.ts` extensions; `verbatimModuleSyntax` is on, so `import type` matters.
- Workspace packages must be listed as **direct** dependencies — Bun's isolated install does not
  resolve transitives here. Adding an import from a new workspace package means editing that
  `package.json` and re-running `bun install`.
- `packages/db/drizzle/` is gitignored; schema changes ship via `bun run db:push`, and new schema
  files must be re-exported from `packages/db/src/schema/index.ts`.

## Design docs

`docs/superpowers/specs/` and `docs/superpowers/plans/` hold the design record per feature, dated.
`docs/*.md` are the operator/user guides (model builder, history pane, drawing extraction, durable
writes) — update them when you change the surface they describe.

---

Note: `~/.codex/config.toml` and `~/.gemini/settings.json` exist on this machine. Reply `/import`
to scan and list what is importable (MCP servers, slash commands, subagents, skills, instructions),
then `/import --yes=<digest>` to apply the user-level items.
