import { pgTable, text, timestamp, jsonb } from "drizzle-orm/pg-core";
import type { EnabledEntity } from "./entity.ts";

/** Agent-reported create prerequisites (entity + dedup UDF). Index uniqueness is operator-asserted. */
export type WriteCapability = { entity: string; dedupField: string };

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
  // Create capabilities last reported by the on-prem agent (validated against EDMX there).
  writeCapabilities: jsonb("write_capabilities").$type<WriteCapability[] | null>(),
  writeCapabilitiesCheckedAt: timestamp("write_capabilities_checked_at", { withTimezone: true }),
  // Maps a HERA user id to a B1 SalesEmployeeCode so the dashboard can scope to "my numbers".
  // ponytail: jsonb map like enabledEntities — tens of entries, read once per request.
  //           A real table only if this ever needs to be queried BY rep code.
  salesReps: jsonb("sales_reps").$type<Record<string, number>>().notNull().default({}),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
