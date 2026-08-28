# SAP B1 durable writes — operator runbook

Quotation write-back is idempotent through a **dedup UDF** on the company database. HERA writes a
deterministic key into it on create and looks the key up before creating, so a retried request —
or a request whose response never came back — finds the document it already posted instead of
posting a second one.

HERA's cloud and the Service Layer **cannot** inspect index uniqueness. The unique index is an
operator assertion, re-verified after every upgrade.

## Prerequisite: one UDF per document table you write to

| Entity set | SAP table | UDF | Unique index |
| --- | --- | --- | --- |
| `Quotations` | OQUT | `U_HERA_DedupKey` — alphanumeric, length 64 | Unique on `U_HERA_DedupKey` |

The UDF name is `DEDUP_UDF` in `apps/server/src/config-quote.ts`. Only Quotations needs it today:
that is the one entity HERA creates on its own initiative. Curated create/copy
(`entities.create`, `entities.copy`) are user-initiated from a page and are not retried on the
user's behalf, so they do not carry a dedup key.

Without the UDF, quote write-back **refuses to run** and says so:

> Cannot check for an existing quotation: `U_HERA_DedupKey` is missing from Sales Quotation in
> SAP. Create it (alphanumeric, length 64) and try again.

That is deliberate. Falling back to "create anyway" would trade a clear setup error for a silent
double-post.

## How the key is derived

`configDocumentCommandId()` — SHA-256 over `tenant | project | run | canonicalJson(selection)`.
Same picks, retried, yield the same key; a changed selection yields a new one. Object keys are
sorted before hashing because Postgres reorders `jsonb` on the way back out.

Two layers guard the write, and they cover different failures:

| Failure | Caught by |
| --- | --- |
| The user clicks twice; the response arrived | `config_run.b1_doc_entry` — HERA already knows the DocEntry |
| We POSTed, B1 created it, our response never arrived | the dedup UDF lookup, on the next attempt |

Only the second one needs SAP's help, which is why the UDF exists.

## Duplicate-key smoke check (test company only)

In a **designated test company DB** (never production first):

1. Create a quotation through HERA and note the `U_HERA_DedupKey` value.
2. Attempt a second POST with the **same** dedup value, through the Service Layer directly.
3. Expect a unique-constraint failure from B1 — not a second document.
4. Confirm `GET Quotations?$filter=U_HERA_DedupKey eq '<key>'` returns exactly one document.

If step 3 inserts a second row, the unique index is missing or wrong. HERA's check-then-create
still prevents the common case, but the index is what makes it airtight under a genuine race.

## Post-upgrade re-verification (mandatory)

After any SAP B1 upgrade, company restore, or UDF/index change:

1. Confirm the UDF still exists on OQUT.
2. Confirm the unique index still exists and is unique (DBA / HANA or SQL tooling — **not**
   Service Layer).
3. Re-run the duplicate-key smoke check in the test company.
4. Run `bun --env-file=.env scripts/e2e.ts <slug>` to confirm the agent still reaches B1.

## Concurrent edits (curated update)

Updates go out with `If-Match` set to the `@odata.etag` read back with the row. A row changed by
someone else in the meantime comes back as a 412, which HERA surfaces as a conflict:

> The SAP document changed since it was read.

There is no "force" path. Re-open the row and redo the edit — that is the only safe answer, and it
is the single clearest reason the B1 MCP server's write layer is not in this path: it has no ETag
handling anywhere, so its updates are last-write-wins.

## Explicit limitation

**Service Layer cannot inspect index uniqueness.** HERA only checks that a filter on the UDF is
accepted. Unique-index provisioning and verification remain an operator checklist item; the UI
must not claim otherwise.
