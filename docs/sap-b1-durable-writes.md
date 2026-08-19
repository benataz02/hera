# SAP B1 durable writes — operator runbook

Create for document entities requires a **unique** dedup UDF on the company database.
HERA’s cloud and Service Layer **cannot** inspect index uniqueness. Enabling create is an
operator assertion that the UDF and unique index exist and were re-verified after upgrades.

## Prerequisites per document table

For each Service Layer entity set you enable for create, provision on the matching header
table:

| Entity set (example) | SAP table (example) | UDF | Unique index |
| --- | --- | --- | --- |
| `Quotations` | OQUT | `U_HERA_DedupKey` (string) | Unique on `U_HERA_DedupKey` |
| `Orders` | ORDR | `U_HERA_DedupKey` (string) | Unique on `U_HERA_DedupKey` |
| Other sales/purchase documents with a HERA create profile | Matching `O*` header | Same UDF name as the profile (`U_HERA_DedupKey`) | Unique on that UDF |

Use the same UDF name the entity profile expects (`create.dedupField`). Do not enable create
in the agent config until the unique index is in place on that company DB.

## Agent configuration

On the on-prem agent (`.env` or WinSW `hera-agent-service.xml`):

```text
B1_CREATE_CAPABILITIES=Quotations:U_HERA_DedupKey,Orders:U_HERA_DedupKey
```

Syntax: comma-separated `EntitySet:UdfName` pairs. Malformed pairs are ignored. At startup
and after each metadata refresh the agent:

1. Parses the env value.
2. Confirms each entity and UDF exist in Service Layer `$metadata`.
3. Reports **only valid** pairs via authenticated `sync.heartbeat`.
4. Logs rejected pairs (missing entity, missing UDF, duplicates).

On **each successful pull**, the agent re-sends that last validated list (no EDMX hop) so
`write_capabilities_checked_at` stays within the ~90s freshness window while the agent is
actively pulling. A one-shot startup report alone would self-disable create after ~90s.

The cloud stores the report in `tenant_integration.write_capabilities` and
`write_capabilities_checked_at`. `entities.capabilities` exposes create/edit gates; a stale
or offline report **disables create** but **does not** disable display or safe updates.

## Cloud DB columns (operator SQL)

`packages/db/drizzle/` is local/gitignored. Apply these nullable columns on
`tenant_integration` if missing (idempotent check recommended before run):

```sql
ALTER TABLE "tenant_integration" ADD COLUMN IF NOT EXISTS "write_capabilities" jsonb;
ALTER TABLE "tenant_integration" ADD COLUMN IF NOT EXISTS "write_capabilities_checked_at" timestamptz;
```

Or generate/apply via the usual Drizzle migrate path when you have a local
`packages/db/drizzle/*write-capabilities*.sql` (same two `ALTER TABLE` statements
without `IF NOT EXISTS`). Do **not** recreate `tenant_integration`.

## Duplicate-key smoke check (test company only)

In a **designated test company DB** (never production first):

1. Create a document through HERA (or Service Layer) with a known `U_HERA_DedupKey` value.
2. Attempt a second POST with the **same** dedup value.
3. Expect a unique-constraint / conflict failure from B1 — not a second document.
4. Confirm GET-by-UDF returns the first document only.

If step 3 inserts a second row, the unique index is missing or wrong — fix before enabling
create for that entity in any real company.

## Post-upgrade re-verification (mandatory)

After any SAP B1 upgrade, company restore, or UDF/index change:

1. Confirm the UDF still exists on each enabled header table.
2. Confirm the unique index still exists and is unique (DBA / HANA or SQL tooling — **not**
   Service Layer).
3. Restart the agent so it re-validates EDMX and re-heartbeats.
4. Confirm `entities.capabilities` shows `canCreate: true` for each intended entity.
5. Re-run the duplicate-key smoke check in the test company.

## Explicit limitation

**Service Layer cannot inspect index uniqueness.** HERA only checks that the UDF appears in
`$metadata`. Unique-index provisioning and verification remain an operator checklist item;
the UI must not claim otherwise.
