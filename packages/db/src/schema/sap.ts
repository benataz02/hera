import { boolean, jsonb, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";
import type { B1EntitySchema } from "@hera/b1";

// One row per tenant: where that tenant's on-prem agent is and how to authenticate to it.
// No company column — the agent owns its company DB, so a tenant points at one agent URL.
// agentUrl is http://localhost:4000 in dev and the Cloudflare Tunnel hostname in production;
// that difference is this row, not a branch in the code.
export const sapConnection = pgTable("sap_connection", {
  tenantId: text("tenant_id").primaryKey(),
  agentUrl: text("agent_url").notNull(),
  /** Bearer secret the agent checks. Encrypted at rest (see apps/server/src/crypto.ts). */
  secret: text("secret").notNull(),
  /** Cloudflare Access service token — null in dev, where there is no edge in front of the agent. */
  accessClientId: text("access_client_id"),
  accessClientSecret: text("access_client_secret"),
  beasEnabled: boolean("beas_enabled").notNull().default(false),
  status: text("status", { enum: ["ok", "error"] }).notNull().default("ok"),
  lastOkAt: timestamp("last_ok_at", { withTimezone: true }),
  lastError: text("last_error"),
});

export type SapConnection = typeof sapConnection.$inferSelect;

// Parsed B1 entity schemas, cached per tenant. B1's own $metadata is the source of truth; this is
// a TTL cache with a manual Refresh action behind it.
// ponytail: TTL + manual refresh; no push-invalidation until a stale-UDF bug actually appears.
export const entityMeta = pgTable(
  "entity_meta",
  {
    tenantId: text("tenant_id").notNull(),
    entityName: text("entity_name").notNull(),
    json: jsonb("json").$type<B1EntitySchema>().notNull(),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.entityName] })],
);

export type B1NavPin = { name: string; label: string };

// Per admin, per tenant: which entity sets show as sibling items under the SAP sidenav group.
// ponytail: jsonb array; a join table only if pins need per-row metadata.
export const b1NavPin = pgTable(
  "b1_nav_pin",
  {
    tenantId: text("tenant_id").notNull(),
    userId: text("user_id").notNull(),
    entities: jsonb("entities").$type<B1NavPin[]>().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.userId] })],
);
