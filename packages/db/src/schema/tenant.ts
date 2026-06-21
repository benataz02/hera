import { pgTable, text, timestamp, jsonb } from "drizzle-orm/pg-core";

// Autodiscovered B1 entity, trimmed to what list/forms need.
export type EntityProperty = { name: string; type: string; nullable: boolean };
export type EntitySchema = { name: string; keys: string[]; properties: EntityProperty[] };
// What an admin enabled for the tenant: a schema + whether it's create/edit (vs read-only).
export type EnabledEntity = EntitySchema & { editable: boolean };

// Per-tenant integration config. tenant_id == Better Auth organization id.
// B1 credentials are NOT here — the on-prem agent holds them locally (see .env.example).
// ponytail: cloud stores no SAP secret; only the agent's bearer-token hash + heartbeat.
//           If central credential management is needed later, add an encrypted-password
//           column + AES-256-GCM (key from env) and have the agent fetch creds on connect.
export const tenantIntegration = pgTable("tenant_integration", {
  tenantId: text("tenant_id").primaryKey(),
  agentTokenHash: text("agent_token_hash").notNull(),
  b1BaseUrl: text("b1_base_url"),
  companyDb: text("company_db"),
  // Entities the admin chose to expose, with their discovered schema. Drives the side-nav,
  // the read/write gate, and form rendering — no agent round-trip needed to read it.
  enabledEntities: jsonb("enabled_entities").$type<EnabledEntity[]>().notNull().default([]),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
