# HERA B2B Client Portal — Design Spec (2026-07-07)

## Context

The configurator is live for internal users: admins build models, members run the wizard
(Configure → Batches → Candidates → Review → B1 Sales Quotation). This milestone opens a
**client portal**: a tenant's customers log in with their own accounts, configure published
products themselves, and submit **quote requests** that internal users review and turn into
real B1 quotations. External users never write to SAP.

## Decisions (settled in brainstorming)

| Axis | Decision |
|---|---|
| Terminal action | Request a quote — internal user reviews and creates the B1 quotation |
| Identity | Many portal users → one customer (B1 CardCode); users see only their company's requests |
| Onboarding | Admin invite only, bound to a CardCode at invite time; copy-link (no email provider yet) |
| Price visibility | Unit price per candidate/batch in the portal; material/labor/margin never leaves the server |
| Model access | Per-model `portal` publish flag; all clients of the tenant see the published catalog |
| Review flow | Submission is a `config_project` with status `requested` in the existing Configurations list |
| Post-submit | Client sees status (`requested → quoted/rejected`) and final line prices once quoted; no DocNum/PDF |
| Portal wizard scope | Configure + Batches + Candidates (prices only) + Submit; BOM/routing review stays internal |
| Drawing extraction | Available to clients, same validated suggestions-only path |
| Notification | In-app only (`requested` filter/badge); no email machinery in v1 |
| Lifecycle | Submitted = locked; client can withdraw; reject (with note) reopens as draft |
| Placement | Role-gated inside `apps/web` + new `clientProcedure`; no new app, no new subdomain |

## Architecture

The portal is a new audience on the existing platform, not a new system:

```
packages/db      + portal_client table; config_model.portal flag; config_project source/status/rejection_note
apps/server      + clientProcedure (base.ts); portal.ts router; userProcedure tightened; configs.reject; invites
apps/web         + /portal/* routes (client shell + 4-step wizard); admin deltas (publish switch, requests, invites)
apps/agent       unchanged
packages/config-engine  unchanged
```

The trust boundary is the oRPC procedure layer. The SPA branches on role for UX, but nothing
client-facing depends on UI gating: a client session physically cannot call internal endpoints.

## Roles & auth

- New member role: `member.role = "client"`. The role column is plain text and `userProcedure`
  already joins `member` manually — no Better Auth plugin changes. Better Auth's invitation flow
  is **not** used (its role typing fights custom roles); we insert the `member` row ourselves on
  invite acceptance.
- `clientProcedure` (`apps/server/src/orpc/base.ts`) — session + host-slug membership join (same
  as `userProcedure`) but requires `role === "client"`, then loads the `portal_client` binding →
  context: `{ tenantId, userId, cardCode, cardName }`.
- **`userProcedure` rejects `role === "client"`.** This one line makes every existing internal
  endpoint (quotes, entities, models, configs, variants, extraction) unreachable for clients.
  `adminProcedure` is unaffected (client ≠ admin/owner).
- Clients log in on the same tenant subdomain with the existing login/signup pages; cookies and
  tenancy work unchanged.

## Invitations (`portal_client` is both invite and binding)

Table `portal_client`:
`id uuid PK, tenant_id text, email text, card_code text, card_name text, user_id text (null until accepted), invite_token_hash text, invited_at, accepted_at`.
Unique on `(tenant_id, user_id)` (when set) and on `invite_token_hash`. Token hashed with the
existing `hashToken` (SHA-256, same as agent tokens); single-use; 7-day expiry (checked against
`invited_at`, no extra column).

Flow:
1. Admin (Settings → Portal clients): picks a customer via the existing BP ValueHelp
   (`entities.list`), enters the client's email → `portalClients.invite` mints a token, stores the
   hash, returns the accept URL once. Admin copies the link and sends it themselves.
   `// ponytail: copy-link invites; email provider when onboarding volume demands`
2. Client opens `https://<slug>.<baseDomain>/portal/accept?token=…`, signs up or logs in
   (existing pages, redirect back), then the page calls `portal.acceptInvite({ token })` — a
   session-only procedure (no membership yet). Server verifies token hash + host tenant +
   unexpired + unaccepted, inserts the `member` row with role `client`, stamps
   `user_id`/`accepted_at`, and the client lands in `/portal`.
- Inviting an email that already belongs to an internal member of the org is rejected at
  creation. Revoke = delete the row (pending invite) or delete row + member row (active client).

## Data model changes (`packages/db/src/schema/configurator.ts` + portal table)

- `config_model` + `portal boolean not null default false` — the publish flag (column, not
  jsonb, so lists filter on it).
- `config_project`:
  - status set grows to `draft | calculated | quoted | requested | rejected`
  - `+ source text ('internal' | 'portal') not null default 'internal'`
  - `+ rejection_note text`
  - Portal projects always carry `customer` = the client's bound CardCode, forced server-side.
- `config_run` — unchanged. Client submissions reuse `run.selection`
  (`{ candidateIdx, batchQty }[]`, no overrides). Snapshots keep **full** outputs — the internal
  reviewer sees everything; sanitization happens at the API edge, never in storage.

Status lifecycle (all transitions guarded in `UPDATE … WHERE status = …`):
`draft ⇄ requested` (submit / withdraw) · `requested → rejected` (internal, with note) ·
`rejected → draft` (client reopens) · `requested → quoted` (internal `createQuote`, terminal).

## Server (`apps/server/src/orpc/routers/`)

New `portal.ts`, all `clientProcedure`, all scoped by `tenantId` + `cardCode` + `source = 'portal'`:

- `models.list` — published models only (id, name).
- `projects.list / get / create / update / remove` — `create` requires a published model and
  forces customer from the binding; `update`/`remove` only in `draft`/`calculated` (a `rejected`
  project must be reopened first); `get` of another CardCode's project is NOT FOUND. In the
  portal UI, `calculated` displays as `draft` — it's an internal engine state, not a client one.
- `run` — same engine path as `configs.run` (server-resolved lookups via the agent bridge,
  snapshot inserted, project → `calculated`), but the response maps candidates through an explicit
  **`PortalCandidate`** shape: `{ assignment, perBatch: { batchQty, unitPrice, total }[] }`.
  BOM, routing, material/labor/margin are stripped by construction — a mapper that names the
  allowed fields, so future `Outputs` additions can't leak by default.
- `submit` — `{ projectId, selection }`: validates a run exists and selection indexes are valid,
  stores selection on the run, `draft → requested`.
- `withdraw` — `requested → draft`.
- `reopen` — `rejected → draft`.
- `extract` — drawing extraction for published models; shares the implementation helper with the
  internal `extraction.ts` (one code path, two procedures).
- `quotedResult` — for `quoted` projects: per selected line `{ assignment, batchQty, unitPrice,
  total }` from the quoted run. No DocNum, no PDF, no cost breakdown.
- `acceptInvite` — session-only procedure (see Invitations).

Internal-side additions:
- `models.save` carries the `portal` flag.
- `configs.reject` — `requested → rejected` + note (userProcedure; internal by tightening).
- `configs.list` surfaces `requested` via the existing status field.
- `portalClients.invite / list / revoke` — adminProcedure.
- No SSE for the portal list. `// ponytail: TanStack Query refetch; SSE if someone stares at the page`

## Web (`apps/web/src/routes/_authed/`)

Role branch in the `_authed` layout: role `client` → slim portal shell (product name +
"My Requests"; no SideNavigation) and only `/portal/*` routes. Clients hitting internal routes
redirect to `/portal`; internal users hitting `/portal` redirect to `/`.

- `portal/index` — requests list: name, model, status as `ObjectStatus`
  (`draft / requested / quoted / rejected`), updated at. "New request" → published-model picker →
  creates a draft.
- `portal/$id` — 4-step wizard reusing existing components:
  1. **Configure** — same `ConfiguratorForm`, live propagation, drawing upload + extraction
     suggestions (calls `portal.extract`).
  2. **Batches** — same tokens/StepInput.
  3. **Candidates** — same matrix (cells = unit price, per-column best highlighted); detail panel
     shows the price-vs-batch chart only — no cost breakdown, no BOM/routing tabs.
  4. **Submit** — summary + submit; then read-only with Withdraw.
  `quoted` → read-only result with final line prices. `rejected` → note + "Reopen as draft".
- `portal/accept` — invite landing: token check, auth redirect, `acceptInvite`, then `/portal`.

Internal deltas:
- Model builder header: "Available in portal" switch.
- Configurations list: status filter includes `requested`; badge count on the nav item.
- Wizard on a `requested` project: banner "Requested by <client user> for <customer>" +
  Reject-with-note action. Reviewer can re-run, adjust, and `createQuote` as today.
- Settings: "Portal clients" panel — invite dialog (BP picker + email → copy-link once), table of
  invites/active clients with revoke.

## Error handling

- Model unpublished mid-draft → portal `run`/`submit` fail with "This product is no longer
  available — contact your supplier."
- Invite token expired/used/unknown → explicit error on the accept page.
- Withdraw racing `createQuote` → status guard makes one of them fail cleanly; no double state.
- Agent offline during a portal run → existing `assertAgentReady` message shape.
- Portal wording never names internal concepts; constraint messages come from the model (written
  by the admin for humans) and pass through as-is.

## Testing / verification

Server integration tests (the ones that matter):
1. **Tightening**: a `client`-role session gets FORBIDDEN on every `userProcedure` router
   (spot-check quotes/configs/models/extraction).
2. **Sanitization**: `portal.run` response JSON contains no `bomLines`, `ops`, `materialCost`,
   `laborCost`, or `unitCost` keys anywhere — only `batchQty`, `unitPrice`, `total` per batch.
3. **Transitions**: submit/withdraw/reject/reopen guards, incl. withdraw-vs-quote race.
4. **Invites**: accept happy path; expired, reused, wrong-tenant token; already-internal email.
5. **Scoping**: client of CardCode A cannot `get`/`update` a project of CardCode B; portal list
   never returns `source='internal'` projects.

Engine untouched → no engine test changes. Manual e2e: invite → accept → configure with
extraction → submit → internal reject → reopen → resubmit → quote in the B1 sandbox → client
sees final prices.

## Out of scope (v1)

Email delivery (invites and notifications), per-customer model assignment, portal branding/
white-label, quote PDF or DocNum exposure, client-side price preview before run, SSE status push
to the portal, withdraw after quoting (terminal), multiple CardCodes per user.

## Implementation phases

1. **Auth + invites** — `portal_client` table + migration, `clientProcedure`, `userProcedure`
   tightening, `acceptInvite`, `portalClients` admin router. (Tests 1, 4.)
2. **Portal API** — schema deltas (`portal` flag, statuses, source, note), `portal.ts` router
   with sanitized run + transitions, `configs.reject`. (Tests 2, 3, 5.)
3. **Portal UI** — role branch + shell, requests list, 4-step wizard, accept page.
4. **Internal UI deltas** — publish switch, requested filter/badge + reject action, Portal
   clients settings panel.
