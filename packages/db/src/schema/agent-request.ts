import {
  pgTable, pgEnum, uuid, text, integer, jsonb, timestamp, uniqueIndex, index,
} from "drizzle-orm/pg-core";

export const agentRequestStatus = pgEnum("agent_request_status", [
  "pending", "in_flight", "done", "failed",
]);

// The single on-prem <-> cloud queue (replaces the old `outbox`). Two row shapes share it,
// distinguished by `kind`:
//   - 'quote'                  durable, deduplicated WRITE — the backbone proof. dedup_key set;
//                              attempts/lease drive the agent's GET-before-POST; agent acks/nacks.
//   - 'metadata'|'list'|'get'  on-demand request/reply (reads). dedup_key null; the browser parks
//   |'create'|'update'         on requestChannel(id) for `result`; agent fulfills/fails.
// dedup_key is nullable: Postgres treats NULLs as distinct in a unique index, so the same
// (tenant_id, dedup_key) uniqueness that makes a re-enqueued write a no-op leaves reads unconstrained.
export const agentRequest = pgTable(
  "agent_request",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: text("tenant_id").notNull(),
    kind: text("kind").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    dedupKey: text("dedup_key"),
    status: agentRequestStatus("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    leaseUntil: timestamp("lease_until", { withTimezone: true }),
    result: jsonb("result").$type<unknown>(), // response payload for request/reply kinds
    docEntry: text("doc_entry"), // B1 key (CardCode here; String(DocEntry) for documents)
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("agent_request_tenant_dedup_uq").on(t.tenantId, t.dedupKey),
    index("agent_request_claim_idx").on(t.tenantId, t.status, t.leaseUntil),
  ],
);
